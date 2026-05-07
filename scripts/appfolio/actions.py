"""
AppFolio Actions Client

Performs WRITE operations against AppFolio's web UI on behalf of an
authenticated user (the bedrock-bot AppFolio user). Cookie-based auth via
SessionManager. Each action is one method that handles the full
GET-CSRF-then-POST dance Rails forms require.

Implemented actions
    notify_tenant_via_email      Send email through a work order

Stubbed actions (need Kampala captures — see CAPTURE_GUIDE.md)
    send_text_via_appfolio       Send SMS via /texting inbox
    assign_vendor                Assign / change vendor on a work order
    edit_work_order              Modify scheduled dates, remarks, etc.
    add_work_order_note          Internal note on a work order

Action methods do NOT make approval decisions. Callers (e.g.
send_approved_drafts.py) are responsible for ensuring the action has been
human-approved before invoking. This module is the pure HTTP layer.
"""

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import httpx


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/142.0.0.0 Safari/537.36"
)


@dataclass
class ActionResult:
    """Outcome of a write action against AppFolio."""
    ok: bool
    status_code: int
    detail: str | None = None
    response_body: str | None = None


# ── HTTP client wrapper ──────────────────────────────────────────────────────


class AppFolioActions:
    """Authenticated write client for AppFolio.

    Auth mode: cookie header from SessionManager (same pattern as sync.py).
    All callers must hold an approval gate upstream — this class doesn't
    track or enforce approvals.
    """

    def __init__(
        self,
        vhost: str,
        cookie_header: str,
        *,
        cookie_provider: Callable[[], str] | None = None,
    ):
        """
        Args:
            vhost: AppFolio host, e.g. 'lapm.appfolio.com'.
            cookie_header: Initial cookie string (used when cookie_provider
                is None).
            cookie_provider: Optional callable returning a fresh cookie
                header. When set, every outgoing request re-reads cookies
                via this callable — required for the Mac Mini setup where
                a session daemon refreshes ~/.appfolio_session every ~30
                min, so long-running workers don't end up using stale
                JWTs that expire after 2h.
        """
        self.vhost = vhost
        self._cookie_provider = cookie_provider
        self._cookie_header = cookie_header
        self.client = httpx.AsyncClient(
            headers={
                "Cookie": cookie_header,
                "User-Agent": USER_AGENT,
            },
            timeout=30.0,
        )

    def _refresh_cookies(self) -> None:
        """Pick up the latest cookies if a provider is configured."""
        if self._cookie_provider is None:
            return
        latest = self._cookie_provider()
        if latest and latest != self._cookie_header:
            self._cookie_header = latest
            self.client.headers["Cookie"] = latest

    async def close(self):
        await self.client.aclose()

    # ── Internal helpers ─────────────────────────────────────────────────

    async def _get_csrf(self, dialog_path: str, *, referer: str | None = None) -> str:
        """GET an AppFolio dialog/form endpoint and pull authenticity_token.

        AppFolio's Rails forms ship a fresh CSRF token each time you open
        the form. We must GET the dialog before POSTing the action, even
        if we already have a token from a previous request.
        """
        self._refresh_cookies()
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
        }
        if referer:
            headers["Referer"] = referer

        resp = await self.client.get(f"https://{self.vhost}{dialog_path}", headers=headers)
        resp.raise_for_status()

        # Dialog endpoints return JSON with an HTML body field, OR raw HTML.
        text = resp.text
        match = re.search(r'name="authenticity_token"\s+value="([^"]+)"', text)
        if not match:
            raise RuntimeError(
                f"Could not find authenticity_token at {dialog_path}. "
                "Session may be expired or path is wrong."
            )
        return match.group(1)

    @staticmethod
    def _format_recipient(name: str | None, email: str) -> str:
        """AppFolio expects: '"Name" <email@example.com>' for recipients."""
        if name:
            return f'"{name}" <{email}>'
        return email

    @staticmethod
    def _format_recipient_list(recipients: Iterable[tuple[str | None, str] | str]) -> str:
        """Accepts either ('Name', 'email@example.com') tuples or raw strings."""
        parts = []
        for r in recipients:
            if isinstance(r, str):
                parts.append(r)
            else:
                name, email = r
                parts.append(AppFolioActions._format_recipient(name, email))
        return ", ".join(parts)

    # ── Implemented actions ──────────────────────────────────────────────

    async def notify_tenant_via_email(
        self,
        *,
        service_request_number: str,
        work_order_id: str,
        recipient: str,
        subject: str,
        body: str,
        bcc: str | None = None,
        send_to_tenant_portal: bool = False,
    ) -> ActionResult:
        """Send an email through a work order's "Notify Tenant" action.

        Captured from kampala session appfolio-2 (POST id
        abece38b-098e-ae9d-0a85-6916486c307a). The email goes out as
        the bot user (display name + signature determined by their AppFolio
        profile), with a tokenized Reply-To routed back through AppFolio.

        Args:
            service_request_number: e.g. "7592" (the SR id, NOT the readable
                "7592-1" display number).
            work_order_id: e.g. "7612".
            recipient: Either a raw '"Name" <email>' string (if you already
                have it formatted) or just an email address.
            subject: Email subject. AppFolio prefills with property + service
                request, but you can override entirely.
            body: Plain-text body. Must include sign-off — see project notes.
            bcc: Optional BCC address.
            send_to_tenant_portal: If True, also surface in the tenant portal.
                Default False — most automation should email-only.

        Returns ActionResult.ok=True on 2xx.
        """
        path = (
            f"/maintenance/service_requests/{service_request_number}"
            f"/actions/notify_tenant/{work_order_id}"
        )
        referer = (
            f"https://{self.vhost}/maintenance/service_requests/"
            f"{service_request_number}/work_orders/{work_order_id}"
        )

        token = await self._get_csrf(path, referer=referer)

        # send_notification_to_tportal is sent as the Rails checkbox idiom:
        # hidden=0 first, then checkbox=1 if enabled. If disabled, only the
        # hidden 0 goes — which Rails treats as the unchecked state.
        form: list[tuple[str, str]] = [
            ("_method", "put"),
            ("authenticity_token", token),
            ("email_options[recipients]", recipient),
        ]
        if bcc:
            form.append(("email_options[bcc]", bcc))
        form.extend([
            ("email_options[subject]", subject),
            ("email_options[body]", body),
            ("email_options[send_notification_to_tportal]", "0"),
        ])
        if send_to_tenant_portal:
            form.append(("email_options[send_notification_to_tportal]", "1"))
        form.append(("commit", "Send"))

        resp = await self.client.post(
            f"https://{self.vhost}{path}",
            data=form,
            headers={
                "X-CSRF-Token": token,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "*/*;q=0.5, text/javascript, application/javascript, "
                          "application/ecmascript, application/x-ecmascript",
                "Origin": f"https://{self.vhost}",
                "Referer": referer,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
        )

        ok = 200 <= resp.status_code < 300
        return ActionResult(
            ok=ok,
            status_code=resp.status_code,
            detail=None if ok else resp.text[:500],
            response_body=resp.text if ok else None,
        )

    # ── Stubbed actions (require Kampala captures) ───────────────────────

    async def send_text_via_appfolio(
        self,
        *,
        normalized_phone: str,
        body: str,
    ) -> ActionResult:
        """Send an SMS through AppFolio's texting inbox.

        STATUS: not implemented — needs a Kampala capture.

        Capture procedure:
            1. Start kampala session.
            2. In AppFolio, navigate to the texting inbox for any phone
               number that already has a thread:
                   /texting/inbox/(310)%20629-0453
            3. Type a short test message (e.g. "test 123") and click Send.
            4. Stop the session, find the POST request that fires when you
               click Send. Inspect its URL, body fields, and any CSRF
               headers. Likely shape: POST /texting/inbox/{phone}/messages
               with body[text], authenticity_token.
            5. Capture a phone with NO existing thread too — sometimes
               there's a "create thread" step before the first send.

        Once captured, follow the notify_tenant_via_email pattern: GET the
        inbox page (to mint CSRF), then POST the form fields.
        """
        raise NotImplementedError(
            "send_text_via_appfolio requires a Kampala capture — "
            "see this method's docstring for the capture procedure."
        )

    async def assign_vendor(
        self,
        *,
        service_request_number: str,
        work_order_id: str,
        vendor_id: str,
    ) -> ActionResult:
        """Assign or change the vendor on a work order.

        STATUS: not implemented — needs a Kampala capture.

        Capture procedure:
            1. Start kampala session.
            2. Open a work order detail page.
            3. Click the "Edit" button (or the inline vendor field).
            4. Change the assigned vendor to a different one. Save.
            5. Stop the session.
            6. The POST/PATCH that fires on save is the request we want.
               Likely a PATCH to /api/work_orders/{id} with a JSON body, OR
               a Rails form POST to /maintenance/service_requests/{sr}/work_orders/{wo}
               with vendor_id in the form data.
            7. ALSO capture: removing the vendor (assigning to "Unassigned"),
               and reassigning back. Edge cases matter.

        Once captured, this method follows the same GET-CSRF-then-POST
        pattern — mirror notify_tenant_via_email's structure.
        """
        raise NotImplementedError(
            "assign_vendor requires a Kampala capture — see docstring."
        )

    async def edit_work_order(
        self,
        *,
        service_request_number: str,
        work_order_id: str,
        fields: dict,
    ) -> ActionResult:
        """Modify a work order — scheduled dates, remarks, instructions, etc.

        STATUS: not implemented — needs a Kampala capture.

        Capture procedure:
            1. Open a work order, click "Edit".
            2. Change ONE field at a time and save (so we know which form
               key maps to which field). Do this for each editable field
               you care about: instructions, remarks, scheduled_start,
               scheduled_end, follow_up_on, follow_up_comments, status_code.
            3. Stop session and inspect the form data on each save POST.

        The PUT will likely be the same /maintenance/service_requests/{sr}/work_orders/{wo}
        path with method override, similar to notify_tenant.
        """
        raise NotImplementedError(
            "edit_work_order requires a Kampala capture — see docstring."
        )

    async def add_work_order_note(
        self,
        *,
        work_order_id: str,
        service_request_number: str,
        note: str,
    ) -> ActionResult:
        """Add an internal note to a work order.

        STATUS: stubbed — sample_api.py has reference implementation in
        add_work_order_note() at line 2092 (uses /notes endpoint with
        parent_type=Maintenance::WorkOrderDecorator). Port that to this
        cookie/httpx client when needed and verify with a fresh capture.
        """
        raise NotImplementedError(
            "add_work_order_note requires porting from sample_api.py + "
            "verification capture."
        )
