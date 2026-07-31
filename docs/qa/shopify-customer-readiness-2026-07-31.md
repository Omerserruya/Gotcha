# Shopify Customer Readiness - HITL lifecycle repair

**Date:** 2026-07-31
**Branch:** `scratch/shopify-live-chat-on-pricing`
**Tenant:** Urban Supply - GOTCHA Demo (`cms4ug98n0004chmrp4lv6ujl`)
**Store:** `urban-supply-gotcha-demo.myshopify.com` (dev/demo store, verified before the first mutation)
**Channel:** WHATSAPP, "Demo WhatsApp" (`cms1pp6n00006nsdtuy55g9sl`, external id `1010938148762991`)
**Test identity:** Matan Amran, `972545680665`

> ## Scope of this document
>
> This covers **Phase 1 (reproduce and repair the HITL lifecycle)** and the parts of
> Phases 4-7 that Phase 1 forced. It is **not** the full 30-scenario readiness
> report that was requested.
>
> **Completed:** the cancellation regression is root-caused, repaired, and proven
> end to end against the live dev store for all three approval outcomes, with two
> further genuine defects found and fixed along the way.
>
> **Not done:** the 30-scenario matrix, the Phase 2 fixture set, the full tool
> capability matrix, and the Layer B/C opt-in regression harness. **No Shopify
> sales-readiness verdict is given**, because a verdict without those scenarios
> would be an assertion, not a finding. See *Remaining work* at the end.

---

## 1. The reported regression, reproduced in live data

Conversation `cms934hdh002h145q8t8polto` (Matan Amran, WhatsApp) held the exact
failure described:

| Field | Value |
|---|---|
| `approval_requests.status` | `APPROVED` |
| `execution_state` | `FAILED` |
| `execution_error` | `shopify_422: Cannot cancel a paid and fulfilled order` |
| `customer_notified_at` | `NULL` - the customer was told **nothing** |
| `conversations.handled_by` | `human` |
| `conversations.is_handed_over` | `true` |
| `conversations.status` | `WAITING` |

Three such rows existed (14:22, 15:03, 15:16 on 2026-07-31), all
`shopify.cancel_order`, all `APPROVED → FAILED`, all with `customer_notified_at`
null. The customer had already been told *"אני מטפלת בבקשה לביטול ההזמנה 1006 עכשיו"*
and then heard nothing further.

---

## 2. Root causes

### RC-1 - The customer continuation was gated on success
`services/conversation/src/routes/approvals.ts`

```ts
const mayNotify = dispatch.ok && (await claimCustomerNotification(tenantId, approvalId));
```

`claimCustomerNotification` in `packages/shared/src/lib/approval-requests.ts`
hard-coded its CAS predicate to `executionState: "SUCCEEDED"`, so a failed
execution could not claim a notification even in principle. A rejected approval
never reached this code at all. **Only the happy path ever spoke to the customer.**

### RC-2 - Handoff was used as a generic error handler
Same file. On any dispatch failure the route unconditionally ran:

```ts
data: { handledBy: "human", isHandedOver: true, status: "WAITING" }
```

The in-code comment admitted the coupling: *"We told them nothing (the
notification is gated on success), so hand the conversation to a human."* One
transient provider error permanently confiscated the conversation from an AI
that still knew the order, the request and the reason.

### RC-3 - Rejection both silenced and escalated
The reject route sent no customer message at all and set
`handledBy:"human", isHandedOver:true`. A declined request was, from the
customer's side, indistinguishable from being ignored.

### RC-4 - `rejected` was not a representable outcome
`ExecutionFacts.outcome` was `"succeeded" | "failed"`. There was no way to say
"a person declined this", so a rejection could only ever borrow failure wording,
which invents a technical problem that did not occur.

### RC-5 - The failure fallback made an unsupported promise
`buildFallbackMessage` said *"נציג מהצוות ממשיך לטפל בזה ויעדכן אותך בהקדם"* - a
claim that a person was engaged, with no task, ticket or notification behind it.

