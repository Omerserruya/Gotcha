# Shopify end-to-end audit

**Date:** 2026-08-04
**Branch:** `feat/shopify-summary-note-and-commerce-brief`
**Scope:** the seven areas requested: Partner app link, other channels, Shopify
tools, conversation summary → Shopify customer note, agent workspace parity,
customer brief from store data, plans/billing/credits.

Every claim below is grounded in a file that was read or a command that was
run. Where something is not done, it says so.

---

## Verdict per area

| # | Area | State |
|---|------|-------|
| 1 | Production Partner app linked | **NOT DONE — blocked on you** |
| 2 | Other channels connectable | **OK** (3 provider credentials unset in prod) |
| 3 | Shopify tools | **OK** |
| 4 | Summary written to Shopify customer | **WAS BROKEN → FIXED** |
| 5 | Agent works without leaving Shopify | **PARTIAL → returns/exchanges added** |
| 6 | Customer brief uses store data | **WAS ABSENT → BUILT** |
| 7 | Plans, billing, credit enforcement | **OK** |

---

## 1. Production Partner app — not linked

`shopify-app/shopify.app.toml` has **no `client_id`**, and in `.env.prod` both
`SHOPIFY_CHAT_APP_CLIENT_ID` and `SHOPIFY_CHAT_APP_SECRET` are present but
**empty**. Only the DEV app exists (`96c9417a…`, bound to `dev.gotcha.co.il`).

`node scripts/shopify/verify-chat-app-identity.mjs` refuses, correctly.

This needs an interactive Partner-account browser login (`shopify app config
link`), which cannot be automated. Runbook:
`docs/setup/shopify-chat-app-production-link.md`.

Until this is done there is **no production Shopify chat app**, so no
end-to-end production verification is possible. Everything else below is
verified by test suite, not against a live production store.

---

## 2. Other channels — code complete

All ten `ChannelType` values have an adapter in
`packages/shared/src/channels/` and a connect surface in
`frontend/src/app/channels/content.tsx`: WhatsApp, Messenger, Instagram, Email,
Gmail, Outlook, Slack, Voice, Webchat, Shopify Live Chat. OAuth flows exist for
Messenger / Instagram / Gmail / Outlook / Slack; the page shows a
`requiresSetup` hint when the platform credential is absent rather than
offering a button that fails.

**Gap, and it is configuration not code** — these are unset in `.env.prod`:

- `MICROSOFT_CLIENT_ID` (Outlook cannot be connected)
- `TWILIO_ACCOUNT_SID`
- `SENDGRID_API_KEY`

Set (Meta, Instagram, Google, Slack) are fine.

---

## 3. Shopify tools — healthy

45+ dotted `shopify.*` tools. `services/ai/src/__tests__/shopify-tool-parity.test.ts`
enforces that **every declared tool reaches a real handler**, which is the class
of bug (`update_order_fulfillment` declared for months with no switch case)
that made the test necessary. 88 parity assertions pass.

Write paths verify against re-fetched Shopify state rather than inferring
success from a transport 200, and retries short-circuit on already-cancelled /
already-refunded / existing-coupon. 114 tests pass across the three Shopify
adapter suites.

One real defect found and fixed here: **`shopify.create_note` appended
blindly**, so a redelivered post-chat run duplicated a note into
`customer.note` — a single free-text field every future note appends to —
permanently. It now skips when the caller's idempotency marker is already
present. Unmarked notes still append every time, because a human note has no
idempotency key and swallowing the second one would lose it.

---

## 4. Conversation summary → Shopify customer note — was broken, now fixed

**The summary never reached Shopify.** The post-chat pipeline persisted it
GOTCHA-side only (`CallAnalysis.finalSummary`, `Conversation.aiSummary`). Its
only vendor write was the sparse FIELD patch, and `applyCrmPatchKindAware`
writes a note **only when that patch fails** — which on Shopify it does not,
because `updateRecord` maps to a real `shopify.update_customer` call.

Net effect: a merchant reading their own Shopify customer record found no trace
of the conversation and had to come back to GOTCHA to learn what happened.

Fixed by `writeSummaryNoteKindAware`, a separate explicit write, ordered
**after** the field patch (`shopify.create_note` is a read-modify-write on
`customer.note`, so going second keeps it from racing the field update) and
best-effort (a rate-limited store costs the note, never the tasks or the
follow-up). Idempotency is keyed `<conversationId>:summary`, distinct from the
patch's key so a retry of one cannot suppress the other.

Entitlement is unchanged: the whole pipeline is already gated on
`communication.crm_summaries`.

---

## 5. Agent workspace parity — was 5 actions, now 7

