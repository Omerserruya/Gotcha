# Home — what is still missing, by screen

Checked against the backend source and the running gateway on 2026-09-09, after
the twelve-item delivery. Split into what the **backend** still owes, what the
**frontend** still owes, and what needs a **product decision**, so each list can
go to the right place.

---

## A. Backend

### A0. The day-one endpoints are gated behind being live — blocking 01c

This is the one to fix first, and it is small.

```ts
// services/auth/src/routes/setup-state.ts:23
router.use("/setup/state", authenticate, resolveTenant, requireActiveTenant());

// services/ai/src/routes/knowledge-ingest.ts:18
router.use("/knowledge/ingest/latest", authenticate, resolveTenant, requireActiveTenant());
```

`requireActiveTenant()` is `gate("FULL_APPLICATION")` — tenant status `ACTIVE`
**and** an active plan.

Screen 01c is *"a new workspace, before there is anything to report"*. Such a
workspace is `PENDING_ONBOARDING` or `PENDING_PAYMENT`, and often has no plan
yet. **The endpoint that powers the day-one screen cannot be called by a
workspace on day one.** `PENDING_ONBOARDING` gets 403; a tenant with no plan
gets 402 `TENANT_PLAN_REQUIRED` — the exact error we spent yesterday tracing.

The right middleware already exists and its own comment describes this
chicken-and-egg case:

```ts
// packages/shared/src/middleware/tenant-status.ts:105
// Endpoints that must be reachable DURING onboarding — notably connecting the
// "source of truth" core system, which is itself the activation event.
```

`GET /api/integrations/commerce/capabilities` already uses
`requireOnboardingOrActiveTenant()`. This is an inconsistency between sibling
endpoints, not a missing idea.

**Asked for:** `requireOnboardingOrActiveTenant()` on `/api/setup/state` and
`/api/knowledge/ingest/latest`. `/api/usage/allowance` can stay as it is —
allowance is a paid concept and a tenant without a plan legitimately has none.

### A1. 01b — nothing ranks across the four quiet-day cards

The design: *"'Worth an hour, while it is quiet' is generated from Knowledge
gaps, Analytics trends and stock signals — **ranked by how much future work each
removes**."*

Four sources, four different units: 33 people asked a question, N customers
affected by a conflict, 640 dormant customers, 22 requests for an unstocked
product. Nothing puts them in one order.

This is the same argument as the queue: ranking belongs server-side, or Home and
any other surface showing the same list will disagree. If a cross-source ranker
is too much, say so and give each card a comparable `wouldRemoveConversations`
estimate — the client can then sort on one number rather than inventing weights
for four.

### A2. 01b — unanswered questions has no date range

The card reads *"Four questions it could not answer **this week**"*.
`GET /api/analytics/unanswered-questions` takes `limit` and `includeResolved`
only. Either `from`/`to`, or a `weekKey` like `product-demand` already returns.

### A3. 01b — "Second week running" has no history

The stock card reads *"22 people asked for navy towels this week. You do not
stock them. **Second week running.**"* `product-demand` answers one week at a
time. Needs consecutive-week presence per term — a `weeksRunning` count is
enough; the full history is not.

### A4. 01c — step 3 shows topics, the endpoint returns counts

The step reads *"26 answers are ready to use. 12 need your word — **returns
window, wholesale pricing, and delivery to the north**."*
`/api/knowledge/ingest/latest` returns `pagesRead`, `answersDrafted`,
`answersNeedingConfirmation` — three numbers and no subjects.

**Asked for:** the topics of the pending candidates, as codes or short labels
plus their ids, so the line can be written in Hebrew too.

### A5. 01c — step 8 names people, nothing supplies them

*"Invite your team — **Tomer and Shira** are on your contact page."*
Those come from the site scan. `GET /api/onboarding/discovery` may already hold
them, but it is `requireRole("ADMIN")` and its shape is not documented.

**To confirm rather than build:** does discovery already carry contact names,
and can that subset be exposed on the day-one path?

---

## B. Frontend — mine

1. **01b's copy is stale.** The quiet-day card still says the three cards have
   no backend source. `unanswered-questions`, `product-demand` and
   `dormant-customers` all exist. `worthKnowing.blocked` is a dead key.
2. **01b's three cards are not built** — only conflicts is.
3. **01c is not built at all.** Every endpoint exists (subject to A0); the block
   does not.
4. **01d is a page, the design draws an overlay** — `position:absolute;
   inset-inline-end:22px; inline-size:440px; radius:16px`. The trigger's
   location is also undecided.
5. Everything is **uncommitted** — one commit in the repo.

---

## C. Product decisions

1. **`dormant-customers` for agents.** It moved under
   `analytics:workspace:read`, so agents can pull a list of customer names and
   phone numbers. The reasoning — they already hold `crm:contacts:read` — is
   true today and stops being true if anyone narrows that permission.
2. **Repeat weight in the queue ranking** is 20 minutes. Four messages in five
   minutes scores 65; one message waiting 90 minutes scores 90. The customer who
   wrote four times sits below the one who wrote once. ~45 inverts it.
3. **01c step 7** claims *"a third of your questions arrive there"* about
   channels that are **not connected yet**. Nothing can know that. Either it
   becomes a generic line, or the step drops the claim.

---

## Already settled — do not re-open

- **Insight → draft is dropped.** Dormant customers route through the campaign
  flow: create → template approval → send. No `insights/{id}/draft/send`; it
  would duplicate `/api/broadcasts`.
- **01c step descriptions stay in the frontend**, keyed on step id. The backend
  returns state, not prose — that is why insights had to be reshaped.
