"""
AppFolio Communications Sync

Pulls SMS and email communications from AppFolio for all active work orders
and stores them in Supabase. Uses cookie-based auth against AppFolio's web UI.

Usage:
    python sync.py --login       # Interactive login, save session cookie
    python sync.py --dry-run     # Show what would be synced, no DB writes
    python sync.py               # Run full sync (SMS + email) — cron-safe
    python sync.py --sms-only    # Only sync SMS
    python sync.py --email-only  # Only sync email
"""

import argparse
import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from supabase import create_client

from session import SessionManager, APPFOLIO_VHOST, SUPABASE_URL, SUPABASE_SERVICE_KEY

# ── Config ───────────────────────────────────────────────────────────────────

CONCURRENCY = 4      # max parallel requests to AppFolio
BODY_DELAY = 0.3     # seconds between email body fetches (within a single WO)
UID_CACHE_PATH = Path.home() / ".appfolio_email_uid_cache.json"
PACIFIC = timezone(timedelta(hours=-7))  # PDT


# ── Phone Helpers ────────────────────────────────────────────────────────────

def normalize_phone(raw: str | None) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) == 10 else None


def phone_to_url_segment(digits: str) -> str:
    return f"({digits[:3]})%20{digits[3:6]}-{digits[6:]}"


def phone_to_display(digits: str) -> str:
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


# ── Email Helpers ────────────────────────────────────────────────────────────

def parse_appfolio_timestamp(raw: str) -> str | None:
    try:
        dt = datetime.strptime(raw.strip(), "%m/%d/%Y %I:%M %p")
        dt = dt.replace(tzinfo=PACIFIC)
        return dt.isoformat()
    except ValueError:
        return None


def parse_email_html(raw_html: str) -> str:
    soup = BeautifulSoup(raw_html, "html.parser")
    span = soup.find("span") or soup.find("body") or soup
    for script in span.find_all("script"):
        script.decompose()
    for br in span.find_all("br"):
        br.replace_with("\n")
    return span.get_text(strip=False).strip()


# ── Data Structures ──────────────────────────────────────────────────────────

@dataclass
class Issue:
    id: str
    workspace_id: str
    appfolio_id: str
    service_request_number: str | None
    unit_id: str | None
    tenant_id: str | None
    appfolio_vendor_id: str | None


@dataclass
class PhoneTarget:
    normalized_phone: str
    participant_type: str  # 'tenant' or 'vendor'
    participant_name: str
    workspace_id: str
    issue_ids: list[str] = field(default_factory=list)
    tenant_id: str | None = None


@dataclass
class EmailTarget:
    appfolio_id: str
    service_request_number: str
    issue_id: str
    workspace_id: str
    tenant_id: str | None = None
    appfolio_vendor_id: str | None = None
    short_uid: str | None = None


@dataclass
class ParsedEmail:
    email_id: str
    status: str
    sent_at: str
    to: str
    from_name: str
    subject: str
    href: str


# ── UID Cache ────────────────────────────────────────────────────────────────

_uid_cache_lock: asyncio.Lock | None = None


def _get_uid_lock() -> asyncio.Lock:
    global _uid_cache_lock
    if _uid_cache_lock is None:
        _uid_cache_lock = asyncio.Lock()
    return _uid_cache_lock