---

## 3. Two further defects found while proving the fix

### D-1 - REST order cancellation is broken on API 2026-07 (**live-verified**)

`POST /orders/{id}/cancel.json` returned:

```
shopify_422: Cannot cancel a paid and fulfilled order
```

for order **#1006**, which reports `fulfillment_status: null`, `fulfillments: []`
and `cancelled_at: null`. The REST message names a state the order is not in, so
no pre-flight guard could anticipate it and the model had nothing true to explain
from. This is what carried an impossible action all the way to a human approval.

**Fixed** by moving the cancel to the supported GraphQL `orderCancel` mutation.
The same order now returns Shopify's real reason:

```
Cannot cancel an order that has outstanding fulfillments
```

`orderCancel` is asynchronous (it returns a Job), so the adapter polls the order
back and only reports success once `cancelled_at` is actually set.

### D-2 - A double-refund that the GraphQL move would have introduced

The old code ran an explicit refund flow after cancelling, because *"the REST
cancel endpoint silently ignores a boolean refund param"*. `orderCancel` honours
`refund: true`, so leaving that call in place would have refunded an order
Shopify had already refunded. The explicit second mutation is replaced by
**verification**: read the financial state back and report `refunded` /
`partially_refunded` / `not_refunded` honestly.

### D-3 - Missing Shopify scopes (open, not fixable in code)

`GET /orders/{id}/fulfillment_orders.json` returns:

```
shopify_403: The api_client does not have the required permission(s).
```

Granted scopes on this connection:

```
read_all_orders, read_customers, write_customers, read_price_rules,
write_price_rules, read_discounts, write_discounts, read_draft_orders,
read_orders, write_orders, read_product_feeds, read_product_listings,
read_products, read_returns
```

**Missing:** any fulfillment scope
(`read_merchant_managed_fulfillment_orders`, `read_assigned_fulfillment_orders`,
`read_fulfillments`), plus `write_returns` and `read_inventory`.

Consequence: **GOTCHA cannot see fulfillment state on this store.** The legacy
`fulfillment_status` / `fulfillments` fields read as "unfulfilled" for an order
Shopify considers to have outstanding fulfillments. This is the upstream cause of
the whole incident, and it also compromises any tracking, ETA, missing-item or
cancellability scenario until the scopes are granted.

The adapter no longer hides this: an unreadable fulfillment read returns
`has_outstanding_fulfillments: null` (not `false`) plus
`fulfillment_orders_readable: false`. "We cannot see" must never render as
"there are none".

---

## 4. The repair

### Shared (`packages/shared/src/lib/approval-requests.ts`)
`claimCustomerNotification(tenantId, id, outcome)` now takes a
`ContinuationOutcome` (`succeeded | failed | rejected`) and asserts, in the CAS
predicate, that the row genuinely **is** in that state:

| outcome | predicate |
|---|---|
| `succeeded` | `status: APPROVED, executionState: SUCCEEDED` |
| `failed` | `status: APPROVED, executionState: FAILED` |
| `rejected` | `status: REJECTED` |

So no caller can announce a cancellation for a row that failed. The
cross-row `operationKey` sibling guard is now scoped to `succeeded` only -
refusing to speak because another row once spoke is how a customer never hears
that *this* request was declined.

### Conversation (`services/conversation/src/routes/approvals.ts`)
- One reusable `sendApprovalContinuation()` for all three outcomes, so rejection
  cannot drift from success in delivery, dedup or audit rules.
- `toCustomerSafeReason()` collapses raw dispatch errors into a small class
  vocabulary. No provider string, status code or stack ever reaches a customer.
- `recordFailureAndMaybeEscalate()` replaces the reflex handoff. The system
  message is always written for the inbox; **ownership** is conditional:
  escalate only at `executionAttempts >= 2`, and never for `already_done`.
- Rejection keeps the AI (`handledBy: "ai_agent"`), unless a human had already
  taken the conversation over.
