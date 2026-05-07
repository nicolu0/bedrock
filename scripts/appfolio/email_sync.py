"""
AppFolio Email Communication Scraper

Scrapes email threads from AppFolio work order pages and stores them
in Supabase threads/messages tables. Uses the same cookie-based auth
as the SMS scraper.

Usage:
    python email_sync.py --login          # Interactive login, save session cookie
    python email_sync.py --dry-run        # Show what would be synced, no DB writes
    python email_sync.py --preview 3      # Preview emails for first 3 issues
    python email_sync.py --discover-uids  # Debug: show short_uid for first issue
    python email_sync.py                  # Run sync
"""

import argparse
import asyncio
import html
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from supabase import create_client

from session import SessionManager, APPFOLIO_VHOST, SUPABASE_URL, SUPABASE_SERVICE_KEY

SYNC_DELAY = 1.5  # seconds between work orders (more endpoints hit than SMS)
UID_CACHE_PATH = Path.home() / ".appfolio_email_uid_cache.json"

# US/Pacific timezone offset (used for timestamp parsing)
PACIFIC = timezone(timedelta(hours=-7))  # PDT; adjust to -8 for PST if needed


# ── Data Structures ──────────────────────────────────────────────────────────

@dataclass
class EmailTarget:
    appfolio_id: str                  # Work order ID (e.g., "7596")
    service_request_number: str       # Service request number (e.g., "7576")
    issue_id: str                     # Bedrock issue UUID
    workspace_id: str
    tenant_id: str | None = None
    appfolio_vendor_id: str | None = None
    short_uid: str | None = None      # Discovered from work order page


@dataclass
class ParsedEmail:
    email_id: str           # e.g., "772639505"
    status: str             # e.g., "Opened", "Delivered"
    sent_at: str            # raw string, e.g., "04/13/2026 01:23 PM"
    to: str                 # email addresses
    from_name: str          # sender name
    subject: str
    href: str               # e.g., "/emails/772639505"


# ── UID Cache ────────────────────────────────────────────────────────────────

