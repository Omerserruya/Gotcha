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

## 10. Verdict

**Not ready to sell, but materially closer.** The HITL lifecycle is proven on
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