- Degrades to a plain true sentence, never silence, if the AI service is down.

### AI (`grounded-message.service.ts`, `ai-bot.service.ts`)
- `rejected` is a first-class outcome end to end.
- The validator holds rejection to the same bar as failure
  (`rejection_presented_as_success`).
- **New `internal_reason_leaked` rule** - see the live regression below.
- Reason classes are translated to plain sentences (`REASON_PHRASES`) before
  generation; the raw token is never given to the model.
- The failure fallback no longer claims a person is already handling it.

### Adapter (`shopify.adapter.ts`)
- GraphQL `orderCancel` + async job + read-back verification.
- No second refund call.
- `fetchFulfillmentOrders()` / `hasOutstandingFulfillments()`, with denial
  distinguished from absence.

---

## 5. A regression caught *during* live verification

The first live failure run produced this to a real customer record:

> היי מתן, ניסיתי לבטל את ההזמנה 1006 אבל הבקשה נכשלה **(סיבה: unknown)**...

Two defects: `toCustomerSafeReason` did not match "outstanding **fulfillments**"
(it matched only `fulfilled|shipped|dispatched`) so it fell through to
`unknown`; and the raw class token was handed to the model as a verified fact,
which it faithfully printed.

Both fixed - the classifier now matches `fulfil`, reason classes are translated
before generation, and `validateGroundedMessage` rejects any message containing
an internal token or provider code. Re-run output:

> היי מתן, ניסיתי לבטל את ההזמנה 1006 אך הבקשה נכשלה **כי ההזמנה כבר נמסרה לטיפול המשלוח**.
> אפשרויות מעשיות עכשיו הן לסרב לקבל את המשלוח כשיגיע או להחזיר את המוצר אחרי קבלתו.
> רוצה שאסביר איך לסרב לקבלה כשיגיע או שאנחה אותך בתהליך ההחזרה?

Truthful, no internal vocabulary, names the real obstacle in customer language,
offers only supported alternatives, makes no promise about a person or a courier.

---

## 6. Live evidence - the four-proof chain

The requirement was four **separate** proofs per action, not "the tool returned ok".

### Approved and successful - order #1008

| Proof | Evidence |
|---|---|
| 1. הפעולה אושרה | `qa_live_cancel_1008`, `status=APPROVED`, `decided_by=qa-operator` |
| 2. בוצעה ב-Shopify | dispatch `executed: true`; `cancelled_at=2026-07-31T12:03:05-04:00` |
| 3. המצב נקרא ואומת | independent re-read: `#1008 cancelled_at` set, `cancel_reason=customer` |
| 4. הודעה נשלחה אוטומטית | `ההזמנה #1008 בוטלה בהצלחה.` - `DELIVERED`, no new inbound needed |

Persistence: `execution_state=SUCCEEDED`, `execution_attempts=1`,
`customer_notified_at` set, `customer_message_id=cms94tacq00027nb2ek8245zk`,
message metadata `{source: approval_continuation, outcome: succeeded}`.
**Ownership after:** `handled_by=ai_agent`, `is_handed_over=false`, `status=OPEN`.

### Approved but failed - order #1006

| Proof | Evidence |
|---|---|
| 1. אושרה | `qa_live_fail_1006_b`, `APPROVED` |
| 2. בוצעה | dispatch `executed: false`, `cancel_rejected: Cannot cancel an order that has outstanding fulfillments` |
| 3. נקרא ואומת | `#1006 cancelled_at` still `null` - no false success |
| 4. הודעה נשלחה | the Hebrew failure message in §5, `outcome: failed` |

`execution_state=FAILED`, `customer_notified_at` set.
**Ownership after:** `handled_by=ai_agent`, `is_handed_over=false` - no reflex handoff.

### Rejected

Covered by 6 route-level tests
(`services/conversation/src/__tests__/approval-rejection-continuation.test.ts`):
claim made for the `rejected` outcome, exactly one message created and queued,
message linked for audit, conversation left with the AI, human-owned
conversations not resumed, a lost decision race sends nothing (409), a repeated
rejection cannot double-notify, and a reason is still mandatory.

