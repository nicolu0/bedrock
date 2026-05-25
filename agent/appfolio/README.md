# AppFolio send worker

Option 4 (browser automation) for getting agent messages into AppFolio's
work-order thread. AppFolio has no public **write** API — the Reporting API is
read-only — so we drive a real, logged-in browser. This is Vanessa's
**production** account: lowest-ban-risk path wins, which is why we run a real
persistent browser (not headless replay) and never automate the login.

Decision + options: `.claude/artifacts/2026-05-24-appfolio-send-options.html`.

## Status: STEP 1 — spike only

`worker.mjs` proves we can hold a session and gives us a recon surface. It does
**not** send anything yet. No bridge, no queue, no agent tool until we have real
selectors.

## Setup (once, on the Mac mini)

```
npm i -D playwright && npx playwright install chromium
node agent/appfolio/worker.mjs login     # headed — log in fully (incl. 2FA), press Enter
node agent/appfolio/worker.mjs health     # headless — confirms the session persisted
```

The session lives in `agent/appfolio/.profile/` (gitignored). Re-run `login`
whenever `health` reports LOGGED OUT — that's a rare **human** task.

## The WO comms surface (mapped from recon, 2026-05-24)

WO URL shape: `/maintenance/service_requests/{sr}/work_orders/{wo}`.

Three distinct channels — **not** three copies of one flow:

| Channel | Where | Shape |
| --- | --- | --- |
| **Tenant + vendor free-text** | "Texts" section near the bottom | One widget. `Conversations` dropdown picks the recipient (`Name (Tenant)` / `Name (Vendor)`), one message box (`Enter message`, 910 char cap), one Send. **This is the agent's core channel.** |
| **Vendor dispatch** | Edit form | Assign vendor (typeahead search) + check "Text/Email vendor a secure link" + Save. Structured, sends the WO link — not free text. |
| **Owner** | Actions ▾ menu | "Notify Owner" / "Request Owner Approval". Templated. No free-text SMS channel for owners. |

Implication: tenant and vendor texting collapse into one parameterized send
(recipient = the `Conversations` value). The `Conversations` dropdown is the
wrong-person risk and is enforced as a hard interlock in `send`.

## Sending (dry-run first)

```
node agent/appfolio/worker.mjs send \
  --url "https://lapm.appfolio.com/maintenance/service_requests/<sr>/work_orders/<wo>" \
  --to "Tenant" \
  --message "your text"
# add --live to actually click Send
```

Default is a **DRY RUN**: it selects the recipient, fills the message, screenshots,
and does **not** click Send. Safe against a real WO — nothing transmits without
`--live`. The interlock requires exactly one `Conversations` option to match `--to`,
else it aborts.

> ⚠️ Only ever `--live` against a **decoy** recipient that is one of ours. The recon
> WO (#7666) has a real resident with real message history — dry-run only there.

## Next steps

3. Validate `send` dry-run against the real Texts widget; confirm `Conversations`
   is a native `<select>` (the dry-run aborts loudly if it's a custom dropdown).
4. First `--live` send to a decoy; then owner ("Notify Owner") + vendor-dispatch
   (Edit-form) flows as their own functions.
5. Productionize: localhost JSON-lines bridge (mirror `agent/imessage/helper.mjs`),
   durable queue, pre-send health check, kill switch.
6. Wire to the agent as a gated tool behind the V0 approve gate + eval scenario.
