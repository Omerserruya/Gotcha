# Shopify Tool Audit - 2026-07-20

End-to-end audit of every Shopify capability exposed to the AI, triggered by
the Matan Amran incident: approved HITL actions (order cancellation, refund,
compensation coupon) that never executed against Shopify.

## 1. Root cause

**Approved dotted adapter tools (`shopify.*`) had no execution route.**

`dispatchApprovedAction` in `services/conversation/src/routes/approvals.ts`
routed approvals by tool-name shape:

| Shape | Route | Result for shopify.* |
|---|---|---|
| `resumeEnvelope.kind=kernel_operation` | Capability Runtime | n/a (envelope was `null`) |
| `integration_<slug>` | catalog executor | not matched (name is dotted) |
| everything else | legacy action-planner `executeAction()` switch | **`throw "unsupported tool: shopify.cancel_order"`** |

The live bot executes `shopify.*` through `executeAdapterTool()`
(integration-framework), but the approval-resume path never knew that
executor existed. Every approved Shopify write died in the legacy switch.

**Compounding bug (already fixed on this branch on 2026-07-20, after the
test):** at test time the approve endpoint recorded the outcome
unconditionally - all three approvals were stamped
`execution_state=SUCCEEDED`, `customer_notified_at` set, with
`execution_attempts=0`, `execution_started_at=NULL` and
`execution_ended_at == decided_at` to the millisecond. Approval was being
treated as completion.

## 2. Matan Amran forensic timeline (tenant urban-supply, 2026-07-19 UTC)

Contact `cmrrtu50t00dx14b0fjdizmio` (+972545680665), conversation
`cmrrtu4by0003135f6094umat`, Shopify shop
`urban-supply-gotcha-demo.myshopify.com` (status CONNECTED, reads working).

| Time | Event | Evidence |
|---|---|---|
| 13:23:54 | "היי" inbound; bot resolves customer via `shopify.get_customer_by_phone` (OK ×6 variants) | audit `adapter.ok.*` |
| 13:24:49 | `shopify.find_latest_order` OK → order #1004, paid, unfulfilled | audit + reply |
| 13:25:20 | "אני רוצה לבטל את ההזמנה" | messages |
| 13:25:32 | HITL #1 created: `shopify.cancel_order` **with empty params `{}`** (`cmrrtw81x00fr14b02wq1edc7`) | approval_requests |
| 13:27:07 | Manager approves → executor: **`unsupported tool: shopify.cancel_order`** → row still stamped SUCCEEDED, no Shopify call, no customer message | audit `action.shopify.cancel_order` |
| 13:28:48 | HITL #2: `shopify.issue_compensation_coupon` (GOTCHA-MATAN-1004, 100%) | approval_requests |
| 13:30:20 | Approved → same `unsupported tool` failure, fake SUCCEEDED | audit |
| 13:32:02 | HITL #3: `shopify.cancel_order {order_name:#1004, refund:true, restock:false}` | approval_requests |
| 13:32:30 | Approved → same failure, fake SUCCEEDED | audit |
| 13:33:46 | Bot double-checks `shopify.get_refund_status` → `refunds: []` (proof nothing executed) | audit |
| 13:34+ | Customer told "still pending approval" repeatedly, asks for human, escalation; human closes with "ההזמנה לא בוטלה כי היא כבר יצאה לדרך" | messages |

Also observed throughout: `shopify.update_customer` failing with
`shopify_403: This action requires merchant approval for write_customers scope`
(see §6).

The stuck `tool_execution_requests` rows corroborate: the three write tools
sit at status `proposed` forever, while read tools reach `completed`.

The three stale rows were corrected in the dev DB from fake SUCCEEDED to
FAILED with an explanatory `execution_error`.

## 3. Fixes

1. **Routing (root cause)** - `dispatchApprovedAction` now routes dotted
   `<provider>.<tool>` names to the AI adapter bridge
   `POST /api/ai-assist/:conversationId/adapter-tools/execute`
   (→ `executeAdapterTool`: credential load, token refresh, rate limit,
   adapter audit). Inner `ok:false` (userErrors, missing scope,
   not_connected, unknown_tool) fails the execution - transport 200 is never
   success. Excluded namespaces: `integration.` (kernel plane), `custom.` /
   `custom_db.` (tenant-defined dispatchers).