def load_uid_cache() -> dict[str, str]:
    if UID_CACHE_PATH.exists():
        try:
            return json.loads(UID_CACHE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_uid_cache(cache: dict[str, str]):
    UID_CACHE_PATH.write_text(json.dumps(cache, indent=2))


# ── AppFolio HTTP Clients ────────────────────────────────────────────────────

class AppFolioClient:
    """Shared HTTP client for both SMS and email scraping."""

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

    # ── SMS ───────────────────────────────────────────────────────────────

    async def fetch_sms_inbox(self, normalized_phone: str) -> dict | None:
        segment = phone_to_url_segment(normalized_phone)
        url = f"https://{self.vhost}/texting/inbox/{segment}"
        try:
            resp = await self.client.get(url, headers={
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
            })
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            print(f"  SMS HTTP {e.response.status_code} for {phone_to_display(normalized_phone)}")
            return None
        except Exception as e:
            print(f"  SMS error for {phone_to_display(normalized_phone)}: {e}")
            return None

    # ── Email ─────────────────────────────────────────────────────────────

    async def discover_short_uid(self, service_request_number: str, appfolio_id: str) -> str | None:
        url = f"https://{self.vhost}/maintenance/service_requests/{service_request_number}/work_orders/{appfolio_id}"
        try:
            resp = await self.client.get(url, headers={"Accept": "text/html"})
            if resp.status_code != 200:
                print(f"  WO page HTTP {resp.status_code} for WO {appfolio_id}")
                return None
            match = re.search(r'short_uids%5B%5D=(\d+)', resp.text)
            if match:
                return match.group(1)
            print(f"  No short_uid found for WO {appfolio_id}")
            return None
        except Exception as e:
            print(f"  Error fetching WO page {appfolio_id}: {e}")
            return None

    async def fetch_email_list(self, short_uid: str) -> list[ParsedEmail]:
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
                    break
                data = resp.json()
            except Exception as e:
                print(f"  Email list error for uid {short_uid}: {e}")
                break

            rows = data.get("body_row_data", [])
            if not rows:
                break

            for row in rows:
                cells = row.get("data", [])
                if len(cells) < 5:
                    continue
                href = None
                for attr in row.get("row_data_attributes", []):
                    if attr.get("key") == "href":
                        href = attr.get("value")
                        break
                if not href:
                    continue

                email_id = href.rstrip("/").split("/")[-1]
                status_soup = BeautifulSoup(cells[0].get("value", ""), "html.parser")

                # Column order: status, date, to, from, subject
                subject_raw = cells[4].get("value", "")
                subject_soup = BeautifulSoup(subject_raw, "html.parser")

                all_emails.append(ParsedEmail(
                    email_id=email_id,
                    status=status_soup.get_text(strip=True),
                    sent_at=cells[1].get("value", ""),
                    to=cells[2].get("value", ""),
                    from_name=cells[3].get("value", ""),
                    subject=subject_soup.get_text(strip=True),
                    href=href,
                ))

            if f"page={page + 1}" not in data.get("pagination", ""):
                break
            page += 1

        return all_emails

    async def fetch_email_body(self, email_id: str) -> str | None:
        url = f"https://{self.vhost}/emails/{email_id}/show_email_message"
        try:
            resp = await self.client.get(url, headers={"Accept": "text/html"})
            if resp.status_code != 200:
                return None
            return parse_email_html(resp.text)
        except Exception as e:
            print(f"  Email body error for {email_id}: {e}")
            return None

    async def close(self):
        await self.client.aclose()


# ── Sync Engine ──────────────────────────────────────────────────────────────

class SyncEngine:
    def __init__(self, supabase_client, dry_run: bool = False, force: bool = False):
        self.sb = supabase_client
        self.dry_run = dry_run
        self.force = force
        self._tenant_cache: dict[str, dict | None] = {}
        self._vendor_cache: dict[str, dict | None] = {}

    # ── Shared Discovery ──────────────────────────────────────────────────

    def discover_issues(self) -> list[Issue]:
        resp = (
            self.sb.table("issues")
            .select("id, workspace_id, appfolio_id, service_request_number, unit_id, tenant_id, appfolio_vendor_id")
            .eq("source", "appfolio")
            .neq("status", "done")
            .not_.is_("appfolio_id", "null")
            .execute()
        )
        return [
            Issue(
                id=r["id"],
                workspace_id=r["workspace_id"],
                appfolio_id=r["appfolio_id"],
                service_request_number=r.get("service_request_number"),
                unit_id=r.get("unit_id"),
                tenant_id=r.get("tenant_id"),
                appfolio_vendor_id=r.get("appfolio_vendor_id"),
            )
            for r in (resp.data or [])
        ]

    def _get_tenant_info(self, tenant_id: str | None) -> dict | None:
        if not tenant_id:
            return None
        if tenant_id in self._tenant_cache:
            return self._tenant_cache[tenant_id]
        resp = self.sb.table("tenants").select("name, email, phone").eq("id", tenant_id).limit(1).execute()
        info = resp.data[0] if resp.data else None
        self._tenant_cache[tenant_id] = info
        return info

    def _get_vendor_info(self, appfolio_vendor_id: str | None) -> dict | None:
        if not appfolio_vendor_id:
            return None
        if appfolio_vendor_id in self._vendor_cache:
            return self._vendor_cache[appfolio_vendor_id]
        resp = self.sb.table("vendors").select("name, email, phone").eq("appfolio_vendor_id", appfolio_vendor_id).limit(1).execute()
        info = resp.data[0] if resp.data else None
        self._vendor_cache[appfolio_vendor_id] = info
        return info

    # ── SMS Sync ──────────────────────────────────────────────────────────

    def build_phone_targets(self, issues: list[Issue]) -> list[PhoneTarget]:
        targets: dict[str, PhoneTarget] = {}

        tenant_issue_map: dict[str, list[Issue]] = {}
        unit_issue_map: dict[str, list[Issue]] = {}
        for issue in issues:
            if not issue.unit_id:
                continue
            if issue.tenant_id:
                tenant_issue_map.setdefault(issue.tenant_id, []).append(issue)
            else:
                unit_issue_map.setdefault(issue.unit_id, []).append(issue)

        # Direct tenant phones
        direct_ids = list(tenant_issue_map.keys())
        if direct_ids:
            resp = self.sb.table("tenants").select("id, name, phone").in_("id", direct_ids).not_.is_("phone", "null").execute()
            for t in resp.data or []:
                phone = normalize_phone(t["phone"])
                if not phone:
                    continue
                key = f"tenant:{phone}"
                if key not in targets:
                    first = tenant_issue_map[t["id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone, participant_type="tenant",
                        participant_name=t["name"] or "Unknown Tenant",
                        workspace_id=first.workspace_id, tenant_id=t["id"],
                    )
                for issue in tenant_issue_map[t["id"]]:
                    if issue.id not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue.id)

        # Fallback: all tenants at unit
        unit_ids = list(unit_issue_map.keys())
        if unit_ids:
            resp = self.sb.table("tenants").select("id, unit_id, name, phone").in_("unit_id", unit_ids).not_.is_("phone", "null").execute()
            for t in resp.data or []:
                phone = normalize_phone(t["phone"])
                if not phone:
                    continue
                key = f"tenant:{phone}"
                if key not in targets:
                    first = unit_issue_map[t["unit_id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone, participant_type="tenant",
                        participant_name=t["name"] or "Unknown Tenant",
                        workspace_id=first.workspace_id, tenant_id=t["id"],
                    )
                for issue in unit_issue_map.get(t["unit_id"], []):
                    if issue.id not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue.id)

        # Vendor phones
        vendor_issue_map: dict[str, list[Issue]] = {}
        for issue in issues:
            if issue.appfolio_vendor_id:
                vendor_issue_map.setdefault(issue.appfolio_vendor_id, []).append(issue)

        af_vendor_ids = list(vendor_issue_map.keys())
        if af_vendor_ids:
            resp = self.sb.table("vendors").select("id, appfolio_vendor_id, name, phone").in_("appfolio_vendor_id", af_vendor_ids).not_.is_("phone", "null").execute()
            for v in resp.data or []:
                phone = normalize_phone(v["phone"])
                if not phone:
                    continue
                key = f"vendor:{phone}"
                if key not in targets:
                    first = vendor_issue_map[v["appfolio_vendor_id"]][0]
                    targets[key] = PhoneTarget(
                        normalized_phone=phone, participant_type="vendor",
                        participant_name=v["name"] or "Unknown Vendor",
                        workspace_id=first.workspace_id,
                    )
                for issue in vendor_issue_map.get(v["appfolio_vendor_id"], []):
                    if issue.id not in targets[key].issue_ids:
                        targets[key].issue_ids.append(issue.id)

        return list(targets.values())

    def _ensure_sms_thread(self, target: PhoneTarget, issue_id: str) -> str | None:
        external_id = f"af_sms:{target.normalized_phone}:{issue_id}"
        existing = self.sb.table("threads").select("id").eq("external_id", external_id).limit(1).execute()
        if existing.data:
            return existing.data[0]["id"]
        if self.dry_run:
            return None
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
        return resp.data[0]["id"] if resp.data else None

    def sync_sms_phone(self, target: PhoneTarget, api_response: dict) -> int:
        api_messages = api_response.get("text_messages", [])
        if not api_messages:
            return 0

        total = 0
        for issue_id in target.issue_ids:
            thread_id = self._ensure_sms_thread(target, issue_id)

            if self.dry_run:
                total += len(api_messages)
                continue
            if not thread_id:
                continue

            known_resp = self.sb.table("messages").select("external_id").eq("thread_id", thread_id).execute()
            known_ids = {m["external_id"] for m in (known_resp.data or [])}

            new_messages = []
            for msg in api_messages:
                ext_id = f"af_sms_{msg['id']}"
                if ext_id in known_ids:
                    continue

                direction_raw = msg.get("direction", "")
                if direction_raw == "inbound":
                    sender = target.participant_type
                    direction = "inbound"
                else:
                    sender = "manager"
                    direction = "outbound"

                sender_user = msg.get("sender_user") or {}
                metadata = {"participant_type": target.participant_type}
                if direction == "inbound":
                    metadata["sender_name"] = target.participant_name
                elif sender_user.get("name"):
                    metadata["sender_name"] = sender_user["name"]

                new_messages.append({
                    "thread_id": thread_id,
                    "issue_id": issue_id,
                    "workspace_id": target.workspace_id,
                    "external_id": ext_id,
                    "message": msg.get("body", ""),
                    "sender": sender,
                    "timestamp": msg.get("sent_or_received_at"),
                    "channel": "appfolio_sms",
                    "direction": direction,
                    "delivery_status": "received" if direction == "inbound" else "sent",
                    "metadata": metadata,
                })

            if new_messages:
                new_messages.reverse()  # oldest first for resumability
                for i in range(0, len(new_messages), 100):
                    chunk = new_messages[i:i + 100]
                    resp = self.sb.table("messages").upsert(chunk, on_conflict="external_id").execute()
                    total += len(resp.data or [])

        return total

    # ── Email Sync ────────────────────────────────────────────────────────

    def build_email_targets(self, issues: list[Issue]) -> list[EmailTarget]:
        return [
            EmailTarget(
                appfolio_id=issue.appfolio_id,
                service_request_number=issue.service_request_number,
                issue_id=issue.id,
                workspace_id=issue.workspace_id,
                tenant_id=issue.tenant_id,
                appfolio_vendor_id=issue.appfolio_vendor_id,
            )
            for issue in issues
            if issue.service_request_number
        ]

    def _resolve_email_participant(
        self, email: ParsedEmail, target: EmailTarget
    ) -> tuple[str, str, str, str]:
        """Returns (sender, direction, participant_type, participant_name)."""
        tenant = self._get_tenant_info(target.tenant_id)
        vendor = self._get_vendor_info(target.appfolio_vendor_id)
        from_lower = (email.from_name or "").strip().lower()
        to_lower = (email.to or "").lower()

        if tenant:
            name = (tenant.get("name") or "").strip()
            email_addr = (tenant.get("email") or "").strip().lower()
            if name and from_lower == name.lower():
                return ("tenant", "inbound", "tenant", name)
            if email_addr and email_addr in to_lower:
                return ("manager", "outbound", "tenant", name or "Tenant")

        if vendor:
            name = (vendor.get("name") or "").strip()
            email_addr = (vendor.get("email") or "").strip().lower()
            if name and from_lower == name.lower():
                return ("vendor", "inbound", "vendor", name)
            if email_addr and email_addr in to_lower:
                return ("manager", "outbound", "vendor", name or "Vendor")

        return ("unknown", "inbound", "unknown", email.from_name or "Unknown")

    def _ensure_email_thread(self, target: EmailTarget, participant_type: str, participant_name: str) -> str | None:
        external_id = f"af_email:{participant_type}:{target.issue_id}"
        existing = self.sb.table("threads").select("id").eq("external_id", external_id).limit(1).execute()
        if existing.data:
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
        return resp.data[0]["id"] if resp.data else None

    async def sync_email_work_order(
        self, target: EmailTarget, client: AppFolioClient, uid_cache: dict[str, str]
    ) -> int:
        # Discover short_uid (lock protects shared cache dict + file writes)
        async with _get_uid_lock():
            if target.appfolio_id in uid_cache:
                target.short_uid = uid_cache[target.appfolio_id]
        if not target.short_uid:
            target.short_uid = await client.discover_short_uid(
                target.service_request_number, target.appfolio_id
            )
            if target.short_uid:
                async with _get_uid_lock():
                    uid_cache[target.appfolio_id] = target.short_uid
                    save_uid_cache(uid_cache)

        if not target.short_uid:
            return 0

        emails = await client.fetch_email_list(target.short_uid)
        if not emails:
            return 0

        # Dedup (skip when --force to allow re-sync of corrected data)
        known_ids: set[str] = set()
        if not self.dry_run and not self.force:
            known_resp = self.sb.table("messages").select("external_id").eq("issue_id", target.issue_id).eq("channel", "appfolio_email").execute()
            known_ids = {m["external_id"] for m in (known_resp.data or [])}

        new_emails = [e for e in emails if f"af_email_{e.email_id}" not in known_ids]
        if not new_emails and not self.dry_run:
            return 0

        # Fetch bodies
        emails_with_bodies: list[tuple[ParsedEmail, str]] = []
        for email in new_emails:
            if self.dry_run:
                emails_with_bodies.append((email, "(dry run)"))
            else:
                body = await client.fetch_email_body(email.email_id)
                emails_with_bodies.append((email, body or "(no body)"))
                await asyncio.sleep(BODY_DELAY)

        # Group by participant
        groups: dict[str, list[tuple[ParsedEmail, str]]] = {}
        for email, body in emails_with_bodies:
            _, _, ptype, pname = self._resolve_email_participant(email, target)
            key = f"{ptype}:{pname}"
            groups.setdefault(key, []).append((email, body))

        total = 0
        for key, group_emails in groups.items():
            ptype, pname = key.split(":", 1)
            thread_id = self._ensure_email_thread(target, ptype, pname)

            if self.dry_run:
                total += len(group_emails)
                continue
            if not thread_id:
                continue

            new_messages = []
            for email, body in group_emails:
                ext_id = f"af_email_{email.email_id}"
                if ext_id in known_ids:
                    continue

                sender, direction, _, _ = self._resolve_email_participant(email, target)
                if direction == "outbound":
                    sender = "manager"
                elif ptype == "tenant":
                    sender = "tenant"
                elif ptype == "vendor":
                    sender = "vendor"
                else:
                    sender = "unknown"

                metadata = {"participant_type": ptype}
                metadata["sender_name"] = pname if direction == "inbound" else (email.from_name or "LAPM")
                metadata["email_status"] = email.status

                new_messages.append({
                    "thread_id": thread_id,
                    "issue_id": target.issue_id,
                    "workspace_id": target.workspace_id,
                    "external_id": ext_id,
                    "message": body,
                    "sender": sender,
                    "subject": email.subject,
                    "timestamp": parse_appfolio_timestamp(email.sent_at),
                    "channel": "appfolio_email",
                    "direction": direction,
                    "metadata": metadata,
                })

            if new_messages:
                new_messages.sort(key=lambda m: m["timestamp"] or "")
                for i in range(0, len(new_messages), 100):
                    chunk = new_messages[i:i + 100]
                    resp = self.sb.table("messages").upsert(chunk, on_conflict="external_id").execute()
                    total += len(resp.data or [])

        return total


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="AppFolio Communications Sync (SMS + Email)")
    parser.add_argument("--login", action="store_true", help="Interactive login to get session cookie")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be synced, no DB writes")
    parser.add_argument("--sms-only", action="store_true", help="Only sync SMS")
    parser.add_argument("--email-only", action="store_true", help="Only sync email")
    parser.add_argument("--force", action="store_true", help="Re-sync all messages (skip dedup, upsert over existing)")
    args = parser.parse_args()

    session_mgr = SessionManager(APPFOLIO_VHOST)

    if args.login:
        await session_mgr.login_interactive()
        print(f"\nCookie saved. Run `python {sys.argv[0]}` to sync.")
        return

    cookie = await session_mgr.get_valid_cookies()
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    af = AppFolioClient(APPFOLIO_VHOST, cookie)
    engine = SyncEngine(sb, dry_run=args.dry_run, force=args.force)

    do_sms = not args.email_only
    do_email = not args.sms_only
    label = "DRY RUN" if args.dry_run else "SYNC"
    started = time.time()

    try:
        # Single discovery pass
        issues = engine.discover_issues()
        print(f"Found {len(issues)} active AppFolio issues")
        if not issues:
            print("Nothing to sync.")
            return

        sms_total = 0
        email_total = 0
        sem = asyncio.Semaphore(CONCURRENCY)
        counter = [0]  # mutable counter for progress

        # ── SMS ───────────────────────────────────────────────────────────
        if do_sms:
            phone_targets = engine.build_phone_targets(issues)
            tenant_count = sum(1 for t in phone_targets if t.participant_type == "tenant")
            vendor_count = sum(1 for t in phone_targets if t.participant_type == "vendor")
            total_phones = len(phone_targets)
            print(f"\n[SMS] {total_phones} phone targets ({tenant_count} tenant, {vendor_count} vendor)")
            counter[0] = 0

            async def sync_one_sms(target):
                async with sem:
                    counter[0] += 1
                    idx = counter[0]
                    display = phone_to_display(target.normalized_phone)
                    prefix = f"  [{idx}/{total_phones}] {target.participant_type}: {target.participant_name} ({display}) — {len(target.issue_ids)} issue(s)"

                    response = await af.fetch_sms_inbox(target.normalized_phone)
                    if response is None:
                        print(f"{prefix} — no history")
                        return 0

                    msgs = response.get("text_messages", [])
                    inserted = engine.sync_sms_phone(target, response)
                    if inserted > 0:
                        action = "would insert" if args.dry_run else "inserted"
                        print(f"{prefix} — {action} {inserted}/{len(msgs)}")
                    else:
                        print(f"{prefix} — up to date ({len(msgs)} msgs)")
                    return inserted

            results = await asyncio.gather(*[sync_one_sms(t) for t in phone_targets])
            sms_total = sum(results)

        # ── Email ─────────────────────────────────────────────────────────
        if do_email:
            email_targets = engine.build_email_targets(issues)
            total_emails = len(email_targets)
            print(f"\n[Email] {total_emails} work orders with service_request_number")
            counter[0] = 0

            uid_cache = load_uid_cache()

            async def sync_one_email(target):
                async with sem:
                    counter[0] += 1
                    idx = counter[0]
                    prefix = f"  [{idx}/{total_emails}] WO {target.appfolio_id} (SR #{target.service_request_number}) — {target.issue_id[:8]}"

                    inserted = await engine.sync_email_work_order(target, af, uid_cache)
                    if inserted > 0:
                        action = "would insert" if args.dry_run else "inserted"
                        print(f"{prefix} — {action} {inserted} emails")
                    else:
                        print(f"{prefix} — up to date")
                    return inserted

            results = await asyncio.gather(*[sync_one_email(t) for t in email_targets])
            email_total = sum(results)

        # ── Summary ───────────────────────────────────────────────────────
        elapsed = time.time() - started
        prefix = "Would sync" if args.dry_run else "Synced"
        parts = []
        if do_sms:
            parts.append(f"{sms_total} SMS")
        if do_email:
            parts.append(f"{email_total} email")
        print(f"\n{label} done in {elapsed:.0f}s — {prefix} {' + '.join(parts)} new messages")

    finally:
        await af.close()


if __name__ == "__main__":
    asyncio.run(main())
