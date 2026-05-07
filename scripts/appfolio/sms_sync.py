"""
AppFolio SMS Communication Scraper

Scrapes text message threads from AppFolio's texting inbox and stores them
in Supabase threads/messages tables. Uses Playwright for interactive login
(SMS MFA) and httpx for API calls.

Usage:
    python sms_sync.py --login       # Interactive login, save session cookie
    python sms_sync.py --dry-run     # Show what would be synced, no DB writes
    python sms_sync.py               # Run sync
"""

import argparse
import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass, field

import httpx
from supabase import create_client

from session import SessionManager, APPFOLIO_VHOST, SUPABASE_URL, SUPABASE_SERVICE_KEY, COOKIE_PATH

SYNC_DELAY = 1.0  # seconds between API calls


# ── Phone Normalization ──────────────────────────────────────────────────────

def normalize_phone(raw: str | None) -> str | None:
    """Extract 10-digit US phone from formats like 'Mobile: (213) 514-2232'."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    return digits


def phone_to_url_segment(digits: str) -> str:
    """Format 10-digit number for AppFolio texting inbox URL.
    '2135142232' -> '(213)%20514-2232'
    """
    return f"({digits[:3]})%20{digits[3:6]}-{digits[6:]}"


def phone_to_display(digits: str) -> str:
    """'2135142232' -> '(213) 514-2232'"""
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


# ── Data Structures ──────────────────────────────────────────────────────────

@dataclass
class PhoneTarget:
    normalized_phone: str
    participant_type: str  # 'tenant' or 'vendor'
    participant_name: str
    workspace_id: str
    issue_ids: list[str] = field(default_factory=list)
    tenant_id: str | None = None


# ── AppFolio SMS Client ──────────────────────────────────────────────────────

class AppFolioSMSClient:
    def __init__(self, vhost: str, cookie_header: str):
        self.vhost = vhost
        self.client = httpx.AsyncClient(
            headers={
                "Cookie": cookie_header,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/142.0.0.0 Safari/537.36",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=30.0,
        )

    async def fetch_inbox(self, normalized_phone: str) -> dict | None:
        """Fetch the texting inbox for a phone number."""
        segment = phone_to_url_segment(normalized_phone)
        url = f"https://{self.vhost}/texting/inbox/{segment}"
        try:
            resp = await self.client.get(url)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            print(f"  HTTP {e.response.status_code} for {phone_to_display(normalized_phone)}")
            return None
        except Exception as e:
            print(f"  Error fetching {phone_to_display(normalized_phone)}: {e}")
            return None

    async def close(self):
        await self.client.aclose()


# ── Sync Engine ──────────────────────────────────────────────────────────────

class SyncEngine:
    def __init__(self, supabase_client, dry_run: bool = False):
        self.sb = supabase_client
        self.dry_run = dry_run

    def discover_targets(self) -> list[PhoneTarget]:
        """Find all phone numbers linked to active AppFolio issues."""
        targets: dict[str, PhoneTarget] = {}  # keyed by "{type}:{phone}"

        # Get active AppFolio issues with unit_id
        issues_resp = (
            self.sb.table("issues")
            .select("id, workspace_id, unit_id, tenant_id, appfolio_vendor_id")
            .eq("source", "appfolio")
            .neq("status", "done")
            .not_.is_("unit_id", "null")
            .execute()
        )
        issues = issues_resp.data or []

        # Partition: issues with a known tenant vs fallback to all tenants at unit
        tenant_issue_map: dict[str, list[dict]] = {}  # tenant_id -> [issues]
        unit_issue_map: dict[str, list[dict]] = {}     # unit_id -> [issues]
        for issue in issues:
            if issue.get("tenant_id"):
                tenant_issue_map.setdefault(issue["tenant_id"], []).append(issue)
            elif issue.get("unit_id"):
                unit_issue_map.setdefault(issue["unit_id"], []).append(issue)

        # Path A: Issues with tenant_id — only scrape the submitting tenant's phone
        direct_tenant_ids = list(tenant_issue_map.keys())
        if direct_tenant_ids:
            tenants_resp = (
                self.sb.table("tenants")
                .select("id, unit_id, name, phone")
                .in_("id", direct_tenant_ids)
                .not_.is_("phone", "null")
                .execute()
            )
            for tenant in tenants_resp.data or []:
                phone = normalize_phone(tenant["phone"])
                if not phone:
                    continue
                key = f"tenant:{phone}"
                if key not in targets:
                    first_issue = tenant_issue_map[tenant["id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone,
                        participant_type="tenant",
                        participant_name=tenant["name"] or "Unknown Tenant",
                        workspace_id=first_issue["workspace_id"],
                        tenant_id=tenant["id"],
                    )
                for issue in tenant_issue_map[tenant["id"]]:
                    if issue["id"] not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue["id"])

        # Path B: Issues without tenant_id — fall back to all tenants at the unit
        unit_ids = list(unit_issue_map.keys())
        if unit_ids:
            tenants_resp = (
                self.sb.table("tenants")
                .select("id, unit_id, name, phone")
                .in_("unit_id", unit_ids)
                .not_.is_("phone", "null")
                .execute()
            )
            for tenant in tenants_resp.data or []:
                phone = normalize_phone(tenant["phone"])
                if not phone:
                    continue
                key = f"tenant:{phone}"
                if key not in targets:
                    first_issue = unit_issue_map[tenant["unit_id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone,
                        participant_type="tenant",
                        participant_name=tenant["name"] or "Unknown Tenant",
                        workspace_id=first_issue["workspace_id"],
                        tenant_id=tenant["id"],
                    )
                for issue in unit_issue_map.get(tenant["unit_id"], []):
                    if issue["id"] not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue["id"])

        # Vendor phones via issues -> vendors (through appfolio_vendor_id)
        vendor_issue_map: dict[str, list[dict]] = {}
        for issue in issues:
            vid = issue.get("appfolio_vendor_id")
            if vid:
                vendor_issue_map.setdefault(vid, []).append(issue)

        af_vendor_ids = list(vendor_issue_map.keys())
        if af_vendor_ids:
            vendors_resp = (
                self.sb.table("vendors")
                .select("id, appfolio_vendor_id, name, phone")
                .in_("appfolio_vendor_id", af_vendor_ids)
                .not_.is_("phone", "null")
                .execute()
            )
            for vendor in vendors_resp.data or []:
                phone = normalize_phone(vendor["phone"])
                if not phone:
                    continue
                key = f"vendor:{phone}"
                if key not in targets:
                    first_issue = vendor_issue_map[vendor["appfolio_vendor_id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone,
                        participant_type="vendor",
                        participant_name=vendor["name"] or "Unknown Vendor",
                        workspace_id=first_issue["workspace_id"],
                    )
                for issue in vendor_issue_map.get(vendor["appfolio_vendor_id"], []):
                    if issue["id"] not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue["id"])

        return list(targets.values())

    def ensure_thread(self, target: PhoneTarget, issue_id: str) -> str | None:
        """Upsert a thread for this phone+issue combo. Returns thread ID."""
        external_id = f"af_sms:{target.normalized_phone}:{issue_id}"

        # Check if thread exists
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

        # Create thread
        insert_data = {
            "workspace_id": target.workspace_id,
            "issue_id": issue_id,
            "external_id": external_id,
            "participant_type": target.participant_type,
            "participant_id": target.tenant_id if target.participant_type == "tenant" else None,
            "name": target.participant_name,
            "phone": target.normalized_phone,
        }
        if target.tenant_id and target.participant_type == "tenant":
            insert_data["tenant_id"] = target.tenant_id

        resp = self.sb.table("threads").insert(insert_data).execute()
        if resp.data:
            return resp.data[0]["id"]
        return None

    def get_latest_message_id(self, thread_id: str) -> str | None:
        """Get the external_id of the most recent message in a thread."""
        resp = (
            self.sb.table("messages")
            .select("external_id")
            .eq("thread_id", thread_id)
            .order("timestamp", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            return resp.data[0]["external_id"]
        return None

    def insert_messages(
        self,
        thread_id: str,
        issue_id: str,
        workspace_id: str,
        participant_type: str,
        participant_name: str,
        api_messages: list[dict],
        known_external_ids: set[str],
    ) -> int:
        """Insert new messages, return count inserted."""
        new_messages = []
        for msg in api_messages:
            ext_id = f"af_sms_{msg['id']}"
            if ext_id in known_external_ids:
                continue

            direction_raw = msg.get("direction", "")
            if direction_raw == "inbound":
                sender = participant_type
                direction = "inbound"
            else:
                sender = "manager"
                direction = "outbound"

            sender_user = msg.get("sender_user") or {}
            sender_name = sender_user.get("name")

            metadata = {"participant_type": participant_type}
            if direction == "inbound":
                metadata["sender_name"] = participant_name
            elif sender_name:
                metadata["sender_name"] = sender_name

            new_messages.append({
                "thread_id": thread_id,
                "issue_id": issue_id,
                "workspace_id": workspace_id,
                "external_id": ext_id,
                "message": msg.get("body", ""),
                "sender": sender,
                "timestamp": msg.get("sent_or_received_at"),
                "channel": "appfolio_sms",
                "direction": direction,
                "delivery_status": "received" if direction == "inbound" else "sent",
                "metadata": metadata if metadata else None,
            })

        if not new_messages:
            return 0

        if self.dry_run:
            return len(new_messages)

        # Insert oldest-first so interruptions are resumable
        new_messages.reverse()

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

    def sync_phone(self, target: PhoneTarget, api_response: dict) -> int:
        """Sync messages for a phone target across all its linked issues."""
        api_messages = api_response.get("text_messages", [])
        if not api_messages:
            return 0

        total_inserted = 0

        for issue_id in target.issue_ids:
            thread_id = self.ensure_thread(target, issue_id)

            if self.dry_run:
                # In dry run, count all messages as "new"
                print(f"    Issue {issue_id[:8]}...: {len(api_messages)} messages available")
                total_inserted += len(api_messages)
                continue

            if not thread_id:
                continue

            # Get all known external_ids for this thread to do delta comparison
            known_resp = (
                self.sb.table("messages")
                .select("external_id")
                .eq("thread_id", thread_id)
                .execute()
            )
            known_ids = {m["external_id"] for m in (known_resp.data or [])}

            count = self.insert_messages(
                thread_id=thread_id,
                issue_id=issue_id,
                workspace_id=target.workspace_id,
                participant_type=target.participant_type,
                participant_name=target.participant_name,
                api_messages=api_messages,
                known_external_ids=known_ids,
            )
            total_inserted += count

        return total_inserted


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="AppFolio SMS Sync")
    parser.add_argument("--login", action="store_true", help="Interactive login to get session cookie")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be synced without writing to DB")
    parser.add_argument("--preview", type=int, default=0, help="Preview N tenants' messages then stop")
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
    sms_client = AppFolioSMSClient(APPFOLIO_VHOST, cookie)
    engine = SyncEngine(sb, dry_run=args.dry_run)

    try:
        # Discover phone targets
        targets = engine.discover_targets()
        print(f"Found {len(targets)} unique phone targets "
              f"({sum(1 for t in targets if t.participant_type == 'tenant')} tenant, "
              f"{sum(1 for t in targets if t.participant_type == 'vendor')} vendor)")

        if not targets:
            print("No active issues with phone numbers. Nothing to sync.")
            return

        total_messages = 0
        preview_count = args.preview
        for i, target in enumerate(targets, 1):
            display = phone_to_display(target.normalized_phone)
            print(f"[{i}/{len(targets)}] {target.participant_type}: {target.participant_name} "
                  f"({display}) — {len(target.issue_ids)} issue(s)")

            response = await sms_client.fetch_inbox(target.normalized_phone)
            if response is None:
                print("  No texting history found.")
                continue

            msgs = response.get("text_messages", [])
            print(f"  API returned {len(msgs)} messages")

            # --preview: show recent messages for first N tenants then stop
            if args.preview and target.participant_type == "tenant":
                preview_count -= 1
                recent = msgs[:5]  # newest first from API
                for m in recent:
                    direction = m.get("direction", "?")
                    ts = m.get("sent_or_received_at", "?")[:19]
                    body = (m.get("body") or "")[:120]
                    sender = m.get("sender_user", {})
                    sender_name = sender.get("name", "TENANT") if sender else "TENANT"
                    print(f"    [{ts}] {direction:<15} {sender_name}: {body}")
                if preview_count <= 0:
                    print(f"\n--preview limit reached.")
                    return
                await asyncio.sleep(SYNC_DELAY)
                continue

            inserted = engine.sync_phone(target, response)
            if inserted > 0:
                label = "would insert" if args.dry_run else "inserted"
                print(f"  {label} {inserted} new messages")
            total_messages += inserted

            # Rate limit
            if i < len(targets):
                await asyncio.sleep(SYNC_DELAY)

        prefix = "Would sync" if args.dry_run else "Synced"
        print(f"\nDone. {prefix} {total_messages} new messages across {len(targets)} phone(s).")

    finally:
        await sms_client.close()


if __name__ == "__main__":
    asyncio.run(main())