2. **State machine (landed earlier on this branch, verified here)** -
   `approveRequest`/`claimForExecution`/`recordExecutionOutcome`/
   `claimCustomerNotification` CAS chain: approval ≠ completion, once-only
   execution, once-only customer notification, failure → FAILED + human
   handoff + system message.
3. **Stranded-execution sweeper** - `idle-conversation.worker.ts` re-dispatches
   APPROVED rows stuck at `NOT_STARTED` for >3 min through the ONE execution
   path (`/dispatch-approved`), CAS-protected against double-run.
4. **Manual retry** - `POST /api/approvals/:id/retry-execution` + "Retry
   action" button on the approvals page for APPROVED+FAILED rows.
5. **Idempotent Shopify writes** -
   `cancel_order`: already-cancelled → idempotent success flagged
   `already_cancelled`; post-cancel verification (`cancel_not_applied` if
   Shopify 200s without cancelling).
   `issue_compensation_coupon`: duplicate code → returns existing code
   (`already_existed`) instead of 422.
   `process_refund`: fully-refunded order → `already_refunded`.
6. **Dead/missing tools implemented** -
   `update_order_fulfillment` (declared for months with NO handler → real
   note+tag handler), `process_refund` (catalog advertised "Process Refund"
   with zero implementation → real REST refunds calculate→create flow with
   refundable-maximum validation, partial amount/line-item support, restock
   & shipping options, gateway-transaction verification, `processed` vs
   `pending` reporting), `order_lookup` (alias of get_order).
   Migration `20260720120000_shopify_refund_tool_hitl` seeds the catalog
   rows, sets `process_refund` hitl_policy=always, and backfills TenantTool
   rows for connected shops.

## 4. Capability matrix (adapter `services/ai/src/services/connectors/shopify.adapter.ts`, API 2024-04)

**62 tools** - reconciled exactly: 62 catalog rows (`cat_shopify`), 62
adapter-declared handlers (parity-tested), 62 tenant-enabled TenantTool rows
for urban-supply. Of these, 2 are new this audit (process_refund,
order_lookup), 13 are LIVE-VERIFIED, 18 BLOCKED-BY-SCOPE, 4
DEGRADED-BY-DESIGN, 0 UNSUPPORTED, 27 NOT-YET-LIVE-VERIFIED (per-row detail
in the matrix below).
HITL "always": cancel_order, process_refund,
create_discount_code, create_one_time_coupon, create_vip_coupon,
issue_compensation_coupon. All other writes auto-execute (policy layer 2 can
tighten per tenant).

**Status legend (a tool is only "live-verified" when the business action was
executed and confirmed against real Shopify state on this store):**

- `LIVE-VERIFIED` - executed against urban-supply-gotcha-demo.myshopify.com and the resulting Shopify state was independently re-read
- `BLOCKED-BY-SCOPE` - implementation + tests exist, but the store has not granted the required merchant approval; **not marked working**, E2E deferred until the scopes are granted (§6)
- `DEGRADED-BY-DESIGN` - deliberately throws an honest, LLM-readable "unsupported" reason instead of faking a result
- `UNSUPPORTED` - no executable backend path (none remain: the parity test forbids the declared-but-dead class)
- `NOT-YET-LIVE-VERIFIED` - implemented with unit coverage, no real-store execution yet

