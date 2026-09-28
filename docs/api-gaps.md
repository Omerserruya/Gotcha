# API Gap Report

Confirmed against the backend source. Home re-checked 2026-09-08; the rest
2026-09-06. Screen 00c added 2026-09-28, read from the design rather than from
the backend — it is the one section here describing capabilities that do not
exist yet rather than ones checked against source. Supersedes the earlier
inferred version — several entries there were wrong, and are corrected here.

Ordered by what they block.

---

## Home: five of the six gaps are now served

Re-checked against the backend source on 2026-09-08. The section below used to
read "Home cannot be built as designed". It no longer does — the backend built
the contracts, and closely to what was asked for.

| Home needs | Status |
|---|---|
| Today's counts split by handler | **Partial, unchanged.** `/api/analytics/overview` gives `aiHandledCount` / `humanHandledCount`, but `humanHandledCount` is `total − aiHandled`, not measured. Honest as a headline; not evidence about a specific agent. |
| Channel distribution | ✅ `/api/analytics/channel-performance` |
| Risk-ranked list needing a person | ✅ **`GET /api/analytics/queue/items`**. Per row: conversation id, customer, channel, preview, intent, `waitingSince`, urgency and a server-assigned `rank`, plus `nextCursor` and `totalWaiting`. The ranking is `packages/shared/src/lib/queue-ranking.ts` and is server-side, as asked. |
| Stream of completed AI actions | ✅ **`GET /api/analytics/activity`**. Merges tool executions with still-pending approvals into one timeline. Emits `kind` + `values`, never a rendered sentence — so it translates. |
| Time saved | ✅ **`GET /api/analytics/time-saved`**. Returns `secondsSaved` with a `basis`: conversations handled, seconds per conversation, whether that came from this tenant's history or the platform default, sample size and method. |
| Monthly conversation allowance | **Still missing.** `/api/usage/stats` and `/api/usage/by-tenant` are both `requireSystemAdmin()`, and neither returns a limit or period boundaries. Allowance lives in billing and has no tenant-facing endpoint. |
| Surfaced trend with a drafted response | **Dropped, by product decision.** Insight → draft is not being built; dormant customers route through the campaign flow instead (create → template approval → send). Do not re-add it. |

The three quiet-day cards are also served now:
`/api/analytics/unanswered-questions`, `/api/analytics/product-demand`,
`/api/analytics/dormant-customers`.

### What is left

Three, all of them on Home.

1. **Monthly allowance.** `/api/usage/stats` and `/api/usage/by-tenant` are both
   `requireSystemAdmin()` and neither returns a limit or period boundaries. The
   design draws a progress bar and "at today's pace that lasts until 12
   September" inside the dark card. Needs: used, limit and period boundaries on
   an endpoint an ordinary member can call.

2. **The "right now" line.** The dark card opens with *"Right now: answering 9
   conversations, checking 4 orders, and holding 3 actions for your approval."*
   That is present tense and nothing serves it. `/api/analytics/activity` is
   past tense — what happened, in order — and `queue` counts customers waiting,
   not work in flight. Needs: in-flight conversations the AI is handling,
   in-flight tool calls grouped by subject, and pending approvals.

3. **Insights cannot be translated.** `/api/analytics/insights` composes English
   prose with the numbers already inside it:

   ```ts
   title: `Automate "${top.detectedIntent}" responses`,
   description: `The intent "${top.detectedIntent}" appeared ${count} times in
                 the last 30 days. Creating an automated flow could reduce
                 agent workload significantly.`
   ```

   On a Hebrew screen that renders English. This is the same problem the
   activity stream had, and it was solved there — `activity-events.ts` emits
   `kind` + `values` and lets the client own the wording, for exactly the
   reason stated in its own header comment. Insights need the same treatment:
   a `kind` and the values, not a sentence. Until then "Worth knowing" cannot
   be built without putting untranslated English on the screen.

### Open product decision, not a gap