**Not verified live** - the reject route sits behind `authenticate` and needs a
real user session, which was not established in this run.

### Shopify mutations performed on the dev store

| Order | Action | Result |
|---|---|---|
| #1007 | `cancel_order` (direct adapter probe) | cancelled `2026-07-31T12:02:00-04:00` |
| #1008 | `cancel_order` (full HITL chain) | cancelled `2026-07-31T12:03:05-04:00` |
| #1006 | `cancel_order` ×3 (REST then GraphQL) | refused every time, order unchanged |

No other order, tenant or store was touched. No refunds were issued.

---

## 7. Tests

| Suite | Command | Result |
|---|---|---|
| shared typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| conversation typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| ai typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| conversation suite | `npx vitest run` | 1 failed / 63 passed - **at baseline** |
| ai suite | `npx vitest run` | 24 failed / 1774 passed - **at baseline** |

Baselines were measured by stashing the changes and re-running:
conversation `1 failed / 54 passed`, ai `24 failed / 1765 passed`. The single
conversation failure is the pre-existing `identity.test.ts > merge combines tags
and deletes source`; the 24 ai failures are the known pre-existing baseline. Net
effect of this work: **+19 passing tests, no new failures.**

New / updated coverage:
- `approval-dispatch-routing.test.ts` - 13 tests (was 10)
- `approval-rejection-continuation.test.ts` - 6 tests (new file)
- `approvals-dispatch.test.ts` - failure contract corrected
- `grounded-message.test.ts` - 23 tests (was 15)
- `cancel-fulfilled-order.test.ts`, `shopify-tool-parity.test.ts`,
  `shopify-adapter-execution.test.ts` - moved to the GraphQL contract

---

## 8. State transitions now implemented

```
AI_ACTIVE → WAITING_FOR_APPROVAL → APPROVED_EXECUTING → AI_ACTIVE          (success)
AI_ACTIVE → WAITING_FOR_APPROVAL → REJECTED           → AI_ACTIVE          (rejection)
AI_ACTIVE → WAITING_FOR_APPROVAL → APPROVED_EXECUTION_FAILED → AI_ACTIVE   (attempt 1)
                                                            → HUMAN_HANDOFF (attempts >= 2,
                                                               and reason != already_done)
```

Every arrow emits exactly one customer continuation, claimed by CAS.

---

## 9. Remaining work (not done in this pass)

1. **The 30 customer scenarios.** None were run through the real inbound webhook
   path. Only the cancellation lifecycle (scenarios 12/14-adjacent) is proven.
2. **Phase 2 fixture set.** Only 5 orders exist for Matan (#1006-#1010), all
   `paid`/unfulfilled; #1007 and #1008 are now cancelled. The states the brief
   asks for (partially fulfilled, refunded, payment pending/failed, tracking
   present/absent, discount code, preorder) do not exist and were not created.
3. **Phase 6 tool capability matrix.** The adapter exposes ~50 tools; only
   `get_orders`, `get_order`, `get_customer_orders`, `get_fulfillment_status`
   and `cancel_order` were exercised here.
4. **Phase 7 Layer B/C harness** (`SHOPIFY_DEV_E2E=true` with an allowlist guard)
   is not built.
5. **Refunds were never executed live.** Full, partial, over-maximum and
   duplicate refund behaviour is unproven against this store.
6. **D-3 scopes must be granted** before any fulfillment, tracking, ETA or
   cancellability scenario can be answered honestly.
7. **Pre-existing:** an older bot message on this conversation contains an
   em-dash (*"היי, מבינה — אני מטפלת..."*), which violates the no-em-dash rule.
   It came from the `bridge_ack_for_approval` path, which was not touched.

## 10. Verdict

**No Shopify sales-readiness verdict.** The specific regression that blocked the
release is fixed and proven; the evidence required to call the product ready for
merchants has not been gathered.
