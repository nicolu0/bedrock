# AppFolio Action Capture Guide

How to reverse-engineer a new AppFolio write action (send SMS, assign vendor,
edit work order, etc.) so it can be added to `actions.py`.

The pattern is always the same: Kampala records a real human doing the
action in AppFolio's UI; we read the captured POST/PATCH and codify it.

## One-time setup

1. Kampala desktop app installed and running. Confirm it shows "Recording
   available" or similar before starting.
2. AppFolio open in Arc/Chrome on the same machine (Kampala captures via
   a local proxy).
3. Have the Kampala MCP tools available in your Claude Code session, OR
   browse captures in the Kampala UI.

## The capture loop

For each new action you want to automate:

1. **Start a session** (label it descriptively):
   ```
   create_session(name="capture-<action>-<date>")
   ```
2. **Do the action manually** in AppFolio. Move slowly — every navigation
   is captured, but if you race through, it's harder to identify which
   request corresponds to which click.
3. **Stop the session** as soon as the action completes. Don't keep
   browsing afterward — extra noise to filter out.
4. **Look at the traffic** to find the write request:
   ```
   traffic_overview(session_id=<id>, host="lapm.appfolio.com")
   ```
   Filter: look for `POST` / `PATCH` / `PUT` to a path that names the
   action (e.g. `/actions/`, `/notes`, `/work_orders/`).
5. **Inspect the request**:
   ```
   get_request(id=<request_id>, sections="request_body,request_headers,response_body")
   ```
   Note the path, the form fields (or JSON body), and any required
   headers (`X-CSRF-Token`, `X-Requested-With`, `Origin`, `Referer`).
6. **Find the CSRF source**. Almost always a GET request just before the
   POST that returns HTML containing `name="authenticity_token" value="…"`.
   That GET is what `_get_csrf` in `actions.py` mimics.
7. **Codify** as a new method in `AppFolioActions`. Mirror the structure
   of `notify_tenant_via_email`:
   - GET the dialog/form path → `_get_csrf`
   - POST the action path with form data
   - Return `ActionResult(ok=…, status_code=…, detail=…)`.

## Per-action capture recipes

### SMS via /texting/inbox

1. In AppFolio, open the texting inbox for any phone with an existing
   thread: `/texting/inbox/(310)%20629-0453`.
2. Type a short test message. Send.
3. Stop and inspect the POST that fires on Send.
4. Edge case: also try sending to a phone that has NO existing thread.
   There may be a "create thread" or "first message" endpoint that's
   different from subsequent messages.
5. Map of likely fields: `body[text]`, `authenticity_token`, possibly
   `recipient_phone` or similar.

### Assign / change vendor on a work order

1. Open a work order. Click Edit (or inline-edit the vendor field).
2. Change vendor to a different one. Save.
3. Inspect the PATCH/POST.
4. Also capture: removing vendor (assign to "Unassigned"), adding a
   second vendor if the UI allows it.
5. Likely shape: PATCH `/api/work_orders/{id}` with JSON, OR Rails form
   POST to `/maintenance/service_requests/{sr}/work_orders/{wo}` with
   `work_order[vendor_id]` and a `_method=put` override.

### Edit work order fields

1. Open a work order, click Edit.
2. Change ONE field at a time and save (so you map field → form key
   precisely). Suggested order:
   - `instructions`
   - `remarks`
   - `scheduled_start` / `scheduled_end`
   - `follow_up_on` / `follow_up_comments`
   - `status_code` (Open → Scheduled → Completed)
3. Each save POSTs the same path with different fields populated. Diff
   them to identify which key controls which UI input.

### Add work order note

1. Reference implementation already exists in `sample_api.py`
   (`add_work_order_note`, line 2092). Uses `/notes` endpoint with
   `parent_type=Maintenance::WorkOrderDecorator`.
2. Capture once with current cookies to verify the form fields haven't
   drifted, then port to `actions.py` using the cookie/httpx pattern
   the rest of this module follows.

### Schedule appointment / time slot

1. Open a work order's "Schedule" tab.
2. Pick a date/time. Save.
3. Capture the POST. Likely creates a `work_order_tenant_preferred_time_slots`
   record — we already see those in the work-order JSON include set.

## Things to always check before shipping a new action

- **Response status & body**: 2xx + a redirect or JSON success blob is
  good. 422 with validation errors means we're missing a field.
- **Idempotency**: re-fire the same captured request. Does it create a
  duplicate, or does AppFolio dedupe?
- **CSRF freshness**: a stale token gives 422 or a redirect to the form.
  Always GET the dialog right before the POST, never reuse a token from
  a previous capture.
- **TLS fingerprint**: the User-Agent in `actions.py` matches what we
  observed Arc sending (`Chrome/142.0.0.0`). If AppFolio ever 403s,
  re-capture and update the UA.
- **Reply-To / sender identity**: any field that starts with
  `email_options[from`, `from_name`, etc. — try sending the captured
  POST with those added to confirm AppFolio rejects them. Documents the
  no-spoof guarantee for the file.

## Adding the action to the queue worker

After the action is implemented in `actions.py`:

1. Decide how the bot will signal which action it wants. Today drafts
   only carry `channel='appfolio' | 'email'`. For new actions, add a
   `data.action_kind` field to the draft / activity_log payload (e.g.
   `"sms"`, `"assign_vendor"`).
2. Update `fire_one` in `send_approved_drafts.py` to dispatch on
   `action_kind`.
3. Update the upstream draft-creating code (the bot itself) to set
   `action_kind` when it creates non-email drafts.

Until that wiring exists, every approval is dispatched to
`notify_tenant_via_email` — so don't approve non-email drafts before
this is done.
