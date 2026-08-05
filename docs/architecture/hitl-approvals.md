# Human-in-the-Loop approvals

How an action the AI wants to take gets authorised, executed, and reported back
to the customer - and why each guard exists.

Written 2026-07-20, after an end-to-end test round found that "approved" and
"done" were indistinguishable in the data model.

---

## 1. The core distinction

> **A manager approving is not the action happening.**

Two independent states are tracked, and conflating them was the root of every
bug in this area:

| Column | Question it answers |
|---|---|
| `approval_requests.status` | What did the **human** decide? |
| `approval_requests.execution_state` | What did the **system** then do? |

Before this split, a dispatch that failed left an `APPROVED` row identical to a
successful one. Nothing could retry it, nobody could tell it had failed, and
the conversation was un-paused as if all was well.

## 2. State machine

```
                    ┌──────────────────────────────── expired (TTL sweeper)
                    │
   [tool gate] → PENDING ──reject──→ REJECTED         (execution_state stays
                    │                                   NOT_STARTED forever)
                  approve
                    │
                    ▼
                APPROVED
            execution_state:
              NOT_STARTED
                    │  claimForExecution()  (CAS: only NOT_STARTED|FAILED)
                    ▼
                EXECUTING
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
    SUCCEEDED                FAILED ──→ retryable: may be re-claimed
        │                       │
        │                       └──→ conversation handed to a human
        │                            (+ `approval_execution_failed` marker)
        │
        │ claimCustomerNotification()  (CAS: SUCCEEDED && not yet notified)
        ▼
  customer told, exactly once
```

### Transition rules

1. **Every transition is a compare-and-set**, never read-then-write. The route
   previously did `findFirst` → check `PENDING` → `update`; two managers (or a
   double-click, or a web click racing a WhatsApp tap) both passed the check and
   both dispatched, **executing the action twice**. A refund running twice is a
   real-money bug.
2. **Decisions are tenant-scoped in the predicate.** The old helpers accepted a
   `tenantId` and then ignored it, leaving cross-tenant writes fenced only by an
   earlier read.
3. **Expired requests cannot be approved**, even before the sweeper flips them -
   `expiresAt > now()` is part of the approve predicate, so a late tap on a
   stale notification loses.
4. **Only `NOT_STARTED` or `FAILED` may be claimed for execution.** `FAILED` is
   therefore retryable and `SUCCEEDED` can never re-run.
5. **The customer is told only from `SUCCEEDED`**, and only by the caller that
   wins `claimCustomerNotification()` - which writes `customerNotifiedAt` as
   part of its CAS. That is the once-only guard.
6. **Delivery failure ≠ action failure.** If the *message send* fails, the
   notification claim is released so delivery can be retried; the business
   action is **not** re-run.
7. **Execution failure escalates.** The conversation goes to a human with a
   system marker rather than the bot silently resuming.
8. **`LEGACY_UNVERIFIED` is terminal and audit-only.** Rows approved before
   execution tracking existed have an unknown outcome. The original migration
   backfilled them to SUCCEEDED (so the sweeper would never re-run history),
   but that falsified execution history - the Matan Amran approvals provably
   never ran yet read as SUCCEEDED. Migrations `20260720130000/130001`
   reclassify the backfilled shape (attempts=0, no result/error/start
   timestamp) to `LEGACY_UNVERIFIED` and clear phantom `customer_notified_at`
   stamps that have no message row. The state is unreachable by
   `claimForExecution` (claims only NOT_STARTED|FAILED), by the sweeper
   (NOT_STARTED only), by `claimCustomerNotification` (SUCCEEDED only), and
   the retry endpoint answers it with an explicit 409. The inbox renders it
   as "outcome unverified (legacy)".

### Where the code lives

| Concern | File |
|---|---|
| CAS helpers | `packages/shared/src/lib/approval-requests.ts` |
| The one execution path | `runApprovedAction()` in `services/conversation/src/routes/approvals.ts` |
| Expiry sweeper | `services/incoming-worker/src/workers/idle-conversation.worker.ts` |
| Secret redaction | `sanitizeExecutionResult()` (approvals route) |

`execution_result` is persisted and shown in the inbox, so it is redacted
first: any key matching `token|secret|password|api[_-]?key|authorization|
credential|refresh` becomes `[redacted]`, strings are capped, arrays truncated,
and recursion is depth-bounded.