| Group | Tools | R/W | Required scopes | Status |
|---|---|---|---|---|
| Customer read | get_customer, search_customers, get_customer_by_email, get_customer_by_phone, get_customer_orders, get_customer_tags | R | read_customers | LIVE-VERIFIED (Matan flow, audit `adapter.ok.*`) |
| | get_customer_addresses, get_customer_metafields | R | read_customers | NOT-YET-LIVE-VERIFIED |
| Customer write | create_customer, update_customer, add_tag, remove_tag, update_metafield, create_note | W | write_customers | BLOCKED-BY-SCOPE (`write_customers` merchant approval missing; live 403 evidence) |
| Orders read | get_order, get_orders | R | read_orders | LIVE-VERIFIED |
| | order_lookup, search_orders, get_order_items, get_financial_status/check_payment_status, get_fulfillment_status | R | read_orders | NOT-YET-LIVE-VERIFIED |
| Order actions | cancel_order (HITL) | ACTION | write_orders | LIVE-VERIFIED (#1004 cancelled 2026-07-20, verified refetch; idempotent replay proven) |
| | process_refund (HITL) | ACTION | write_orders | LIVE-VERIFIED (refund 1143807934833, $600 processed, verified refetch; duplicate prevented) |
| | send_invoice | ACTION | write_orders | NOT-YET-LIVE-VERIFIED |
| | resend_confirmation, edit_order | ACTION | n/a | DEGRADED-BY-DESIGN (`unsupported_rest`) |
| Fulfillment read | get_shipment_status/track_shipment, get_tracking_number, get_tracking_url, get_fulfillment_events, check_delivery_eta, check_pickup_point | R | read_orders | NOT-YET-LIVE-VERIFIED |
| Discounts read | list_discounts, validate_discount, get_customer_discounts | R | read_price_rules | BLOCKED-BY-SCOPE (live 403: "requires merchant approval for read_price_rules") |
| Discounts write | create_discount_code, create_one_time_coupon, create_vip_coupon (HITL), disable_coupon | W | write_price_rules | BLOCKED-BY-SCOPE |
| Compensation | issue_compensation_coupon (HITL) | W | write_price_rules (+write_customers for tag) | BLOCKED-BY-SCOPE (duplicate-code idempotency unit-tested) |
| Segments | list_segments, check_segment_membership | R | n/a | DEGRADED-BY-DESIGN (GraphQL-only, points to tags) |
| | add_customer_to_segment, remove_customer_from_segment, add_vip_tag, add_retention_segment | W | write_customers | BLOCKED-BY-SCOPE (tag-based proxy) |
| Products | get_product, search_products, inventory_status, variant_information | R | read_products | NOT-YET-LIVE-VERIFIED |
| Refund/return read | get_refund_status/check_refund | R | read_orders | LIVE-VERIFIED (used to verify the real refund) |
| | check_return_status | R | read_orders | NOT-YET-LIVE-VERIFIED |
| | get_returns, get_return_reason (GraphQL) | R | read_returns | NOT-YET-LIVE-VERIFIED |
| Composites | find_latest_order | R | read_orders (+read_customers) | LIVE-VERIFIED |
| | summarize_customer, get_customer_health, find_delayed_order | R | read_customers+read_orders | NOT-YET-LIVE-VERIFIED |
| Ops | update_order_fulfillment | W | write_orders | NOT-YET-LIVE-VERIFIED (new handler; was declared-but-dead) |

Error validation: REST non-2xx throws with Shopify's error body (422
ineligibility, 403 scope). GraphQL helper checks HTTP + top-level `errors[]`
(scope-denial special-cased). There are **no GraphQL mutations** in this
adapter, so mutation `userErrors` don't arise; the two GraphQL reads are
validated. New write handlers additionally verify resulting business state
(re-fetch order / refund object / transaction status).

## 5. Automated tests

- `services/conversation/src/__tests__/approval-dispatch-routing.test.ts`
  (10 tests): dotted→adapter-bridge routing incl. request shape; inner
  `ok:false`/missing envelope on HTTP 200 = FAILED; unknown provider fails
  visibly; `custom./custom_db./integration.` exclusions; `integration_<slug>`
  routing; lost claim dispatches nothing; legacy failure never SUCCEEDED; one
  customer continuation on success; lost notification claim sends nothing.
- `services/ai/src/__tests__/shopify-tool-parity.test.ts` (72 tests): every
  declared tool reaches a real handler (no `unknown_shopify_tool` class of
  bug can be reintroduced); cancel idempotency + verify-after-cancel + 422
  passthrough; refund full/partial/over-max/already-refunded/pending-vs-
  processed; coupon duplicate idempotency; update_order_fulfillment behavior.

## 5b. Historical honesty: LEGACY_UNVERIFIED

The state-machine migration originally backfilled every pre-existing APPROVED
row to SUCCEEDED to keep the sweeper from re-running history. That label was
false for rows that provably never executed. Migrations
`20260720130000/130001` add `ExecutionState.LEGACY_UNVERIFIED` and reclassify
exactly the backfilled shape (attempts=0, no result, no error, no start
timestamp); their phantom `customer_notified_at` stamps are cleared when no
message row exists. LEGACY_UNVERIFIED is terminal: not claimable by
dispatch/sweeper, retry endpoint returns an explicit 409, no notification can
ever be claimed. Rows with REAL recorded outcomes (including the re-dispatched
Matan rows) keep their true SUCCEEDED/FAILED states.