The panel had: cancel, refund, add tag, remove tag, add note. The AI had ~45
tools. Returns and exchanges — the highest-volume support request a store gets
— were absent, so an agent finished those in Shopify admin and left the
conversation context, the audit trail and the customer notification behind.

Added `create_return` and `exchange_item` on the same hardened chain
(permission → ownership re-validation → live reconcile → business policy →
optional HITL → idempotent dispatch → post-action verify → audit).

Three things were not obvious:

- **A return is the mirror of a cancel, not a variant of it.** A cancel needs
  an order that has not shipped; a return needs one that has. An exchange is an
  order *edit*, so it shares the cancel window and dies at shipping. The two
  are mutually exclusive by order state and the panel never shows both.
- **Re-reading the order proves nothing about a return.** A return is a
  separate Shopify object and changes no order field, so the existing
  `financial_status.includes("refunded")` check would have reported every
  successful return as unverified.
- **Returns are their own Shopify scope.** A store can grant `write_orders` and
  still refuse the returns API. `canReturn` now requires `write_returns` too
  and reports it as missing rather than offering a button that fails.

`OrderLineDetail` also gained `lineItemId`, without which the only expressible
return was "all of it" — the wrong answer to a three-item order with one faulty
item.

**Still not in the panel** (the AI can do these, a human cannot): order edits,
shipping-address change, fulfillment/tracking updates, discount codes,
compensation coupons, invoices, draft orders. You scoped this round to returns
and exchanges.

---

## 6. Customer brief from store data — was absent, now built

`customer-brief.service.ts` had **zero** commerce signals — grepping it for
`shopify|orders|total_spent|engagement|commerce` returned nothing. The brief
reasoned only from conversation evidence, so a first-time shopper and someone
who had spent 8,400 read identically to the agent about to talk to them.

`customer-commerce-facts.service.ts` now computes, in code:

lifetime order count, lifetime spend, average order value, last order date and
days since, first seen order, merchant tags, order states needing attention
(refunded / cancelled / unfulfilled), recent orders, and a coarse engagement
band.

Design decisions worth knowing:

- **The model computes none of these.** An average order value is arithmetic;
  asking an LLM for one invites a confident wrong number in front of an agent
  who will repeat it to the customer. The prompt receives them as fact with an
  explicit "do not recalculate".
- **Lifetime totals come from the customer record, not from summing fetched
  orders.** That read is a 10-order page; summing it would understate a
  long-history customer.
- **`lapsed` is checked before `loyal`.** Someone who bought five times and
  then vanished for a year needs the silence surfaced more than the five
  orders.
- **Facts are not persisted on the brief row.** They would go stale, and
  `CommerceContextPanel` already shows live figures.

Reads go through the resolved CRM adapter, so no new commerce credential and no
direct vendor access.

---

## 7. Plans, billing, credits — healthy

Audited and found already built:

- **Hard block at zero.** `packages/shared/src/lib/billing/enforcement.ts`
  throws `AiUnitsExhaustedError`; `entitlement-gate.ts:336` blocks on
  `balance <= 0 || balance < requiredCredits`.
- **Auto-recharge exists** as `AutoPurchasePolicy` per billable entity, with a
  spend **ceiling** and its own event taxonomy
  (`credit.auto_purchase_succeeded` / `_failed` / `_ceiling_reached`).
  Plan-gated via `autoPurchaseEligible`.
- **Auto-renewal runs.** `services/billing` starts a scheduler on an interval
  (`BILLING_SCHEDULER_ENABLED`, default on) covering renewals, dunning, usage
  settlement, reconciliation. `autoRenew` on the plan template drives
  `cancelAtPeriodEnd`.
- **Failed renewals do not silently lapse.** A dunning ladder
  (`BILLING_DUNNING_DAYS`, default `0,3,7`) retries, then suspends.
- **The service is deployed.** `billing` is present in
  `docker-compose.prod.yml` with an explicit comment about why its absence
  breaks onboarding and the billing UI.

No defects found here. Not re-verified against live payment provider traffic.

---

## Test state

Established against a stashed baseline rather than assumed:

| Package | Before | After |
|---|---|---|
| `packages/shared` | 54 failing | 54 failing (identical, pre-existing) |
| `services/ai` | 41 failing / 2171 passing | 41 failing / 2210 passing |
| `frontend` commerce suite | 43 passing | 54 passing |

The pre-existing failures are DB-dependent billing tests and exhaustive-mock
hygiene (`resolveEffectiveLocale` missing from a `@chatcenter/shared` mock).
They are unrelated to this work and were not touched.

Three fixtures were **corrected rather than force-passed**: they asserted
"nothing missing" while granting `canReturn` without `write_returns`, which is
a state the server should and does report as incomplete.