---

## 3. WhatsApp manager approval

Optional, **off by default**, and never the system of record - the approval
always exists in the in-app inbox regardless of what happens on the phone.

### Why the button carries an opaque handle, not a signed token

A WhatsApp reply-button `id` comes back to us on tap and is visible in the
recipient's client, in Meta's logs, and in any message backup. So it carries a
random 24-byte handle (`apv_<48 hex>`) and **nothing else** - no tenant, no
tool, no customer, no decodable JWT. Every fact lives server-side in Redis,
keyed by that handle. (It also stays comfortably inside WhatsApp's 256-char
button-id limit, which a claims-bearing JWT would flirt with.)

Bindings recorded server-side: tenant · approval request · intended recipient ·
the exact decision · the tool · expiry (30 min default).

Consuming is `GETDEL` (atomic) **and revokes the sibling handle**, so a manager
who taps *Approve* cannot also tap *Reject* a second later.

### The six checks on a tap

A tap proves only that *someone holding that phone* pressed a button, so
`services/incoming-worker/src/services/whatsapp-approval-inbound.service.ts`
re-derives everything:

1. handle consumed (single-use, atomic);
2. row still `PENDING` for that tenant;
3. tool matches what the handle was minted for;
4. sender number equals the number we sent to (a forwarded message fails);
5. **authorisation re-checked now** - the person may have been removed,
   demoted, or disabled since the message was sent;
6. decision through the same CAS the web UI uses.

The tap is intercepted **before** contact/conversation creation - a manager's
decision is not a customer conversation, and letting it through would turn a
staff phone number into a customer handed to the bot.

Execution then reuses `runApprovedAction()` via an internal endpoint, so a
phone decision inherits the execution state machine, idempotency and once-only
customer notification rather than growing a parallel implementation.

### Manager configuration requirements

`ApprovalRecipient` (`tenantId + userId + channel` unique). All must hold:

- a row **exists** and is **`enabled`** (off by default);
- `userId` is an **active member of that tenant**;
- the membership holds `approvals:requests:approve` (ADMIN/SYSTEM_ADMIN role
  fallback where the permission set is unlicensed);
- `phoneE164` is valid **international format**;
- the action's risk is within the recipient's `maxRiskLevel`.

> **There is deliberately no fallback to "the owner" or "any admin".** Routing a
> refund approval at whoever happens to be an admin is how the wrong person
> authorises money movement.

**Phone numbers must be entered in `+` international format.**
`Tenant.defaultCountryCode` holds an ISO-2 code (`IL`), *not* a dialling code;
inventing a mapping to expand a bare `0501234567` is how an approval request
for one business gets delivered to a stranger in another country.

**High/critical risk sends no buttons at all** - the manager gets a text telling
them to open GOTCHA, where full context and identity checks apply.

### When it can't send

Skips are a first-class state, not silence. `manager_notify_state` is
`sent | skipped | failed` with a human-readable `manager_notify_reason`, and
the approvals inbox renders an actionable *"WhatsApp approval not sent - Set it
up"* prompt. Distinct reasons: `not_configured`, `disabled`, `no_phone`,
`membership_inactive`, `not_authorized`, `risk_too_high`, plus "no active
WhatsApp channel connected".

### Audit trail

`decisionChannel` (`web` | `whatsapp` | …), `decidedBy`, `decidedAt`,
`decisionReason`, `correlationId`, `executionState`, `executionResult`
(redacted), `executionError`, `executionAttempts`, `customerNotifiedAt`,
`customerMessageId`.

---

## 4. Testing

| Area | Tests |
|---|---|
| State machine (CAS, concurrency, once-only notify) | `packages/shared/src/__tests__/approval-state-machine.test.ts` (13) |
| Opaque handles, single use, sibling revocation, E.164 | `packages/shared/src/__tests__/approval-refs.test.ts` (13) |
| Recipient resolution + re-authorisation | `packages/shared/src/__tests__/approval-recipients.test.ts` (15) |
| Secret redaction | `services/conversation/src/__tests__/execution-result-redaction.test.ts` (5) |

Live-verified on the dev stack: the skip path records an actionable reason, and
recipient resolution advances correctly to the next gate.

**Not verified:** an actual WhatsApp send and tap. There is no real manager
number in dev, and firing a live message at an arbitrary one is the exact harm
this design guards against. That last hop needs a human with a real handset.