## 5c. Deployment verification: BUILD_SHA

Every image now takes a `BUILD_SHA` build arg (compose passes
`${BUILD_SHA:-dev}`), logs it at boot and reports it on `GET /health`
(`build` field, via shared `service-app.ts`). Deploy verification is
`curl /health` against the expected git SHA - no more trusting that a rebuild
didn't reuse a stale cache layer.

## 5d. Follow-up hardening round (same day, second pass)

1. **Capability gating + missing-scope suppression.** Shopify tools now
   declare `requiredScopes`; a provider 403 "requires merchant approval for X
   scope" persists X onto the connection (`config.missingScopes`), after which
   (a) `executeAdapterTool` short-circuits locally with no HTTP call and no
   audit spam, and (b) the bot tool surface DROPS the blocked tools, so the
   model can never open an approval that cannot execute (the Matan coupon
   HITL class). State self-heals on a passing integration test
   (`validate()` → `clearMissingScopes`) or a token refresh whose scope
   string proves the grant. Tests: `capability-gating.test.ts` (7).
2. **Business-operation dedup.** `ApprovalRequest.operationKey`
   (tool + normalized identifying args) dedups HITL creation (an open sibling
   is returned instead of a new row) and gates the customer completion
   notification across sibling rows - the "two refund rows, two 'it's done'
   messages" hole. Tests: `approval-operation-dedup.test.ts` (10).
3. **Grounded humanizer pipeline.** Post-execution customer messages now flow
   through ONE path: `/api/ai-bot/execution-message` → generation with
   verified facts only → `humanizeReply` (style, dash-scrub) →
   `validateGroundedMessage` (amount/currency/order preserved, pending never
   reads as completed, failure never reads as success, no em dashes) →
   deterministic bilingual fallback template on any contradiction. Tests:
   `grounded-message.test.ts` (15).
4. **Deterministic business policy engine.** `BusinessActionPolicy`
   (tenant-scoped, versioned, immutable per version) + append-only
   `PolicyDecision` audit. Evaluated at OFFER / HITL_CREATE (orchestrator) and
   PRE_EXECUTION (`runApprovedAction` + kernel resume) - a manager's click is
   not an override channel, an over-cap edit is denied, and engine failure
   FAILS CLOSED for money-moving kinds. Config API
   (`/api/business-policies`) + "Business Rules" settings page (bilingual).
   Tests: `business-policy.test.ts` (23).
5. **Historical honesty + deploy verification** - see §5b (LEGACY_UNVERIFIED)
   and §5c (BUILD_SHA).

## 5e. Verification round 3 (review follow-up)

1. **Refund idempotency granularity.** operationKey now uses PER-TOOL
   canonical projections (`OPERATION_PROJECTIONS` in approval-requests.ts):
   `process_refund` keys on order + amount(or "full-remaining") + sorted line
   items×quantities + shipping flag + restock flag (+currency) - so a second
   legitimate partial refund, a shipping-only refund and the later
   full-remaining refund are DISTINCT operations, while an exact duplicate
   still dedups. `cancel_order` keys on the order alone (cancels once);
   coupons key on the code. Uncertain-retry safety comes from state
   reconciliation in the adapter (prior refunds consume quantities, requests
   cap at the gateway refundable maximum), not from the key.
2. **Proactive capability discovery.** `refreshCapabilityState()` runs the
   scope probe at the OAuth callback (a new store with missing merchant
   approvals never exposes an unusable write tool for even one turn), on the
   /test button, and from the bot tool surface whenever the persisted
   snapshot (`config.capabilityState`: grantedScopes, lastCheckedAt, status)
   is older than 6h - stale scope data is never trusted indefinitely. An
   inconclusive probe keeps the last KNOWN enforcement state.
3. **Business Rules authorization** is permission-first through the active
   membership: `settings:business-policies:read|manage|preview` (catalog
   entries), with the shared transitional admin-role fallback. Authorization
   + cross-tenant isolation tests: business-policies-authz.test.ts (7).
4. **Secure no-policy default** (`defaultDecisionWithoutPolicy`): with no
   configured policy, COMPENSATION/COUPON/DISCOUNT are DENIED (configuring a
   policy is the opt-in for proactive compensation); REFUND/CANCEL_ORDER stay
   requestable but always HITL-gated with provider-verified amounts;
   CUSTOMER_WRITE follows integration permissions. The Business Rules page
   shows each default to the admin. Engine errors still FAIL CLOSED.