`REPEAT_WEIGHT_MINUTES` in the ranker is 20. Four messages in five minutes
scores 65; one message waiting 90 minutes scores 90 — so the person who has
written four times sits below the person who wrote once. Raising it to ~45
inverts that. This is a product call, not a defect, and has not been changed.

---

## Blocking: screen 00c has no backend at all, and no ruling either

Self-service sign-up. Read out of
`design/Redesigning GOTCHA from scratch 5/GOTCHA Directions.dc.html` on
2026-09-28 so the next person does not have to parse HTML for it.

**What the screen is.** *"Create a workspace — everything an account needs, and
not one field more."* Six fields, all required: name, business name, work
email, password, mobile, website. Business type, team size and message volume
are never asked — GOTCHA works them out from the website in the next step. The
mobile is verified by code **in the same panel**, straight after submit,
because recovery and two-step both run on it. Password strength is a live
score against length and known breaches, not a submit-time rejection. Region,
language, currency and timezone are detected and overridable.

Two behaviours that are easy to miss and are the point of the screen:

- ★ **The workspace is created able to read but not to send.** Nothing reaches
  a customer until a person turns it on.
- Submitting goes **straight into guided setup**, never an empty dashboard.
- Invited users never see this screen; an invitation carries workspace, role
  and team and lands on a single name-and-password step.

**What it needs from the backend — none of which exists:**

| 00c needs | Status |
|---|---|
| create workspace + owner user in **one** call (name, business, email, password, mobile, website) | Missing |
| password policy + breach check, returned as a **live score** | Missing |
| email verification link **and** mobile verification code, both issued on create | Missing |
| region / language / currency / timezone detected server-side, overridable | Missing |
| consent record: terms + DPA version, authority claim, timestamp, IP | Missing |
| duplicate detection: existing workspace on this email domain, with a request-to-join path | Missing |
| invitation acceptance carrying workspace, role and team | Missing |
| name / subdomain availability check | Missing |
| workspace created in a **cannot-send** state with an explicit activation step | Missing |

No site-ownership proof is required at this stage — reading a public page needs
none.

**What the app does today.** `auth.signIn.footnote` reads *"New here? Ask your
workspace admin for an invitation."* There is no create-workspace route, link
or copy beyond that line. The screen is absent rather than half-built, and
that footnote is itself a product statement nobody has ruled on.

⚠ **AND THERE IS NO RECORDED RULING ON ANY OF THIS.** A "00c redirects to a
waitlist" decision was relayed between sessions and **cannot be sourced** — not
in `src/`, not here, not in any commit message, not in the design. It is
written down now as *unsourced*, because a ruling that was made and never
recorded is indistinguishable from one that never happened, and the next
person to ask will otherwise inherit it as settled.

★ **Why this is worth a decision rather than a backlog entry:** building 00c
means a **public, unauthenticated write endpoint that creates tenants**, and
since 2026-09-28 sign-in is served from its own origin. Every other write in
this app sits behind a session. That is a materially different surface from
anything now on that host.

## Blocking: realtime cannot be authenticated from a browser

`services/conversation/src/lib/socket.ts` expects the access token in the
handshake:

```js
io('/', { auth: { token: '<access token>', tenantId: '<active tenant>' } })
```

The token is in an HttpOnly cookie by design, so JavaScript cannot read it to
put it there. **There is no ticket endpoint.** Confirmed as a real gap, not an
oversight on the frontend side.

**Recommended:** `POST /api/realtime/ticket` returning a short-lived,
single-use token scoped to the caller's tenant. The browser can hold that
safely; it cannot hold a bearer token.

Until then `src/realtime` stays dormant: the transport reports `failed` rather
than shipping a workaround that puts a bearer token within reach of scripts.

### Confirmed event catalogue

`message:new` · `message:status` · `tool.execution.proposed` ·
`tool.execution.started|completed|failed|approved|denied` ·
`visitor:message` · `visitor:conversation` (storefront only)

Rooms are joined server-side on connect — `tenant:<id>` and `user:<id>`. No
client-side join, no namespaces. **Nothing fires for conversation-assigned**,
which the design's ownership model needs. No replay after reconnect: refetch.

---

