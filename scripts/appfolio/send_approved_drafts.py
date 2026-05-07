"""
Send Approved AppFolio Drafts

Worker that picks up human-approved drafts and fires the actual AppFolio
action (email, text, vendor assignment, etc.). The approval gate lives
upstream — by the time a row reaches this worker, a human has already
reviewed and clicked "Approve" in the bedrock UI.

Source of truth for "what to send" is the activity_logs table:
    type='appfolio_approved'        — created by /api/appfolio-drafts/approve
    type='appfolio_sent'            — written here on success
    type='appfolio_send_failed'     — written here on failure

We use activity_logs (not the drafts table) because /api/appfolio-drafts/approve
deletes the draft after capturing a snapshot in activity_logs.data.draft.

Usage:
    python send_approved_drafts.py --dry-run
        Preview what would be sent. No AppFolio calls, no DB writes.

    python send_approved_drafts.py --interactive
        Prompt y/N before each send. Use during the trust-building phase.

    python send_approved_drafts.py
        Process the queue once and exit. Cron-safe.

    python send_approved_drafts.py --watch [--interval 30]
        Long-running mode: poll every N seconds. Run as a daemon.
"""

import argparse
import asyncio
import sys
from dataclasses import dataclass

from supabase import create_client

from session import (
    SessionManager, APPFOLIO_VHOST, SUPABASE_URL, SUPABASE_SERVICE_KEY,
    COOKIE_PATH,
)
from actions import AppFolioActions, ActionResult


@dataclass
class PendingApproval:
    """An approved-but-not-sent action ready to fire."""
    log_id: str
    workspace_id: str
    issue_id: str
    appfolio_id: str | None             # work_order_id in AppFolio
    service_request_number: str | None
    channel: str                         # 'appfolio' for now; future: 'sms', etc.
    subject: str | None
    body: str | None
    recipient_email: str | None
    recipient_emails: list[str] | None
    approved_by: str | None
    created_at: str


# ── Queue discovery ──────────────────────────────────────────────────────────


def fetch_pending_approvals(sb) -> list[PendingApproval]:
    """Return approved actions that haven't been sent or failed yet.

    Approach: fetch all approved logs and all sent/failed logs, then
    exclude approvals that already have a terminal record. At scale this
    becomes a query optimization concern — for now it's fine, and
    'appfolio_approved' is a tiny slice of activity_logs anyway.
    """
    approved = (
        sb.table("activity_logs")
        .select("id, workspace_id, issue_id, data, created_at")
        .eq("type", "appfolio_approved")
        .order("created_at", desc=False)
        .execute()
        .data or []
    )
    if not approved:
        return []

    # Find approvals that already have a sent/failed sibling log.
    terminal = (
        sb.table("activity_logs")
        .select("data")
        .in_("type", ["appfolio_sent", "appfolio_send_failed"])
        .execute()
        .data or []
    )
    settled_log_ids: set[str] = set()
    for row in terminal:
        sid = (row.get("data") or {}).get("source_log_id")
        if sid:
            settled_log_ids.add(sid)

    pending: list[PendingApproval] = []
    issue_ids = list({row["issue_id"] for row in approved if row["id"] not in settled_log_ids})
    if not issue_ids:
        return []

    # Hydrate issue → appfolio_id + service_request_number
    issues = (
        sb.table("issues")
        .select("id, appfolio_id, service_request_number")
        .in_("id", issue_ids)
        .execute()
        .data or []
    )
    issue_by_id = {i["id"]: i for i in issues}

    for row in approved:
        if row["id"] in settled_log_ids:
            continue
        data = row.get("data") or {}
        draft = data.get("draft") or {}
        issue = issue_by_id.get(row["issue_id"]) or {}
        pending.append(PendingApproval(
            log_id=row["id"],
            workspace_id=row["workspace_id"],
            issue_id=row["issue_id"],
            appfolio_id=issue.get("appfolio_id"),
            service_request_number=issue.get("service_request_number"),
            channel=draft.get("channel") or "appfolio",
            subject=draft.get("subject"),
            body=draft.get("body"),
            recipient_email=draft.get("recipient_email"),
            recipient_emails=draft.get("recipient_emails"),
            approved_by=data.get("approved_by"),
            created_at=row["created_at"],
        ))
    return pending


# ── Result logging ───────────────────────────────────────────────────────────


def log_send_result(sb, approval: PendingApproval, result: ActionResult, action_kind: str):
    """Insert appfolio_sent / appfolio_send_failed activity log."""
    log_type = "appfolio_sent" if result.ok else "appfolio_send_failed"
    payload = {
        "workspace_id": approval.workspace_id,
        "issue_id": approval.issue_id,
        "type": log_type,
        "subject": approval.subject,
        "to_emails": approval.recipient_emails or (
            [approval.recipient_email] if approval.recipient_email else None
        ),
        "data": {
            "source_log_id": approval.log_id,
            "action_kind": action_kind,
            "status_code": result.status_code,
            "detail": result.detail,
            "approved_by": approval.approved_by,
        },
    }
    sb.table("activity_logs").insert(payload).execute()


# ── Action dispatch ──────────────────────────────────────────────────────────


def describe(approval: PendingApproval) -> str:
    """Human-readable preview line for --dry-run / --interactive."""
    parts = [
        f"[{approval.created_at[:19]}]",
        f"issue={approval.issue_id[:8]}",
        f"WO={approval.appfolio_id or '?'}/SR={approval.service_request_number or '?'}",
        f"approved_by={approval.approved_by or '?'}",
    ]
    head = " ".join(parts)
    body_preview = (approval.body or "").replace("\n", " ").strip()[:80]
    return (
        f"{head}\n"
        f"  channel: {approval.channel}\n"
        f"  to:      {approval.recipient_email}\n"
        f"  subject: {approval.subject}\n"
        f"  body:    {body_preview}{'…' if len(approval.body or '') > 80 else ''}"
    )