def load_uid_cache() -> dict[str, str]:
    if UID_CACHE_PATH.exists():
        try:
            return json.loads(UID_CACHE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_uid_cache(cache: dict[str, str]):
    UID_CACHE_PATH.write_text(json.dumps(cache, indent=2))


# ── Timestamp Parsing ────────────────────────────────────────────────────────

def parse_appfolio_timestamp(raw: str) -> str | None:
    """Parse '04/13/2026 01:23 PM' into ISO 8601 timestamp (Pacific time)."""
    try:
        dt = datetime.strptime(raw.strip(), "%m/%d/%Y %I:%M %p")
        dt = dt.replace(tzinfo=PACIFIC)
        return dt.isoformat()
    except ValueError:
        return None


# ── HTML Body Parsing ────────────────────────────────────────────────────────

def parse_email_html(raw_html: str) -> str:
    """Extract plain text body from AppFolio show_email_message HTML."""
    soup = BeautifulSoup(raw_html, "html.parser")
    span = soup.find("span")
    if not span:
        # Fallback: try the whole body
        span = soup.find("body") or soup
    # Remove script tags
    for script in span.find_all("script"):
        script.decompose()
    # Replace <br> with newlines
    for br in span.find_all("br"):
        br.replace_with("\n")
    return span.get_text(strip=False).strip()


# ── AppFolio Email Client ────────────────────────────────────────────────────

class AppFolioEmailClient:
    def __init__(self, vhost: str, cookie_header: str):
        self.vhost = vhost
        self.client = httpx.AsyncClient(
            headers={
                "Cookie": cookie_header,
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/142.0.0.0 Safari/537.36",
            },
            timeout=30.0,
        )

    async def discover_short_uid(self, service_request_number: str, appfolio_id: str) -> str | None:
        """Fetch work order page and extract the short_uid from the emails block."""
        url = f"https://{self.vhost}/maintenance/service_requests/{service_request_number}/work_orders/{appfolio_id}"
        try:
            resp = await self.client.get(url, headers={"Accept": "text/html"})
            if resp.status_code != 200:
                print(f"  Work order page HTTP {resp.status_code} for WO {appfolio_id}")
                return None
            # Search for short_uids%5B%5D=<digits> in the page HTML
            match = re.search(r'short_uids%5B%5D=(\d+)', resp.text)
            if match:
                return match.group(1)
            print(f"  No short_uid found in page for WO {appfolio_id}")
            return None
        except Exception as e:
            print(f"  Error fetching work order page for WO {appfolio_id}: {e}")
            return None

    async def fetch_email_list(self, short_uid: str) -> list[ParsedEmail]:
        """Fetch all emails for a work order via the short_uid."""
        all_emails: list[ParsedEmail] = []
        page = 1

        while True:
            url = (
                f"https://{self.vhost}/emails"
                f"?items_per_page=50&omit_bodies=true"
                f"&short_uids%5B%5D={short_uid}"
                f"&page={page}"
            )
            try:
                resp = await self.client.get(url, headers={
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                })
                if resp.status_code != 200:
                    print(f"  Email list HTTP {resp.status_code} for uid {short_uid}")
                    break
                data = resp.json()
            except Exception as e:
                print(f"  Error fetching email list for uid {short_uid}: {e}")
                break

            rows = data.get("body_row_data", [])
            if not rows:
                break

            for row in rows:
                cells = row.get("data", [])
                if len(cells) < 5:
                    continue
                # Extract email ID from row_data_attributes href
                attrs = row.get("row_data_attributes", [])
                href = None
                for attr in attrs:
                    if attr.get("key") == "href":
                        href = attr.get("value")
                        break
                if not href:
                    continue

                # Email ID is the last segment of the href path
                email_id = href.rstrip("/").split("/")[-1]

                # Strip HTML from status cell
                status_html = cells[0].get("value", "")
                status_soup = BeautifulSoup(status_html, "html.parser")
                status = status_soup.get_text(strip=True)

                # Column order: status, date, to, from, subject
                subject_html = cells[4].get("value", "")
                subject_soup = BeautifulSoup(subject_html, "html.parser")

                all_emails.append(ParsedEmail(
                    email_id=email_id,
                    status=status,
                    sent_at=cells[1].get("value", ""),
                    to=cells[2].get("value", ""),
                    from_name=cells[3].get("value", ""),
                    subject=subject_soup.get_text(strip=True),
                    href=href,
                ))

            # Check for more pages via pagination HTML
            pagination = data.get("pagination", "")
            if f"page={page + 1}" not in pagination:
                break
            page += 1

        return all_emails

    async def fetch_email_body(self, email_id: str) -> str | None:
        """Fetch the body of a specific email."""
        url = f"https://{self.vhost}/emails/{email_id}/show_email_message"
        try:
            resp = await self.client.get(url, headers={"Accept": "text/html"})
            if resp.status_code != 200:
                print(f"  Email body HTTP {resp.status_code} for email {email_id}")
                return None
            return parse_email_html(resp.text)
        except Exception as e:
            print(f"  Error fetching email body for {email_id}: {e}")
            return None

    async def close(self):
        await self.client.aclose()


# ── Sync Engine ──────────────────────────────────────────────────────────────

class EmailSyncEngine:
    def __init__(self, supabase_client, dry_run: bool = False):
        self.sb = supabase_client
        self.dry_run = dry_run
        # Caches for participant resolution
        self._tenant_cache: dict[str, dict] = {}  # issue_id -> tenant info
        self._vendor_cache: dict[str, dict] = {}  # appfolio_vendor_id -> vendor info

    def discover_targets(self) -> list[EmailTarget]:
        """Find all active AppFolio issues that have both appfolio_id and service_request_number."""
        resp = (
            self.sb.table("issues")
            .select("id, workspace_id, appfolio_id, service_request_number, tenant_id, appfolio_vendor_id")
            .eq("source", "appfolio")
            .neq("status", "done")
            .not_.is_("appfolio_id", "null")
            .not_.is_("service_request_number", "null")
            .execute()
        )
        targets = []
        for issue in resp.data or []:
            targets.append(EmailTarget(
                appfolio_id=issue["appfolio_id"],
                service_request_number=issue["service_request_number"],
                issue_id=issue["id"],
                workspace_id=issue["workspace_id"],
                tenant_id=issue.get("tenant_id"),
                appfolio_vendor_id=issue.get("appfolio_vendor_id"),
            ))
        return targets

    def _get_tenant_info(self, target: EmailTarget) -> dict | None:
        """Get tenant name and email for an issue."""
        if target.issue_id in self._tenant_cache:
            return self._tenant_cache[target.issue_id]
        if not target.tenant_id:
            self._tenant_cache[target.issue_id] = None
            return None
        resp = (
            self.sb.table("tenants")
            .select("name, email")
            .eq("id", target.tenant_id)
            .limit(1)
            .execute()
        )
        info = resp.data[0] if resp.data else None
        self._tenant_cache[target.issue_id] = info
        return info

    def _get_vendor_info(self, target: EmailTarget) -> dict | None:
        """Get vendor name and email for an issue."""
        if not target.appfolio_vendor_id:
            return None
        if target.appfolio_vendor_id in self._vendor_cache:
            return self._vendor_cache[target.appfolio_vendor_id]
        resp = (
            self.sb.table("vendors")
            .select("name, email")
            .eq("appfolio_vendor_id", target.appfolio_vendor_id)
            .limit(1)
            .execute()
        )
        info = resp.data[0] if resp.data else None
        self._vendor_cache[target.appfolio_vendor_id] = info
        return info

    def resolve_participant(
        self, email: ParsedEmail, target: EmailTarget
    ) -> tuple[str, str, str, str]:
        """Determine (sender, direction, participant_type, participant_name) for an email.

        Returns:
            (sender, direction, participant_type, participant_name)
        """
        tenant = self._get_tenant_info(target)
        vendor = self._get_vendor_info(target)

        from_name_lower = (email.from_name or "").strip().lower()
        to_lower = (email.to or "").lower()

        # Check if sender is a tenant
        if tenant:
            tenant_name = (tenant.get("name") or "").strip()
            tenant_email = (tenant.get("email") or "").strip().lower()
            if tenant_name and from_name_lower == tenant_name.lower():
                return ("tenant", "inbound", "tenant", tenant_name)
            if tenant_email and tenant_email in to_lower:
                # Email sent TO the tenant = outbound from manager
                return ("manager", "outbound", "tenant", tenant_name or "Tenant")

        # Check if sender is a vendor
        if vendor:
            vendor_name = (vendor.get("name") or "").strip()
            vendor_email = (vendor.get("email") or "").strip().lower()
            if vendor_name and from_name_lower == vendor_name.lower():
                return ("vendor", "inbound", "vendor", vendor_name)
            if vendor_email and vendor_email in to_lower:
                return ("manager", "outbound", "vendor", vendor_name or "Vendor")

        # Check if "To" contains known tenant/vendor emails for outbound detection
        if tenant:
            tenant_email = (tenant.get("email") or "").strip().lower()
            if tenant_email and tenant_email in to_lower:
                return ("manager", "outbound", "tenant", tenant.get("name") or "Tenant")
        if vendor:
            vendor_email = (vendor.get("email") or "").strip().lower()
            if vendor_email and vendor_email in to_lower:
                return ("manager", "outbound", "vendor", vendor.get("name") or "Vendor")

        # Heuristic: if "From" matches common manager names, it's outbound
        # Otherwise default to unknown inbound
        return ("unknown", "inbound", "unknown", email.from_name or "Unknown")

    def ensure_thread(self, target: EmailTarget, participant_type: str, participant_name: str) -> str | None:
        """Upsert a thread for email communication on this issue. Returns thread ID."""
        external_id = f"af_email:{participant_type}:{target.issue_id}"

        existing = (
            self.sb.table("threads")
            .select("id")
            .eq("external_id", external_id)
            .limit(1)
            .execute()
        )
        if existing.data and len(existing.data) > 0:
            return existing.data[0]["id"]

        if self.dry_run:
            return None

        insert_data = {
            "workspace_id": target.workspace_id,
            "issue_id": target.issue_id,
            "external_id": external_id,
            "participant_type": participant_type,
            "name": participant_name,
        }
        if target.tenant_id and participant_type == "tenant":
            insert_data["tenant_id"] = target.tenant_id

        resp = self.sb.table("threads").insert(insert_data).execute()
        if resp.data:
            return resp.data[0]["id"]
        return None

    def insert_messages(
        self,
        thread_id: str,
        issue_id: str,
        workspace_id: str,
        participant_type: str,
        participant_name: str,
        emails: list[tuple[ParsedEmail, str]],  # (parsed_email, body_text)
        known_external_ids: set[str],
    ) -> int:
        """Insert new email messages, return count inserted."""
        new_messages = []
        for email, body in emails:
            ext_id = f"af_email_{email.email_id}"
            if ext_id in known_external_ids:
                continue

            sender, direction, _, _ = self.resolve_participant(email, EmailTarget(
                appfolio_id="", service_request_number="", issue_id=issue_id,
                workspace_id=workspace_id, tenant_id=None, appfolio_vendor_id=None,
            ))
            # Re-resolve with the actual target is already done in sync_work_order;
            # here we use the pre-resolved values passed via participant_type/name

            if direction == "outbound":
                sender = "manager"
            elif participant_type == "tenant":
                sender = "tenant"
            elif participant_type == "vendor":
                sender = "vendor"
            else:
                sender = "unknown"

            timestamp = parse_appfolio_timestamp(email.sent_at)

            metadata = {"participant_type": participant_type}
            if direction == "inbound":
                metadata["sender_name"] = participant_name
            else:
                metadata["sender_name"] = email.from_name or "LAPM"
            metadata["email_status"] = email.status

            new_messages.append({
                "thread_id": thread_id,
                "issue_id": issue_id,
                "workspace_id": workspace_id,
                "external_id": ext_id,
                "message": body,
                "sender": sender,
                "subject": email.subject,
                "timestamp": timestamp,
                "channel": "appfolio_email",
                "direction": direction,
                "metadata": metadata,
            })

        if not new_messages:
            return 0

        if self.dry_run:
            return len(new_messages)

        # Insert oldest-first for resumability
        new_messages.sort(key=lambda m: m["timestamp"] or "")

        # Batch in chunks of 100
        inserted = 0
        for i in range(0, len(new_messages), 100):
            chunk = new_messages[i:i + 100]
            resp = (
                self.sb.table("messages")
                .upsert(chunk, on_conflict="external_id")
                .execute()
            )
            inserted += len(resp.data or [])

        return inserted

    async def sync_work_order(
        self, target: EmailTarget, client: AppFolioEmailClient, uid_cache: dict[str, str]
    ) -> int:
        """Sync emails for a single work order. Returns count of new messages."""
        # Discover short_uid (from cache or work order page)
        if target.appfolio_id in uid_cache:
            target.short_uid = uid_cache[target.appfolio_id]
        else:
            target.short_uid = await client.discover_short_uid(
                target.service_request_number, target.appfolio_id
            )
            if target.short_uid:
                uid_cache[target.appfolio_id] = target.short_uid
                save_uid_cache(uid_cache)

        if not target.short_uid:
            print(f"  Could not discover short_uid — skipping")
            return 0

        # Fetch email list
        emails = await client.fetch_email_list(target.short_uid)
        if not emails:
            return 0

        print(f"  Found {len(emails)} emails")

        # Get known external IDs for dedup
        known_ids: set[str] = set()
        if not self.dry_run:
            known_resp = (
                self.sb.table("messages")
                .select("external_id")
                .eq("issue_id", target.issue_id)
                .eq("channel", "appfolio_email")
                .execute()
            )
            known_ids = {m["external_id"] for m in (known_resp.data or [])}

        # Filter to only new emails
        new_emails = [e for e in emails if f"af_email_{e.email_id}" not in known_ids]
        if not new_emails and not self.dry_run:
            return 0

        # Fetch bodies only for new emails
        emails_with_bodies: list[tuple[ParsedEmail, str]] = []
        for email in new_emails:
            if self.dry_run:
                emails_with_bodies.append((email, "(dry run - body not fetched)"))
            else:
                body = await client.fetch_email_body(email.email_id)
                emails_with_bodies.append((email, body or "(no body)"))
                await asyncio.sleep(0.5)  # Rate limit between body fetches

        # Group by participant type
        groups: dict[str, list[tuple[ParsedEmail, str]]] = {}
        for email, body in emails_with_bodies:
            _, _, ptype, pname = self.resolve_participant(email, target)
            key = f"{ptype}:{pname}"
            if key not in groups:
                groups[key] = []
            groups[key].append((email, body))

        total_inserted = 0
        for key, group_emails in groups.items():
            ptype, pname = key.split(":", 1)
            thread_id = self.ensure_thread(target, ptype, pname)

            if self.dry_run:
                print(f"    {ptype} ({pname}): {len(group_emails)} emails")
                total_inserted += len(group_emails)
                continue

            if not thread_id:
                continue

            count = self.insert_messages(
                thread_id=thread_id,
                issue_id=target.issue_id,
                workspace_id=target.workspace_id,
                participant_type=ptype,
                participant_name=pname,
                emails=group_emails,
                known_external_ids=known_ids,
            )
            total_inserted += count

        return total_inserted


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="AppFolio Email Sync")
    parser.add_argument("--login", action="store_true", help="Interactive login to get session cookie")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be synced without writing to DB")
    parser.add_argument("--preview", type=int, default=0, help="Preview N issues' emails then stop")
    parser.add_argument("--discover-uids", action="store_true", help="Debug: show short_uid for first issue")
    args = parser.parse_args()

    session_mgr = SessionManager(APPFOLIO_VHOST)

    if args.login:
        await session_mgr.login_interactive()
        print(f"\nCookie saved. You can now run: python {sys.argv[0]}")
        return

    # Get valid cookies
    cookie = await session_mgr.get_valid_cookies()

    # Init clients
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    email_client = AppFolioEmailClient(APPFOLIO_VHOST, cookie)
    engine = EmailSyncEngine(sb, dry_run=args.dry_run)

    try:
        # Discover targets
        targets = engine.discover_targets()
        print(f"Found {len(targets)} active AppFolio issues with service_request_number")

        if not targets:
            print("No eligible issues. Make sure service_request_number is populated.")
            return

        # Load UID cache
        uid_cache = load_uid_cache()

        # --discover-uids: just show short_uid for first issue
        if args.discover_uids:
            target = targets[0]
            print(f"\nDiscovering short_uid for WO {target.appfolio_id} "
                  f"(SR #{target.service_request_number})...")
            uid = await email_client.discover_short_uid(
                target.service_request_number, target.appfolio_id
            )
            if uid:
                print(f"  short_uid: {uid}")
                # Also try fetching email list
                emails = await email_client.fetch_email_list(uid)
                print(f"  Found {len(emails)} emails:")
                for e in emails[:5]:
                    print(f"    [{e.sent_at}] {e.from_name} → {e.to}")
                    print(f"      Subject: {e.subject}")
                    print(f"      Status: {e.status}, ID: {e.email_id}")
            else:
                print("  Could not find short_uid!")
            return

        total_messages = 0
        preview_count = args.preview

        for i, target in enumerate(targets, 1):
            print(f"\n[{i}/{len(targets)}] WO {target.appfolio_id} "
                  f"(SR #{target.service_request_number}) — issue {target.issue_id[:8]}...")

            if args.preview:
                preview_count -= 1
                # Discover UID and show emails
                uid = uid_cache.get(target.appfolio_id)
                if not uid:
                    uid = await email_client.discover_short_uid(
                        target.service_request_number, target.appfolio_id
                    )
                if not uid:
                    print("  Could not discover short_uid")
                    if preview_count <= 0:
                        break
                    await asyncio.sleep(SYNC_DELAY)
                    continue

                emails = await email_client.fetch_email_list(uid)
                print(f"  {len(emails)} emails:")
                for e in emails[:5]:
                    print(f"    [{e.sent_at}] {e.from_name} → {e.to}")
                    print(f"      Subject: {e.subject}")
                    # Fetch and show body preview
                    body = await email_client.fetch_email_body(e.email_id)
                    preview = (body or "")[:200].replace("\n", " ")
                    print(f"      Body: {preview}")
                    await asyncio.sleep(0.5)

                if preview_count <= 0:
                    print(f"\n--preview limit reached.")
                    break
                await asyncio.sleep(SYNC_DELAY)
                continue

            inserted = await engine.sync_work_order(target, email_client, uid_cache)
            if inserted > 0:
                label = "would insert" if args.dry_run else "inserted"
                print(f"  {label} {inserted} new email messages")
            total_messages += inserted

            # Rate limit
            if i < len(targets):
                await asyncio.sleep(SYNC_DELAY)

        prefix = "Would sync" if args.dry_run else "Synced"
        print(f"\nDone. {prefix} {total_messages} new email messages across {len(targets)} work order(s).")

    finally:
        await email_client.close()


if __name__ == "__main__":
    asyncio.run(main())