## Resolved: the session flow is a feature flag

`/api/auth/login`, `/api/auth/callback` and `/api/auth/logout` return 404
because `SESSION_COOKIE_CREATE` defaults to false (`session-flags.ts:29`), not
because they are unrouted.

**The frontend is not expected to be the OIDC relying party.** The current
`src/auth/oidc.ts` implementation was built on the opposite assumption and
should be removed once the flag is enabled on dev — which also removes the need
for an Authentik client id and secret entirely.

**Action: enable `SESSION_COOKIE_CREATE=true` on dev.**

---

## Contract corrections

Things the frontend had wrong, now fixed.

### Permissions are exact-match

Format is always `domain:resource:action`. **No wildcards, no implication** —
`conversation:messages` grants nothing; only `conversation:messages:read` does.
`SYSTEM_ADMIN` short-circuits to every key.

`PermissionSet` previously implemented prefix implication and wildcards,
inferred from the word "hierarchical" in the API docs. That was wrong in the
dangerous direction: it would have shown controls to people who cannot use
them, turning every denial into a 403 after the click instead of a disabled
control before it. Corrected, and the tests now assert the absence of
implication.

### The `{ data }` envelope is not universal

410 handlers use it, 743 answer bare. `/api/auth/me` and
`/api/action-planner/*` are bare; `/api/analytics/*` is enveloped. The
transport unwraps `data` when present and passes the body through otherwise —
a defensive choice that turned out to be load-bearing.

### `/api/agent/run` is SSE, not JSON

`Content-Type: text/event-stream`. The OpenAPI `EnvelopeUnknown` typing is
wrong, not merely vague. It is a POST, so `EventSource` cannot be used —
`fetch` + `ReadableStream`. Heartbeat `: ping` every 25s because nginx closes
idle SSE at 60s, so no client timeout below ~2 minutes.

### Conversation status values

`OPEN | WAITING | CLOSED` only. `WAITING_FOR_CUSTOMER` and `REQUIRES_APPROVAL`
belong to a different model and are not `ConversationStatus`.

### No correlation id

Nothing sets or reads `x-request-id`. The transport still generates one for
its own error grouping, but it will not appear in backend logs.

**Recommended:** echo an inbound `x-request-id`, generate one when absent, and
include it in server logs. It is the difference between "it failed" and a log
lookup.

---

## Do not build on

**`/api/action-planner/approvals`** reads `auditLog` rows and filters them in
JS *after* `take: 100`, so it silently under-reports. It is not the same set of
objects as `/api/approvals`. Use `/api/approvals`.

**`POST /api/agent/clear`** deletes every `systemAgentMessage` row for
`(tenantId, userId)` — all sessions, not the current one. Any UI for it needs
to say so before it runs.

**`execute` idempotency** is best-effort: `idempotencyKey` is checked with a
non-atomic `findFirst`, so two concurrent retries can both pass. Do not rely on
it to make a refund safe to retry.

---

## Confirmed shapes

```jsonc
// GET /api/auth/me — bare, no envelope
{ "user": { "id","email","name","role","tenantId","identityId" },
  "tenantStatus": "ACTIVE", "tenantName": "…", "memberships": [ … ] }

// GET /api/permissions/me — enveloped
{ "data": { "role", "roleKey", "permissions": [], "scope", "features": [] } }

// GET /api/analytics/overview?from&to — enveloped
{ "data": { "totalConversations","resolvedConversations","resolutionRate",
            "avgResponseTimeMs","avgResolutionTimeMs","aiHandledCount",
            "humanHandledCount","aiHandledPct","totalMessages",
            "deltas": { … }, "period": { "from","to" } } }
```

`POST /api/auth/me/switch-tenant` takes `{ tenantId }`.
`POST /api/auth/logout` takes no body.
There is no avatar field on the user; initials are correct.

## Freshness

`dashboard` / `agents` / `daily` / `hourly` read **Redis counters**;
`overview` / `insights` / `channel-performance` query **Postgres live**. Two
figures on the same screen can disagree. Worth knowing before putting them
side by side.