5. **Outbox chokepoint sanitizer.** `sanitizeCustomerText()` runs in the
   outgoing-worker on EVERY outbound body for every channel and producer -
   no path can leak AI-signature punctuation even if it bypassed the
   generation-side humanizer. Character-level only; business facts are
   untouched (tested). Groundedness stays enforced at generation, where the
   verified facts exist.

### Customer-facing message path audit

| Producer | Path | Style/humanizer | Groundedness | Outbox sanitizer |
|---|---|---|---|---|
| Live bot replies | ai-bot.service generateAIBotReply | humanizeReply ✔ | ledger/facts blocks | ✔ |
| Post-execution continuations | /api/ai-bot/execution-message | humanizeReply ✔ | validateGroundedMessage + fallback ✔ | ✔ |
| Failed-action handling | no customer send (human handoff + inbox) | n/a | n/a | n/a |
| Follow-ups / scheduled sends | followup-generator → outgoing queue | generator-side | n/a | ✔ |
| Broadcasts / templates | broadcast.worker → outgoing queue | operator-authored | n/a | ✔ (body) |
| Business-hours / handoff / system texts | conversation/incoming-worker producers | static copy | n/a | ✔ |
| Voice callback texts | voice-callback → outgoing queue | n/a | n/a | ✔ |

Raw model output cannot reach a provider send without passing the worker
chokepoint; template COMPONENT parameters (provider-side templates) are the
one surface the body sanitizer does not rewrite - they are operator-authored,
noted as a residual.

## 6. Remaining limitations / follow-ups

- **`write_customers` scope needs merchant approval** in the Shopify Partner
  dashboard for the demo store - all customer writes 403 until granted (the
  integration UI does not yet surface per-scope status).
- Approved `custom.` / `custom_db.` tools still have no approval-resume
  executor (they fail visibly; wire their dispatchers if/when those tools get
  HITL policies).
- FAILED rows are retried only manually (button) - deliberate: an
  auto-retried refund after an ambiguous provider error is riskier than a
  human glance. The sweeper only rescues rows that never started.
- `search_products` filters in memory (title fragment), not server-side.
- Refund of a *cancel+refund* combination is atomic on Shopify's side via
  `cancel_order {refund:true}`; `process_refund` is the standalone path.

## 7. E2E verification (dev stack, urban-supply-gotcha-demo.myshopify.com, 2026-07-20)

The corrected Matan approvals were re-dispatched through the fixed path
(`/dispatch-approved`, same CAS state machine as the UI):

| Test | Result |
|---|---|
| Pre-state read (`shopify.get_order #1004`) | paid, unfulfilled, cancelled_at=null, $600 USD |
| Re-dispatch `cmrru4ld1…` cancel_order (#1004) | **executed: Shopify order REALLY cancelled** - cancelled_at 2026-07-20T09:26:40-04:00, cancel_reason=customer; row SUCCEEDED with real started/ended timestamps, attempts=2, sanitized result persisted (token `[redacted]`) |
| Customer continuation | ONE Hebrew WhatsApp message per approval, DELIVERED, linked via customer_message_id ("היי מתן, ביטלתי את ההזמנה שלך בהצלחה…") |
| Duplicate-cancel protection | a second approval for the same order executed concurrently → `already_cancelled: true` idempotent success, no Shopify 422, no double side effect |
| Full refund (`shopify.process_refund #1004`) | **refund_id 1143807934833, $600.00 USD, gateway=manual, transaction status=success → refund_status "processed"**, persisted + customer notified |
| Empty-params approval (the 13:25 HITL) | honest failure `order_id_or_name_required` → FAILED + human handoff (no fake success) |
| Compensation coupon | honest failure `shopify_403: requires merchant approval for read_price_rules scope` → FAILED visibly (see §6 scopes) |
| First re-dispatch attempt (before token-fallback fix) | failed honestly with "Missing or invalid authorization header", recorded FAILED attempts=1 - proving approval≠completion now holds even for infra failures |

Additional scope finding: `read_price_rules`/`write_price_rules` also need
merchant approval on this store - all coupon/discount tools 403 until
granted (alongside `write_customers`).