async def fire_one(
    actions: AppFolioActions,
    approval: PendingApproval,
) -> tuple[ActionResult, str]:
    """Run the appropriate AppFolio action for this approval. Returns
    (result, action_kind) where action_kind is a short tag for logging.
    """
    if approval.channel != "appfolio":
        # Non-AppFolio channels (e.g. Gmail-based 'email') are sent by
        # other handlers; we shouldn't see them here.
        return (
            ActionResult(
                ok=False,
                status_code=0,
                detail=f"channel={approval.channel!r} not handled by this worker",
            ),
            "skip:non_appfolio",
        )

    if not (approval.service_request_number and approval.appfolio_id):
        return (
            ActionResult(
                ok=False,
                status_code=0,
                detail=(
                    "Issue missing appfolio_id or service_request_number "
                    "— cannot route AppFolio action."
                ),
            ),
            "skip:missing_ids",
        )

    if not (approval.subject and approval.body and approval.recipient_email):
        return (
            ActionResult(
                ok=False,
                status_code=0,
                detail="Draft missing subject/body/recipient_email",
            ),
            "skip:incomplete_draft",
        )

    # Right now we only know one AppFolio action: send tenant/vendor email
    # via notify_tenant. Future: discriminate on draft.action_kind once
    # the bot starts emitting other action types (sms, vendor_assign, etc).
    result = await actions.notify_tenant_via_email(
        service_request_number=approval.service_request_number,
        work_order_id=approval.appfolio_id,
        recipient=approval.recipient_email,
        subject=approval.subject,
        body=approval.body,
    )
    return result, "notify_tenant_via_email"


# ── Driver ───────────────────────────────────────────────────────────────────


async def process_once(
    sb,
    actions: AppFolioActions,
    *,
    dry_run: bool,
    interactive: bool,
) -> tuple[int, int, int]:
    """Process all pending approvals once. Returns (sent, failed, skipped)."""
    pending = fetch_pending_approvals(sb)
    if not pending:
        print("No pending approvals.")
        return (0, 0, 0)

    print(f"Found {len(pending)} pending approval(s).")
    sent = failed = skipped = 0

    for i, approval in enumerate(pending, 1):
        print(f"\n[{i}/{len(pending)}] {describe(approval)}")

        if dry_run:
            print("  (dry-run) would fire AppFolio action — no changes made.")
            skipped += 1
            continue

        if interactive:
            try:
                answer = input("  Send this? [y/N] ").strip().lower()
            except EOFError:
                answer = ""
            if answer not in ("y", "yes"):
                print("  skipped by operator.")
                skipped += 1
                continue

        try:
            result, action_kind = await fire_one(actions, approval)
        except Exception as e:
            result = ActionResult(ok=False, status_code=0, detail=f"exception: {e!r}")
            action_kind = "exception"

        log_send_result(sb, approval, result, action_kind)
        if result.ok:
            print(f"  ✓ sent (HTTP {result.status_code}, action={action_kind})")
            sent += 1
        else:
            print(f"  ✗ failed (HTTP {result.status_code}, action={action_kind}): "
                  f"{result.detail}")
            failed += 1

    return (sent, failed, skipped)


async def main():
    parser = argparse.ArgumentParser(
        description="Send approved AppFolio drafts via web actions."
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview what would be sent. No HTTP calls, no DB writes.")
    parser.add_argument("--interactive", action="store_true",
                        help="Prompt y/N before each send. Use during trust-building.")
    parser.add_argument("--watch", action="store_true",
                        help="Long-running mode: poll repeatedly.")
    parser.add_argument("--interval", type=int, default=30,
                        help="Poll interval in seconds when --watch (default 30).")
    args = parser.parse_args()

    if args.dry_run and args.interactive:
        print("Pick one: --dry-run OR --interactive (not both).", file=sys.stderr)
        sys.exit(2)
    if args.watch and args.interactive:
        print("--interactive doesn't make sense with --watch (no TTY assumptions).",
              file=sys.stderr)
        sys.exit(2)

    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    if args.dry_run:
        # No AppFolio session needed for preview.
        await process_once(sb, actions=None, dry_run=True, interactive=False)  # type: ignore[arg-type]
        return

    session_mgr = SessionManager(APPFOLIO_VHOST)
    cookie = await session_mgr.get_valid_cookies()

    # Re-read the cookie file before every action so a long-running
    # --watch process picks up fresh cookies that the session daemon
    # writes every ~30min. Critical for the Mac Mini deployment, where
    # the daemon refreshes the JWT before its 2h expiry.
    def fresh_cookie_provider() -> str:
        try:
            return COOKIE_PATH.read_text().strip()
        except OSError:
            return cookie  # fall back to last known good

    actions = AppFolioActions(
        APPFOLIO_VHOST, cookie, cookie_provider=fresh_cookie_provider,
    )

    try:
        if not args.watch:
            sent, failed, skipped = await process_once(
                sb, actions,
                dry_run=False, interactive=args.interactive,
            )
            print(f"\nDone — sent={sent} failed={failed} skipped={skipped}")
            sys.exit(1 if failed else 0)

        print(f"Watching for approvals (every {args.interval}s). Ctrl+C to stop.")
        while True:
            try:
                await process_once(sb, actions, dry_run=False, interactive=False)
            except Exception as e:
                print(f"[watch] iteration error: {e!r}")
            await asyncio.sleep(args.interval)
    finally:
        await actions.close()


if __name__ == "__main__":
    asyncio.run(main())
