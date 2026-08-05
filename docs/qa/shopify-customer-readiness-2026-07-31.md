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
   em-dash (*"היי, מבינה - אני מטפלת..."*), which violates the no-em-dash rule.
   It came from the `bridge_ack_for_approval` path, which was not touched.

---

# Part 2 - Scenarios run through the real inbound webhook

Everything below was driven by a **signed WhatsApp webhook** as Matan Amran
(`972545680665`), the way a real customer message arrives. No service was
called directly except to verify Shopify state afterwards.

## Result matrix

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Latest order status | **PASS** | #1010 named, paid + unfulfilled, no HITL |
| 2 | Order by name `#1009` | **PASS** | resolved as a NAME, not an internal id |
| 3 | Product search by use case | **PASS** | real products/prices/links, after the "unknown attribute" fix |
| 4 | Budget search ("עד 800 שקל") | **PASS** | after the currency fix; states prices are USD and declines to compare |
| 6 | Variant / size 159 | **FAIL** | tool now reaches the model, but the reply is still a product list, not a variant answer |
| 8 | "איפה המשלוח שלי?" | **PASS** | after the discovery-hijack fix |
| 9 | No ETA available | **PASS** | "טרם נשלחה ולכן אין מספר מעקב" - no invented date |
| 12 | Cancel eligible order + approve | **PASS** | #1008 and #1009 cancelled in Shopify, verified by read-back |
| 13 | Reject a cancellation | **PASS** | proactive rejection message, #1010 unchanged, AI retained |
| 14 | Cancel a fulfilled order | **FAIL** | approval still raised - see "missing scopes" |
| 15 | Cancel an already-cancelled order | **PASS** | no approval raised, correct answer |
| 16 | Full refund | **PASS** | 2799.80 USD on #1010, Shopify reads `refunded` |
| 20 | Duplicate refund | **PASS** | `already_refunded: true`, no second money movement |
| - | Approved-but-failed | **PASS** | verified live twice (#1006 cancel, #1006 refund) |

**12 of 30 scenarios verified. 2 fail. 16 were not run.**

## Defects found and fixed in this part

1. **Currency taken from the shopper's budget.** `const currency =
   budget?.currency` labelled a $749.95 board "ILS 749.95" - the store's number
   wearing the customer's currency, understating it about fourfold. Currency now
   comes from `get_shop`; a cross-currency budget produces no comparison at all.
2. **Discovery hijacked every turn.** Readiness is sticky and the caller turns
   it into a hard OpenAI `toolChoice`, so once a shopper had ever discussed
   products, *every* later turn was pinned to `search_products`. "Where is my
   shipment?" returned a catalogue. This one silently broke most support
   scenarios. The forced search is now worth one turn.
3. **The 128-tool cut was alphabetical.** It removed
   `shopify.variant_information` and `shopify.validate_discount` while keeping
   `list_segments`, which is not even supported over REST. Tools now declare a
   priority.
4. **Approvals raised for impossible actions.** Cancelling an already-cancelled
   order produced "מטפלת עכשיו בביטול" and a PENDING approval. Adapters can now
   answer "is this still possible?" before a human is asked.
5. **Rejection on WhatsApp told the customer nothing** - the continuation lived
   only in the web route. Both channels now share one endpoint.
6. **Conversations froze at `awaiting_approval`** after an internally-dispatched
   approval; the incoming-worker does not treat that as bot-owned, so the
   customer's next message got no reply.
7. **A rejection named the wrong order** (#1007 for a rejected #1010) - with no
   provider result the model took an order number from history.
8. **Internal vocabulary reaching customers**: `(סיבה: unknown)`, a bare
   `refunded` enum inside Hebrew, `המטבע USD` with no amount, and an em dash in
   the approval acknowledgement.
9. **The pending-approval ack claimed work was underway** ("מטפלת עכשיו
   בביטול") when it was awaiting a decision - the same false promise that made
   the original silent failure so damaging.

## The two failures, and why

**S6 (variant/size).** `variant_information` now survives truncation, but the
model still answers with a product list. The typed product path takes over
whenever `search_products` runs and appends a deterministic candidate list,
which drowns a narrow question. Not fixed.

**S14 (cancel a fulfilled order).** The precheck reads
`fulfillment_status`/`fulfillments`, which for #1006 report *unfulfilled* while
Shopify refuses with "Cannot cancel an order that has outstanding
fulfillments". The truth is only in `fulfillment_orders`, which returns
**403 - the connection has no fulfillment scope**. This cannot be fixed in
code. It degrades safely (honest failure message, no handoff), but the approval
is still spent.

## Environment notes

- The agent's `maxAutonomousMessages` was **10**, which ended the test
  conversation with an automatic handoff mid-run. Raised to 500 on the dev
  agent to continue testing. **A real merchant on the default would see
  frequent handoffs.**
- **Long conversations anchor on an earlier order.** After the #1006 refund
  failed, explicit corrections ("שכח מ1006... 1010 בלבד") could not move the
  bot off #1006. A fresh conversation resolved #1010 immediately. Real bug,
  not fixed.

## Dev-store mutations in this part

| Order | Action | Final state |
|---|---|---|
| #1007, #1008 | cancelled | `cancelled_at` set |
| #1009 | cancelled + refunded | `cancelled_at` set, refunded |
| #1010 | full refund 2799.80 USD | `financial_status: refunded` |
| #1006 | 3 cancel attempts, 1 refund attempt | unchanged - Shopify refused every one |

No other tenant or store was touched. Nothing was pushed, merged or deployed.

---

---

# Part 3 - After the scopes were granted (2026-08-01)

The operator granted the fulfillment, inventory and returns scopes and
reconnected the store. That unblocked the data - and immediately exposed a
worse problem underneath it.

## The reconnect broke the assistant

Reconnecting is the ONLY way to grant new scopes, and it left the store
`CONNECTED`, capability-probe green, every scope present - and the AI holding
**7 tools**: escalate, close, and identity verification. All 62 Shopify tools
were gone.

The tool surface is built from `AgentToolPermission` rows, and those were
provisioned in exactly one place: the "use this integration as CRM" UI toggle.
**Connecting never created them**, so a disconnect/reconnect deleted them for
good. Three health signals said the connection was fine, because all three ask
about the *connection*. None asked whether the assistant could do anything.

What the AI did with 7 tools is worth recording: asked about a size it asked
which colour (asking was all it had), and asked to cancel an order it escalated
with *"system tooling for cancellation unavailable in chat"* - which was **true**,
and read like a model defect.

Fixed at the point connection state is written, so it covers every connector and
every OAuth path. Reads only; rows an operator turned off stay off.

## Defects found and fixed in Part 3

| # | Defect | Effect before |
|---|---|---|
| 1 | Reconnect wiped tool permissions | Store healthy, AI toolless |
| 2 | Fulfillment read from legacy fields | Orders in fulfillment read as unfulfilled |
| 3 | "Cannot see" rendered as "none" | A missing scope answered "no tracking exists" |
| 4 | Order anchoring | An explicit correction could not move the bot off a stale order |
| 5 | `variant_information` needed an ID | Size questions answered with a catalogue or a question |
| 6 | Variant intent routed to RESOLVE_ISSUE | Support persona diagnosed instead of looking up |
| 7 | **Whole catalogue reported in stock** | A zero-quantity product offered as available |
| 8 | "Team is handling it" with nothing behind it | Reads as resolution; customer stops chasing |
| 9 | Autonomy counter charged approval waits | Cancellation flows burned budget on a designed pause |

**#7 is the one to note.** `deriveInventoryState` decides tracked-vs-untracked
from `inventory_management`; the GraphQL search does not emit that field; absent
took the permissive branch; permissive means "always available". Nothing errored.

## Scenario results (Part 3)

| # | Scenario | Result |
|---|---|---|
| 6 | Exact variant / size 159 | **PASS** - "נמכר בגרסה אחת בלבד (אין מידות שונות) וכרגע במלאי" |
| 7 | Out of stock + restock | **PASS** - "לא במלאי כרגע", no invented restock date |
| 8/9 | Tracking / no-ETA | **PASS** - `tracking_state` distinguishes available / not_yet / none / unknown |
| 14 | Cancel a fulfilled order | **PASS** - refuses, offers return+refund, **no approval raised** |
| 19 | Refund above maximum | **PASS** - read the real total, refused 5000 on a 785.95 order, no approval |
| 18 | Partial refund | **UNSUPPORTED (fixture)** - adapter refused: "only 0.00 USD is refundable" |
| - | Order anchoring | **PASS** - "שכח מ-1006 ... רק 1010" → "נטוש 1006 ואעבוד רק על 1010" |

**Partial refund is still unproven.** Every Matan order is now cancelled,
refunded, or in fulfillment; none has a refundable balance. The system behaved
correctly (refused, persisted FAILED, told the customer honestly, mutated
nothing) - but the happy path was never exercised.

## Scope matrix (derived from what the code actually calls)

| Capability | Endpoint | Scopes | Status |
|---|---|---|---|
| Order lookup / status | `GET /orders` | `read_orders`, `read_all_orders` (>60d) | granted |
| Fulfillment / tracking | `GET /orders/{id}/fulfillment_orders` | `read_merchant_managed_fulfillment_orders`, `read_assigned_fulfillment_orders` | granted |
| Cancellability precheck | as above + `orderCancel` | `read_merchant_managed_fulfillment_orders` + `write_orders` | granted |
| Cancel | GraphQL `orderCancel` | `write_orders` | granted |
| Refund | `POST /orders/{id}/refunds` | `write_orders` | granted |
| Stock / variants | `GET /products`, GraphQL search | `read_products`, `read_inventory` | granted |
| Customers, tags, notes | `GET/PUT /customers` | `read_customers`, `write_customers` | granted |
| Discounts / coupons | `/price_rules`, `/discount_codes` | `read_price_rules`, `write_price_rules`, `write_discounts` | granted |
| Return status | GraphQL `returns` | `read_returns` | granted |
| Create a fulfillment | `POST /fulfillments` | `write_merchant_managed_fulfillment_orders` | **not granted, not requested** |
| Create an RMA | GraphQL `returnCreate` | `write_returns` | granted but **no tool uses it** |

Deliberately not requested: `write_fulfillments`, `write_draft_orders`,
`read_draft_orders`, third-party fulfillment writes. Nothing calls them.

**The OAuth request list was the real risk**: it asked for 8 scopes and none of
the fulfillment ones, so every merchant onboarding through the normal flow would
have reproduced this store's original blocker, silently.

---

---

# Part 4 - Partial refund proven, and the rest of the scenarios (2026-08-01)

Fixture **#1011** created manually: paid, unfulfilled, not cancelled, 785.95 USD,
one line item (The Compare at Price Snowboard), Matan Amran +972545680665.
Resolved by phone (`customer 27711594201457`) and by order name.

## Partial refund - proven end to end

| Step | Evidence |
|---|---|
| 200 USD refund | `refund_id 1145460949361`, processed |
| 150 USD via full HITL chain | approval `cmsauwzzu…` → `SUCCEEDED`, attempts 1 |
| Proactive message | *"החזר חלקי של 150 USD עבור ההזמנה #1011 טופל בהצלחה"* |
| Ownership after | `ai_agent`, `is_handed_over=false`, OPEN |
| **Shopify read-back** | `partially_refunded`; refunds `200.00` + `150.00`; tx `status: success` |
| Duplicate dispatch | `execution_already_in_flight`, refund count unchanged |
| Exactly one continuation | 1 row with `source=approval_continuation` |
| Remaining balance | 500 refunded → 500 USD request refused: *"only 285.95 USD is refundable"* |

Edge cases (unit): amount 0, negative, non-numeric → `refund_amount_invalid`;
decimal `12.34` exact; currency mismatch → `refund_currency_mismatch`; above
ceiling → `refund_exceeds_refundable`; partial-after-partial proven live.

### Why it had never worked

An amount-only refund names no line items, so the calculate call was sent
`{currency}` and nothing else - **asking Shopify to price a refund of nothing**.
It answered `0.00`, and `0.00` became the ceiling every request was measured
against. Partial refunds have never worked on any order.

Two more defects had to be cleared to reach it:

1. **`unknown_provider:shopify` on the entire adapter-backed surface.**
   Endpoint-less catalog tools route to the adapter through a DYNAMIC import,
   which resolves to a second module instance with an empty registry. The bot
   concluded order #1011 did not exist and escalated a refund to a human.
   Third occurrence of this trap; `tool-registry.ts` already carried the warning.
2. **`get_order` returned the raw Shopify payload** - thousands of tokens, and a
   turn that read one order produced **no reply at all**, silently. It also
   carried `browser_ip`, `checkout_token` and an `order_status_url` with a live
   `authenticate?key=` into the prompt.

## Scenario results (Part 4)

| # | Scenario | Result |
|---|---|---|
| 18 | Partial refund | **PASS** |
| 20 | Duplicate refund | **PASS** |
| 19 | Refund above maximum | **PASS** |
| 22 | Exchange | **PASS** - used the variant lookup, explained *why* no exchange exists |
| 23 | Damaged item | **PASS** - gathers evidence, no false claim |
| 24 | Wrong item | **PASS** - real line item, honest state |
| 27 | Resend confirmation | **PASS** - "I can't send it from here", offers real alternatives |
| 10 | Address change (pre-fulfilment) | **UNSUPPORTED** - handed off; no approval raised |
| 11 | Address change (post-fulfilment) | **UNSUPPORTED** - same path |
| 21 | Return request | **UNSUPPORTED** - `returns_count: 0`, no fake RMA, handed off |
| 28 | Invoice | **UNSUPPORTED** - Shopify `406`; honest failure, no provider code, AI retained |
| 30 | Proactive shipment update | **UNSUPPORTED** - false promise now blocked |
| 25 | Missing item | **BROKEN** - demanded identity verification despite an established identity |
| 29 | Coupon | **BROKEN** - garbled reply, wrong gender, delegation claim |
| 26 | Order note/tag | **BROKEN** - never calls `create_note`; false claim now stripped |

## The honesty net, and what it kept catching

Four separate rounds against the same class of lie, each one a new phrasing:

| Claim | Phrasing that slipped through | Reality |
|---|---|---|
| delegated | "אעביר את **הבקשה** לצוות" | nothing engaged |
| delegated | "אעביר את **המצב** לצוות" | noun allowlist too narrow |
| delegated | "אעביר את **הפרטים** לצוות שילווה אותך" | narrower still |
| performed | "**ביצעתי** את הבקשה" | `note: null, tags: ""` |
| performed | "בקשתך **עודכנה** בהזמנה" | passive voice, same lie |
| followup | "**אשמח לעדכן** ברגע שייווצר שינוי" | 0 scheduled records |

The allowlist approach lost every round. The patterns now match the *shape* of
the promise rather than the nouns, and the three most damaging shapes are
**stripped from the reply** instead of merely audited. One exemption is
deliberate: a turn parked at an approval may promise an update, because the
system guarantees exactly one continuation.

A trap worth keeping: the first Hebrew pattern used a trailing `\b`, and Hebrew
letters are not `\w`, so the word boundary never matched and the whole group
silently never fired. A regex that matches nothing looks exactly like a regex
that finds nothing.

## maxAutonomousMessages

Default **10 → 30**, for newly created employees only (schema default +
creation paths + a migration that touches `DEFAULT` and no configured value).
The decision is now a pure `assessAutonomyBudget()` with an `approaching` state
one reply before the wall. The counter was already narrowed to AI-authored
customer replies; the approval acknowledgement and the post-decision
continuation are both excluded, so waiting on a manager costs nothing.

## Dev E2E harness

`scripts/shopify/dev-e2e.mjs`, opt-in behind `SHOPIFY_DEV_E2E=true`. Refuses
unless NODE_ENV is not production and the tenant (checked by **name** as well as
id), shop domain, WhatsApp channel and customer phone are all allowlisted -
as literals in the file, because an env var is what gets set wrong on the day
someone points it at a merchant. Commands: `say`, `scenario`, `approvals`,
`approve`, `reject`, `order`, `state`, `fixtures`. Both refusal paths verified.

---

## 10. Verdict

**(superseded - see the Part 4 verdict below)** Not ready to sell, but materially closer. The HITL lifecycle is proven on
all three outcomes; both previously-failing scenarios (S6 variant, S14 fulfilled
cancel) now pass; order anchoring is fixed deterministically; and nine further
defects were found and fixed, including a catalogue that reported every product
in stock.

What still blocks a sales claim: **partial refund is unproven** (no fixture with
a refundable balance), **11 scenarios remain unrun** (returns, exchange, damaged,
wrong item, missing item, note/tag, resend, invoice, coupon, proactive update,
address change), the **permanent Dev E2E harness was not built**, and the
**`maxAutonomousMessages` default of 10 is unchanged** pending a product
decision.

The reconnect defect deserves separate weight: it was invisible to every health
signal we have, and it is on the mandatory path for granting scopes. Any
merchant who reconnects today gets a green connection and a mute assistant.


---

## 11. Verdict after Part 4

**Still not ready to sell, but the money path is now proven.**

Partial refund, duplicate prevention and remaining-balance arithmetic all work
live and are confirmed by independent Shopify reads. Every HITL outcome sends
exactly one continuation. Every mutation is read back. No raw provider error
reaches a customer.

What blocks the claim:

1. **Three BROKEN scenarios** - note/tag never calls its tool, coupon produces a
   garbled reply, missing-item demands identity verification it does not need.
2. **Six UNSUPPORTED capabilities** merchants will expect: address change,
   returns/RMA creation, exchanges, invoice send, proactive shipment updates.
   All are handled honestly, none fakes an action - but a merchant evaluating
   GOTCHA will ask for them.
3. **The honesty net is a net, not a fix.** It reliably stops the model claiming
   things that did not happen, and it had to be widened four times in one
   session. The underlying behaviour - a model that narrates actions it never
   took - is unchanged; we are catching it, not preventing it.

The first is a day's work. The second is a scoping decision. The third is the
one worth thinking about before selling this.

---

---

# Part 5 - The self-service capabilities, and what building them exposed (2026-08-02)

Ten phases of scope: coupons out, missing items, self-service profile changes,
order address changes, exchanges, returns, documents, a structured outcome
contract, order notes, and a rerun of everything through the real signed
WhatsApp webhook.

The capabilities are the smaller half of what follows. The larger half is that
building them exposed a class of defect the previous four parts never hit,
because the previous four parts were about a bot claiming things it had not
done. This one is about the opposite.

## The inverse failure

Five separate defects, all found by running the scenarios live, all of the same
shape: **a real change reported as a failure.**

| # | Where | What the customer was told | What had happened |
|---|---|---|---|
| 1 | `extractExternalRef` | "I couldn't add the note" | the note was on the order |
| 2 | outcome contract's parser | "I couldn't add the note" | the ledger had committed it |
| 3 | self-scope selector | "nothing to update" | the customer had just confirmed the change |
| 4 | address verifier | (would have said) "it didn't go through" | street, city and zip were all correct |
| 5 | approval continuation | *nothing at all* | the action had run |

This matters more than a symmetrical list of bugs. A false success is produced
by a model improvising; a false failure is produced by the machinery built to
catch the model, and it arrives with that machinery's authority. It is also
much harder to notice: nobody complains that the bot was too cautious.

The causes are worth naming individually, because each is a different way of
being wrong about the same thing - the shape of a tool result.

**`extractExternalRef` never looked inside `output`**, which is the envelope
every integration tool returns. So no adapter tool had ever produced a real
external ref; all of them logged `LEDGER_GAP`; every one was recorded as
`succeeded_unverified`, meaning "deduped, but not confidently claimable". The
explicit-`externalRef` branch also searched fewer scopes than the key fallback,
so a handler that did exactly what the warning asked for was still missed.

**The outcome contract's own parser read the raw tool fields**, and
`toolCallLog` carries the wrapper. `note_added` was one level down, the fact
block therefore said nothing had happened, and the model faithfully relayed it.

**The self-scope selector was merged into the tool arguments**, where on
`update_my_profile` the arguments *are* the new values. An injected
`{ phone: … }` is indistinguishable from "set my phone to this"; an injected
`{ customer_id: … }` was rejected by the field validator, which then reported
`nothing_to_update`.

**The address verifier treated Shopify's country normalisation as a mismatch.**
"ישראל" is stored as "Israel". Everything else about the write was exactly
right.

**And the approval continuation derived its outcome from `dispatch.ok` alone**,
so it told the customer their address had changed while the result beside it
said `verified: false`. Fixing that in the continuation alone then produced a
*worse* bug for one build: `claimCustomerNotification` asserts the row really is
in the outcome being claimed, so persisting `SUCCEEDED` and claiming a `failed`
continuation matched nothing and the customer got **no message at all** - the
exact silent failure Part 1 exists to end, reintroduced from the other side.

## Silence is not an outcome

A turn can end with no text whatsoever: the model spends its round on tool calls
and returns nothing. Every guard downstream is satisfied, because there is
nothing to object to.

Part 4 recorded this once - "a turn that read one order produced no reply at
all, silently" - and fixed the payload that caused it. It recurred here on a
different pair of reads (`get_order_items` + `variant_information`), which says
the shape of that fix was too specific. There is now a terminal net: a turn that
produces nothing, and is neither an escalation nor an approval pause, sends a
sentence that admits only what is certainly true and offers a person.

## The scope list was a comment about the past

The exchange reached the live store, passed eligibility, quoted the price, took
a human's approval, and failed at `orderEditBegin`:

```
Requires `write_order_edits` access scope
```

Four things had to be wrong at once for a missing scope to get that far:

1. `exchange_order_item` did not declare it, so the capability gate saw a store
   that could do this and never short-circuited.
2. The connection test did not ask for it, so the merchant was never told.
3. The OAuth request list did not include it, under a comment reading *"no tool
   edits an order"* that had outlived the fact by one commit. The same note
   excluded `write_returns`, which `create_return` needs.
4. The GraphQL denial handler appended *"re-connect Shopify to grant the
   read_returns scope"* to **every** access-denied error, because it was written
   when returns were the only GraphQL surface. An `orderEdit` refusal told the
   operator to grant an unrelated scope they already had.

Part 3 called the OAuth request list "the real risk". It was right, and the
mechanism is worse than a missing entry: the list carried prose about what tools
did *not* exist, and prose does not fail a build when it stops being true.

## Capabilities built

| Capability | Tool | How it refuses |
|---|---|---|
| Missing item | `reconcile_order_items` | names the item, or asks only when genuinely ambiguous |
| Own profile | `update_my_profile` | **no customer selector in its schema at all** |
| Order address | `update_order_shipping_address` | fulfillment orders, three-valued; unknown never edits |
| Exchange | `exchange_order_item` | same price only; any gap is a person's job |
| Return | `create_return` | nothing shipped, nothing to return |
| Documents | `document-request.service` | a tax invoice is not an order summary |

Two design notes carry most of the safety.

**Ownership is answered by construction, not by checking.** `update_my_profile`
has no `customer_id`, `email` or `phone` selector. The guard derives the record
from the authenticated channel and strips anything selector-shaped the model
sent - stripping rather than rejecting, because a rejection teaches the model to
retry with a different guess while a substitution means the guess never
mattered. A model cannot get ownership wrong when ownership is not one of its
arguments.

**Money stops the exchange before anything is written.** A Shopify order edit
does not settle itself: a dearer variant leaves the order owing, a cheaper one
leaves the shop owing, and no customer-facing payment flow exists to close
either. Both are refused *before* `orderEditBegin`, because an aborted order
edit still exists as a calculated order. The tempting alternative - commit, then
chain a refund - would manufacture a compensation mechanism out of two separate
approvals.

## The Customer Outcome Contract

The honesty net was widened four times in one session, each round against a new
phrasing of the same lie. The allowlist lost every round; matching the *shape*
of a promise won the last one and will lose eventually too, because a regex over
output can only describe lies somebody has already seen.

The deeper problem was what "supported" meant. `turnHasExecutionEvidence`
answers *did any tool execute*, so reading an order was evidence for "I have
changed your address". The claim and the evidence were never about the same
thing.

Now each claim names the facts that would make it true:

| Claim | Requires |
|---|---|
| "שיניתי את הכתובת" | `shippingAddressUpdated` |
| "החלפתי את המידה" | `exchangeCompleted` |
| "פתחתי החזרה" | `returnCreated` **and** a `returnId` |
| "פניתי לצוות" | a handoff, task or notification that succeeded |
| "שלחתי את החשבונית" | a document send that returned success |

The facts are strict about provenance: `address_updated` is not "the PUT
returned 200", it is "an independent GET shows the new address". Reads set
resolution flags and nothing else, so no amount of looking becomes evidence for
having changed something. And the facts are injected *before* the reply is
written, not only checked after - validation can only delete a sentence.

A paraphrase nobody has seen still fails, because facts do not change when
wording does. The regex net stays, unchanged, behind it - as the last line
rather than the arbiter.

## Scenario results (Part 5, live, signed WhatsApp webhook, Matan Amran)

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 25 | Missing item | **PASS** | `reconcile_order_items` on #1011; named the item and the pending shipment; **no identity re-verification** |
| 26 | Order note/tag | **PASS** | "ההערה נוספה להזמנה #1011."; Shopify `note` non-empty; no team claim |
| 29 | Coupon | **UNSUPPORTED (product decision)** | exact sentence; no tool, no approval, no handoff |
| - | Own email change | **PASS** | Shopify read-back `matan.amran.dev@example.com`; identity survived via `Contact.metadata.shopifyCustomerId` |
| 10 | Address change, pre-fulfilment | **PASS** | HITL `cmsbkjqx…` → SUCCEEDED; read-back הרצל 1, חיפה, 3100000; one continuation; AI retained |
| 21 | Return, unfulfilled order | **PASS (correct refusal)** | no approval raised; "a return covers items you've actually received"; alternatives offered |
| 28 | Tax invoice | **UNSUPPORTED (no provider)** | honest, no provider name, no status code, explicitly *not* an order summary |
| 27 | Order confirmation | **BROKEN** | Shopify `406`; message honest, but the continuation asked which email to use |
| 22 | Exchange | **BLOCKED (scope)** | `write_order_edits` not granted; quote, eligibility and refusal all correct |
| - | Return, delivered item | **UNPROVEN** | cannot fulfil an order: `write_merchant_managed_fulfillment_orders` deliberately not requested |

## Dev-store mutations in this part

| Object | Action | Final state |
|---|---|---|
| Order **#1012** | created as a fixture (The Complete Snowboard / Ice ×2) | paid, unfulfilled, 1399.90 USD |
| Order #1012 | shipping address changed via approved HITL | הרצל 1, חיפה, 3100000, Israel |
| Order #1011 | notes appended (4 runs) | `note` non-empty, `tags` empty |
| Order #1012 | note appended | `note` non-empty |
| Customer 27711594201457 | email changed | `matan.amran.dev@example.com` |

Orders #1006–#1011 are otherwise unchanged from Part 4. No other tenant, store
or customer was touched.

## Tests

| Suite | Command | Exit | Result |
|---|---|---|---|
| AI | `npx vitest run` (services/ai) | 1 | 25 failed / 2106 passed |
| Conversation | `npx vitest run` (services/conversation) | 1 | 1 failed / 69 passed |
| Shared | `npx vitest run` (packages/shared) | 1 | 49 failed / 958 passed |
| Incoming worker | `npx vitest run` (services/incoming-worker) | 1 | 0 failed / 43 passed |
| Typecheck | `npx tsc --noEmit` (ai, conversation) | 0 | clean |

**Baseline comparison.** The starting commit `f040686` was checked out into a
separate worktree and the same suites run there. AI: **39 failing tests at
baseline, 25 now, and the set of failures at HEAD is a strict subset** - zero
new. Conversation and incoming-worker: identical failures at both. Shared: the
three extra failures are `role-assignment-tenant-scope.test.ts`, an untracked
file belonging to other uncommitted work on this branch, which does not exist at
the baseline commit.

## Verdict after Part 5

**Closer than Part 4, and still not ready to sell.**

What is genuinely better: six capabilities that did not exist, each refusing
correctly when it cannot proceed; ownership that a model cannot get wrong
because it is not one of the model's arguments; and claims now checked against
the facts those claims are about rather than against "something ran".

What blocks the claim:

1. **The exchange has never completed against a real store.** The code is
   unit-proven and the refusals are right, but `write_order_edits` was never
   granted, and a capability whose happy path has not run once is not a
   capability yet.
2. **`send_invoice` returns 406 on this store**, so order-confirmation delivery
   is unproven end to end.
3. **The return happy path is unprovable here** - fulfilling an order needs a
   scope deliberately not requested. The refusal path is proven; the creation
   path is not.
4. **The model's multi-step flows are the weakest link now, not the tools.** It
   raised an exchange approval with no replacement variant; it reached for
   `link_customer_identifier` instead of the Shopify write; it produced two
   silent turns. Every one was contained - by a precheck, by a directive, by the
   silent-turn net - but containment is not the same as the flow working.

The honest summary is that the *mechanisms* are now considerably stronger than
the *behaviour* they are containing. That was true of the honesty net in Part 4
and it is still true, one layer up.

---

---

# Part 6 - Final sales-readiness closure (2026-08-02)

The operator granted the scopes Part 5 was blocked on. This part closes the
Shopify use case: exchange and return proven end to end for the first time, the
`shopify_406` confirmation blocker resolved, the model removed from the driving
seat of the irreversible flows, and a verdict.

## The reconnect had disarmed the assistant

Before anything else could be proven, Phase 1 found this - and found it the
same way Part 3 found its half, by an operator reconnecting to grant scopes on
the day those scopes were needed.

| Category | Provisioned | In catalog |
|---|---|---|
| READ | 42 | 42 |
| WRITE | **0** | 18 |
| ACTION | **0** | 8 |

The store was CONNECTED, the capability probe was green, every scope was
granted, and the assistant could look up any order, customer, variant and
fulfillment state while being unable to cancel, refund, return, exchange or
redirect a single one.

That is worse than having no tools, because the reads answer every diagnostic
anyone thinks to run. And reconnecting is the ONLY way to grant a scope, so the
operation a merchant performs to make the assistant more capable is the
operation that quietly disarms it.

Part 3 fixed "connecting created no permissions" by calling the provisioning
helper from the connect path. The helper was `enableReadToolsForIntegration`,
filtered to READ, under a comment reading *"Writes stay an explicit decision."*
That is a reasonable sentence about a first connect and a false one about a
reconnect: disconnect deletes tenant tools by cascade, so nobody decided
anything - a cascade did. Provisioning now covers the whole surface; what keeps
writes safe is where it always was, `hitl_policy`, which holds every
money-moving tool behind a human.

**Stated, not hidden:** a full disconnect deletes those rows too, so a per-tool
"off" an operator set does not survive one. The function cannot preserve a row
that no longer exists. Durable per-tool intent keyed by tenant and tool name
rather than by connection is a schema change, and it is not attempted here.

## Scope matrix (live probe, not cached state)

`SHOPIFY_DEV_E2E=true node scripts/shopify/dev-e2e.mjs scope-check`

| Capability | Operation | Scope | Granted | Tool | AI | HITL | Live verified |
|---|---|---|---|---|---|---|---|
| Order lookup | `GET /orders` | `read_orders`, `read_all_orders` | yes | `get_order` | yes | never | yes |
| Fulfillment state | `GET /fulfillment_orders` | `read_merchant_managed_fulfillment_orders` | yes | `get_fulfillment_status` | yes | never | yes |
| Cancel | `orderCancel` | `write_orders` | yes | `cancel_order` | yes | always | Parts 2-3 |
| Refund | `POST /refunds` | `write_orders` | yes | `process_refund` | yes | always | Part 4 |
| **Exchange** | `orderEditBegin/SetQuantity/AddVariant/Commit` | **`write_order_edits`** | **yes** | `exchange_order_item` | yes | always | **yes, #1014** |
| **Return** | `returnCreate` | **`write_returns`** | **yes** | `create_return` | yes | always | **yes, #1003-R2 / #1002-R1** |
| **Order confirmation** | `orderInvoiceSend` | `write_orders` | yes | `resend_confirmation` | yes | always | **yes, #1014** |
| Profile | `PUT /customers` | `write_customers` | yes | `update_my_profile` | yes | never | yes |
| Order address | `PUT /orders` | `write_orders` | yes | `update_order_shipping_address` | yes | always | yes, #1014 |
| Note/tag | `PUT /orders` | `write_orders` | yes | `add_order_note` | yes | never | yes, #1014 |
| Create fulfillment | `fulfillmentCreate` | `write_merchant_managed_fulfillment_orders` | **NO** | - | - | - | **blocked, by design** |
| Coupons/discounts | price rules | granted | yes | 8 tools | **ASSIST only** | - | out of scope |

## Exchange: three defects between the code and a completed swap

Each was invisible until the edit ran against a real store.

**`restock: true`.** Reducing a PAID line without it does not credit the line -
Shopify keeps the charge and bills the replacement on top. Order #1012 went from
2 boards at 1399.90 to a subtotal of 2099.85 and `partially_paid`: a customer
owing money for a swap that was supposed to cost nothing. With `restock` the
same edit nets to exactly the original subtotal.

**`calculatedOrder` is not a query.** The line-id mapping comes back from
`orderEditBegin` itself. The separate query failed with *"Field 'calculatedOrder'
doesn't exist on type 'QueryRoot'"* - after a human had approved the exchange.
Second time this round a GraphQL field nobody had watched execute failed a
money-adjacent action at the last step, after `returnableFulfillments`.

**`projectOrderForAgent` was stripping `product_id` and `variant_id`.** That
projection exists to keep credentials out of the prompt and it also removed the
two identifiers needed to act on a line - so a five-colour snowboard reported as
"sold in one version only", from the order that contained it.

### The settlement guard

The quote's arithmetic says the prices match. The guard asks **Shopify** whether
the edit it has staged changes what the customer owes, and refuses to commit
when the delta is not zero. An uncommitted calculated order simply expires, so a
refusal leaves the order untouched. My own arithmetic got this wrong once, which
is the argument for not trusting it.

| Relation | Behaviour |
|---|---|
| equal | commit, after Shopify's own delta reads 0.00 |
| higher | refuse before `orderEditBegin`, state the exact difference, hand to a person |
| lower | refuse before `orderEditBegin`, state the exact difference, hand to a person |
| non-zero delta at commit time | refuse, order untouched, hand to a person |

**Limitation, stated:** the zero delta is proven against API-created orders,
whose `financial_status: "paid"` is a label rather than a transaction. A real
gateway-paid order cannot be constructed on a dev store, so the behaviour on one
is inferred from Shopify's arithmetic rather than observed.

## The flows are no longer the model's to choose

Part 5 ended with the mechanisms stronger than the behaviour they contained. The
two failures worth naming, both live: a human approved
`exchange_order_item({quantity: 1, order_name: "1012"})` - an exchange with
nothing to exchange to; and a colour question was answered from a product the
model had guessed the name of.

`shopify-flow-controller.service.ts` resolves the facts before the model is
asked to say anything - which order, which line, which options, what it costs,
whether it is still eligible - and hands over at most ONE permitted call with
its arguments already filled in. `assertMatchesResolvedFlow` then refuses, at
dispatch, any critical tool called with arguments the controller did not
compute.

The difference is visible in the approval rows:

```
Part 5:  {"quantity": 1, "order_name": "1012"}
Part 6:  {"quantity": 1, "order_name": "#1014",
          "line_item_id": "45669159928177", "new_variant_id": "64158270882161"}
```

What stays with the model: tone, language, empathy, and every flow that is not
irreversible. A state machine over those would be worse.

## Return/RMA provider matrix

| Provider | Connected | Creates returns | Reads status | Selected |
|---|---|---|---|---|
| Shopify native | yes | **yes** (`returnCreate`, `write_returns`) | yes | **yes** |
| ReturnGO | no | no - the adapter has list/summarise/update and no create | n/a | no |
| Human handoff | always | n/a | n/a | fallback |

Exactly one provider creates any given return. A connected integration with no
create endpoint is not a create-capable provider, and ReturnGO is the reason
that sentence exists.

## Document capability matrix

| Document | Source | Status |
|---|---|---|
| Order confirmation | `orderInvoiceSend` | **PASS** - live |
| Payment receipt | same email | PASS |
| Refund confirmation | refund result | PASS |
| Order summary | order read | PASS |
| Order-status link | `order_status_url` | **refused by design** - it carries a bearer key |
| Invoice / tax invoice / credit note | none connected | **UNSUPPORTED** - stated honestly, no provider name, no status code |

## Fixture inventory

| Order | Purpose | State |
|---|---|---|
| #1002 | fulfilled return fixture | return `#1002-R1` OPEN |
| #1003 | fulfilled return fixture | return `#1003-R2` OPEN, `#1003-R1` CANCELED |
| #1012 | first exchange attempt, no `restock` | `partially_paid`, left as evidence |
| #1013 | clean settlement experiment | exchanged Ice→Dawn |
| #1014 | full journey fixture | exchanged, address changed, note added, confirmation sent |

## Shopify mutation ledger (Part 6)

| Object | Mutation | Result |
|---|---|---|
| #1012 | order edit without `restock` | subtotal 2099.85, `partially_paid` - the defect, preserved |
| #1012 | reverting order edit | committed |
| #1013 | created, then Ice→Dawn | `exchange_completed: true` |
| #1014 | created | 1399.90 |
| #1014 | Ice→Dawn via HITL | Ice outstanding 1, Dawn outstanding 1 |
| #1014 | shipping address via HITL | רוטשילד 5, תל אביב, 6688218 |
| #1014 | note added | note non-empty |
| #1014 | `orderInvoiceSend` | sent to the stored address |
| #1003 | `returnCreate` ×2, one cancelled | `#1003-R2` OPEN |
| #1002 | contact attached, `returnCreate` | `#1002-R1` OPEN |
| customer 27711594201457 | email, then default address | `matan.amran.dev@example.com`, הרצל 1 חיפה |

Orders #1006-#1011 unchanged from Part 4. No other tenant, store or customer
was touched.

## Final 30-scenario matrix (Part 6, signed WhatsApp webhook, Matan Amran)

| # | Scenario | Order | Tool / flow | HITL | Read-back | Result |
|---|---|---|---|---|---|---|
| 1 | Latest order | #1014 | `find_latest_order` → order read | - | n/a | **PASS** - money, lines and the return all correct |
| 2 | Order by name | #1002/#1011/#1014 | `get_order` | - | n/a | **PASS** |
| 3 | Product by use case | - | discovery | - | n/a | **PASS** - qualifies, invents nothing |
| 4 | Product by budget | - | discovery | - | n/a | **PASS** - asks for budget |
| 5 | Recommendation by profile | - | discovery | - | n/a | **PASS** |
| 6 | Exact variant / colour | - | `variant_information` | - | n/a | **PASS** - "Powder ומצוין במלאי (9 יחידות)" |
| 7 | Out of stock | - | `variant_information` | - | n/a | **PASS** - no invented restock date |
| 8 | Tracking | #1002 | `track_shipment` | - | n/a | **PASS** after the interim-only fix - "כבר נמסרה" |
| 9 | No ETA | - | `check_delivery_eta` | - | n/a | **PASS** - Part 3, `tracking_state` |
| 10 | Address before fulfilment | #1014 | `update_order_shipping_address` | approved | רוטשילד 5, תל אביב | **PASS** |
| 11 | Address after fulfilment | #1002 | flow controller | none raised | n/a | **PASS** - refuses, no carrier claim |
| 12 | Cancel eligible | #1015 | `cancel_order` | approved | `cancelled_at` set | **PASS** |
| 13 | Reject cancellation | - | reject route | rejected | n/a | **PASS** - Part 2, re-proven via refund rejection |
| 14 | Cancel fulfilled | #1002 | precheck | none raised | n/a | **PASS** - offers return+refund |
| 15 | Cancel already cancelled | #1007/#1015 | precheck + idempotent tool | none raised | `already_cancelled` | **PASS** |
| 16 | Full refund | #1016 | `process_refund` | approved | `nothing_to_refund` | **PASS (honest failure)** - fixture has no transaction; real full refund proven Part 2 on #1010 |
| 17 | Reject refund | #1016 | reject route | rejected | `refunds: []` | **PASS** - "הכסף לא הוחזר", nothing moved |
| 18 | Partial refund | #1011 | `process_refund` | approved | 4th refund 50.00 | **PASS** - real transaction |
| 19 | Refund above maximum | #1011 | `process_refund` | none raised | n/a | **PASS** - "only 235.95 USD is refundable" |
| 20 | Duplicate refund | #1011 | ledger + balance | - | n/a | **PASS** - Part 4, balance arithmetic re-proven |
| 21 | Return request | #1003 | `create_return` | approved | `#1003-R2` OPEN | **PASS** |
| 22 | Exchange | #1014 | `exchange_order_item` | approved | Ice 1 / Dawn 1 | **PASS** |
| 23 | Damaged item | #1003 | `create_return` DEFECTIVE | approved | `#1003-R2` | **PASS** |
| 24 | Wrong item | #1002 | `create_return` WRONG_ITEM | approved | `#1002-R1` | **PASS** |
| 25 | Missing item | #1014 | `reconcile_order_items` | - | n/a | **PASS** - no identity re-check |
| 26 | Note / tag | #1014 | `add_order_note` | - | note non-empty | **PASS** - "ההערה נוספה להזמנה #1014" |
| 27 | Order confirmation | #1014 | `resend_confirmation` → `orderInvoiceSend` | approved | provider ack | **PASS** |
| 28 | Invoice / tax invoice | - | document resolver | - | n/a | **UNSUPPORTED** - no invoicing provider connected |
| 29 | Coupon | - | detector + ASSIST-only tools | none raised | n/a | **UNSUPPORTED** - product decision |
| 30 | Proactive shipment update | - | flow | - | n/a | **PASS** - asks which order, promises nothing unschedulable |

**28 PASS. 2 UNSUPPORTED by explicit product decision. 0 BROKEN.**

Two PASSes carry a caveat and are marked as such above: #16 could only be
observed failing honestly, because an API-created fixture has no payment
transaction to refund - the real full refund is Part 2's on #1010. Everything
in the money column that runs against a real transaction was re-proven here on
#1011.

## Test commands and exit codes

| Suite | Command | Exit | Result |
|---|---|---|---|
| AI | `npx vitest run` (services/ai) | 1 | 25 failed / 2172 passed / 12 skipped |
| Conversation | `npx vitest run` (services/conversation) | 1 | 1 failed / 69 passed |
| Incoming worker | `npx vitest run` (services/incoming-worker) | 1 | 0 failed / 43 passed |
| Shared | `npx vitest run` (packages/shared) | 1 | 49 failed / 958 passed |
| Typecheck | `npx tsc --noEmit` (ai, conversation) | 0 | clean |

**Baseline comparison by checkout.** `f040686` in a separate worktree, same
suites. The AI failures at HEAD are a **strict subset** of the baseline's -
**zero new**. Conversation and incoming-worker are identical at both. Shared's
three extra failures are `role-assignment-tenant-scope.test.ts`, an untracked
file belonging to other uncommitted work on this branch, absent at baseline.

AI passing count rose 2089 → 2172 across Parts 5 and 6.

## Final state

Tool surface: **READ 42 / WRITE 18 / ACTION 8 - 68 of 68 provisioned.**

| Order | Final state |
|---|---|
| #1002 | paid, fulfilled, return `#1002-R1` OPEN |
| #1003 | paid, fulfilled, return `#1003-R2` OPEN |
| #1006 | paid, unfulfilled, unchanged since Part 2 |
| #1011 | partially_refunded, 550.00 of 785.95 returned |
| #1012 | partially_paid - the `restock` defect, preserved as evidence |
| #1013 | partially_paid, exchanged |
| #1014 | partially_paid, exchanged + address changed + note + confirmation |
| #1015 | cancelled |
| #1016 | paid, refund attempted and honestly failed, refund rejected |

Customer 27711594201457: `matan.amran.dev@example.com`, default address
הרצל 1, חיפה, 3100000, Israel.

## Verdict: Shopify sales readiness

**GO, for merchants whose returns run on Shopify native returns, with two
conditions the seller must know.**

Everything a Shopify merchant will ask to see in a demo now works end to end
through the real customer path, with a human in the loop on every irreversible
action and a provider read-back behind every claim: order status, tracking,
variants and stock, cancellation, full and partial refunds with duplicate
prevention and balance arithmetic, order-address changes before dispatch,
same-price exchange, return creation with a real RMA reference, self-service
profile changes, missing-item reconciliation, order notes, and order
confirmations. Coupons and tax invoices are refused honestly and deliberately.

The two conditions:

**1. Reconnect provisioning must ship before any merchant onboards.** The defect
found in Phase 1 - a reconnect leaving 42 read tools and zero write tools -
is fixed, but it was live on the only store we have, it was invisible to every
health signal, and reconnecting is mandatory for granting scopes. A merchant who
reconnects on a build without this fix gets a green connection and an assistant
that can only look. This is the single highest-severity thing found in six
parts.

**2. Two capabilities are proven only as far as a dev store allows.** Fulfilment
cannot be created without `write_merchant_managed_fulfillment_orders`, which is
deliberately not requested, so the return path was proven against pre-existing
fulfilled orders rather than ones we made. And API-created orders carry
`financial_status: "paid"` as a label rather than a transaction, so the
exchange's zero settlement delta is Shopify's own arithmetic rather than an
observed gateway movement. Both should be confirmed once against a merchant's
staging store before the first sale.

### What is genuinely different from Part 5

Part 5's honest summary was that the mechanisms had become stronger than the
behaviour they were containing. That is no longer the shape of the system. The
model does not choose the move on any irreversible flow: the facts are resolved
in code, the permitted call arrives with its arguments already computed, and the
dispatch gate refuses anything else. The two live failures that closed Part 5 -
an approval raised with no replacement variant, and a colour answered from a
guessed product - are not reachable from here.

### Remaining product limitations

- No invoicing provider, so no tax invoice, credit note or receipt document.
- ReturnGO is read-only: it cannot create a return, and is not offered as a
  return provider.
- Higher- and lower-price exchanges are always a human's job, by design.
- A full disconnect still discards per-tool operator overrides (schema cascade).
- No WhatsApp document/media delivery; documents go by email to the stored
  address only.
- Fulfilment creation, draft orders and third-party fulfilment writes remain
  deliberately un-requested.

---

---

# Release addendum - the disconnect operator-intent defect (2026-08-03)

Part 6 shipped the reconnect provisioning fix as PR #15 and recorded one
limitation honestly: an operator-disabled tool did not survive a real
disconnect. This addendum closes it. Release preparation was held until it was
fixed and verified, as instructed.

## The defect

1. An operator disables `process_refund`.
2. The tool row exists carrying that decision.
3. Disconnect destroys integration-scoped rows.
4. The disabled row is gone.
5. Reconnect provisions the tool again from catalogue defaults.
6. `process_refund` comes back **enabled**.

Nobody overrode the decision. The *evidence* of it was deleted, so reconnect had
nothing to preserve. And because reconnecting is the only way to grant an OAuth
scope, an operator doing routine maintenance silently re-armed a money-moving
tool they had deliberately switched off.

## Root cause

Credentials, connection state and tenant policy all hung off the same row, and
three independent paths destroyed the policy:

| # | Path | Nature |
|---|---|---|
| 1 | `integrations.ts:304` explicit `prisma.tenantTool.deleteMany` | **the observed one** - an explicit delete, commented as belt-and-braces for the cascade |
| 2 | `TenantIntegration → TenantTool` `onDelete: Cascade` | latent - fires on real row deletion |
| 3 | `CatalogTool → TenantTool` `onDelete: Cascade` | latent and worse - a **platform-side** catalogue edit destroys every tenant's policy, their per-agent permissions and their execution history |

A fourth contributor made recovery impossible: operator decisions for
*integration* tools were written **only** to the connection-scoped row.
`tool-permissions.ts` routed them there deliberately, with the comment *"Writing
to TenantToolPermission for an integration tool would silently no-op against the
gate."* True of the gate - and precisely why no durable record ever existed.

Static tools had a durable, connection-independent policy table the whole time.
Integration tools did not.

## The two disconnect routes disagreed

| Route | Policy rows | Credentials |
|---|---|---|
| `integrations.ts` `POST /:slug/disconnect` | **deleted** | cleared |
| `connectors-admin.ts` `POST /connectors/:slug/disconnect` | preserved | **left live** |

Each had half the right answer. Depending on which button an operator pressed
they either lost their configuration or kept a working access token on an
integration the product called disconnected.

## The fix

**One canonical disconnect.** Both routes now call `disconnectIntegration()`,
which clears credentials, preserves policy, stamps `disconnectedAt` /
`disconnectedBy`, and writes an audit event carrying no credential material.
Nothing executes afterwards because the tool surface already requires a
`CONNECTED` integration - availability and policy are separate questions, and
answering the first by destroying the answer to the second is what caused this.

**A durable record of intent.** `TenantToolPermission` already existed, keyed by
`(tenantId, toolName)` with no foreign key to any connection, and the tool-gate
header already called it authoritative. Integration-tool policy changes now
write **both**: `TenantTool` is the live policy the gate reads, and
`TenantToolPermission` is the decision. Reconnect rebuilds the first from the
second. Absence of a decision means nobody ever configured that tool, so the
catalogue default is used - which is what stops this inventing a disabled state
for a tool no human has touched.

**The cascade.** `CatalogTool → TenantTool` is now `RESTRICT`. No amount of care
in application code can stop a foreign key doing what it was declared to do.

## Lifecycle, before and after

| Concern | Before | After |
|---|---|---|
| Connection state | on `TenantIntegration` | unchanged |
| Credentials | cleared by one route, left live by the other | **always cleared**, in one place |
| Granted scopes | refreshed on reconnect | unchanged |
| Tenant tool policy | **deleted on disconnect** | **preserved**, and restorable from a durable record even after a hard delete |
| Disconnect metadata | none | `disconnectedAt`, `disconnectedBy`, audit event |
| Execution gating | surface requires `CONNECTED` | unchanged - policy alone never grants execution |

## Migration

`20260803090000_integration_lifecycle_policy` - metadata only. No row is
created, deleted or rewritten. Ships with `down.sql`. New columns are nullable
with no default, because back-filling a disconnect timestamp would invent an
event that never happened. The rollback restores the previous cascade exactly,
and the migration notes that doing so re-enables catalogue deletions destroying
tenant policy.

## Live verification - Urban Supply Dev, 2026-08-02

Tenant "Urban Supply - GOTCHA Demo", store `urban-supply-gotcha-demo.myshopify.com`,
channel "Demo WhatsApp", customer Matan Amran `972545680665`. No production
system was touched and no real refund was executed.

### Sequence A - operator intent across a disconnect (PASS)

| Step | Result |
|---|---|
| 1. start | ACTION 8/8, READ 42/42, WRITE 18/18 |
| 2. operator disables `process_refund` via the canonical policy path | live row `enabled=false`; durable record `enabled=false by=live-verify` |
| 3. real `disconnectIntegration()` | `DISCONNECTED`, credentials empty, `disconnectedAt` set, **policyRowsPreserved: 68** |
| 4. after disconnect | **all 68 rows still present**, `process_refund` still `enabled=false` |
| 5. SIMULATED wipe (reproducing the historical cascade) | 0/68, row absent |
| 6. reconnect via real provisioning | `granted 67, preserved 1, restoredFromIntent 1` |
| 7. after reconnect | READ 42/42, WRITE 18/18, ACTION 7/8 with 1 off |
| 8. `process_refund` | **still disabled** |

Step 5 is labelled simulated deliberately. It is not what a disconnect does any
more - it is what the old cascade did, run on purpose to prove the durable
record can rebuild the decision even after every connection-scoped row is gone.
Steps 3-4 are the real disconnect, and there the rows never die at all.

### Health signal (PASS)

```
STATUS       PARTIALLY_AVAILABLE
SUMMARY      67 of 68 tools are enabled; 1 are switched off by tenant policy,
             which is a decision, not a fault.
TOOLS        expected 68, provisioned 68, enabledByPolicy 67, explicitlyDisabled 1, missing 0
DISABLED     ["process_refund"]
CREDENTIALS  { present: true, decryptable: true }      <- no credential material
```

### Sequence B - enabled tools still execute (PASS)

Live, against the dev store, through the real dispatch path:

```
B1  shopify.get_orders     ok, 3 orders returned
B2  target order           #1014
B3  shopify.add_order_note ok  (real write)
B4  read-back from Shopify note present at the provider: true
```

### Sequence C - the disabled tool stays blocked (PASS at the surface layer)

The gate is `ai-bot.service.ts:1986`: the adapter-tool guest list is built from
`AgentToolPermission.isAllowed AND TenantTool.isEnabled AND integration
CONNECTED`. Run live against the tenant:

```
G1  shopify tools on the guest list  : 67 of 68
G2  ACTION tools admitted            : cancel_order, create_return, edit_order,
                                       exchange_order_item, resend_confirmation,
                                       send_invoice, update_order_shipping_address
G3  shopify:process_refund admitted? : false
C4  approval requests raised         : []
```

Seven of eight ACTION tools are admitted and the eighth is refused, so the
refusal is the operator's decision taking effect and not a dead surface. The
model is never offered the tool, so it cannot propose it and no approval can be
raised for it. Two bot turns asking directly for a full refund raised none.

**Honest limit on what C proves.** It proves the tool is blocked *where the bot
lives* - the surface. It does not prove the dispatch layer refuses it.

## New finding, not introduced by this change: no policy gate at dispatch

`executeAdapterTool` has no tenant-policy check of its own. Called directly with
`shopify.process_refund` while that tool was disabled, it did not refuse - it
went to Shopify, which declined only because that order had nothing refundable:

```
{"ok":false,"reason":"refund_exceeds_refundable: requested 0.01 USD but only 0.00 USD is refundable"}
```

On an order with a refundable balance the same call would have executed a real
refund on a tool the operator had switched off.

This is pre-existing on main and is not caused by, or worsened by, this change.
It matters most on the approved-HITL path: `runApprovedAction` revalidates
*business policy rules* and fails closed, but it does not re-check
`TenantTool.isEnabled`. So an approval raised while a tool was enabled can still
execute after an operator disables it.

It is deliberately **not** fixed here. The correct gate sits inside
`executeAdapterTool`, a chokepoint with roughly eighty call sites across two
services, many of them internal reads that must keep working. Bolting a
cross-cutting execution gate onto that immediately before a release, inside a
PR scoped to disconnect lifecycle, would be the wrong trade. Recommended as a
P1 follow-up with its own change and its own verification.

## Not verified

- The full HITL loop for this change specifically - raise approval, approve,
  execute, read back - was proven live in Part 6 and was not re-run here. What
  was re-run is that enabled tools still reach Shopify and mutate it (B3/B4).
- Two bot turns produced no tool calls because the assistant asked a clarifying
  question first. That is correct behaviour, but it means the negative result in
  those turns carries no weight on its own; the gate query G1-G3 is what carries
  Sequence C.
