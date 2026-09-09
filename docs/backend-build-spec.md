# Build spec — Auth and Home

What the frontend needs and the platform does not have. Only gaps: anything
already served is left out, and where an existing endpoint might already cover
a need, that is said instead of proposing a duplicate.

**Conventions assumed:** `{ data: … }` envelope · `limit` + `cursor`
pagination returning `nextCursor` · ISO-8601 instants · **stable enum codes,
never display strings** — the frontend translates, and a sentence rendered
server-side cannot be shown in Hebrew.

---

## 0 · Config only, no code

**Expose `/api/intelligence-reviews` through the gateway.**

Marked `x-publicly-exposed: false`, so it 404s. The handler, `approve` and
`reject` all exist and the frontend for it is written. Filtering
`reason === "conflict"` is exactly the "two sources still disagree" card on
Home's quiet day. **A routing change unblocks a finished feature.**

---

## 1 · Confirm before building

Three needs may already be served. If they are, nothing is built.

### 1.1 Monthly allowance → is this `GET /api/billing/credit-summary`?

Its own description says *"Canonical customer-facing credit contract — ONE
source for every number the Usage/Billing UI shows… Read-only for any tenant
member."*

Home's activity card draws a progress bar reading *"Conversations left this
month — 1,840"*. If `credit-summary` carries used / included / remaining and
the period boundaries, **use it and build nothing.** Please confirm the shape.

### 1.2 Ranked queue → can `GET /api/conversations` do it?

The parameters are undeclared. If it already filters to unassigned
`OPEN | WAITING` and can sort, the gap is only the fields listed in 2.1 —
not a new endpoint.

### 1.3 Team workload → is `GET /api/conversations/stats/workload` the team panel?

Undeclared shape. If it returns per-agent open counts, it overlaps
`/api/analytics/agents` and one of the two should be the answer.

---

## 2 · Build

### 2.1 Ranked queue rows

`/api/analytics/queue` returns `{ waiting, avgWaitTimeMs }` — two scalars.
Home's "Needs you now" needs rows, and each carries the five things an operator
decides on: who, where, what, how urgent, how long.

Either extend `GET /api/conversations` (see 1.2) or add:

```jsonc
// GET /api/analytics/queue/items?limit=20&cursor=…
{ "data": [{
    "conversationId": "conv_…",
    "customer": { "id": "cus_…", "name": "Dana Cohen" },
    "channel": "whatsapp",
    "preview": "Third message about order #1842 — refund requested",
    "intent": "FRUSTRATED",
    "waitingSince": "2026-09-07T09:48:00Z",
    "rank": 1,
    "urgency": "high"                    // high | medium | low | none
  }],
  "nextCursor": null,
  "totalWaiting": 14 }
```

**Ranking must be server-side.** If the client ranks, two surfaces showing the
same queue disagree.

### 2.2 Activity stream

`/api/analytics/tool-usage` is aggregated — `{ toolName, executionCount,
successRate, avgDurationMs }`. The card needs a time-ordered list, each entry
readable as a sentence.

```jsonc
// GET /api/analytics/activity?limit=20&cursor=…
{ "data": [{
    "id": "act_…",
    "at": "2026-09-07T08:12:00Z",
    "outcome": "completed",              // completed | failed | awaiting_approval
    "kind": "refund.completed",
    "values": { "amount": 179, "currency": "ILS", "customer": "Dana Cohen" },
    "subject": { "type": "order", "id": "1842" },
    "conversationId": "conv_…"
  }],
  "nextCursor": null }
```

`kind` + `values`, not a rendered sentence — the line is composed per locale.

### 2.3 Time saved

Not computed anywhere.

```jsonc
// GET /api/analytics/time-saved?from&to
{ "data": { "secondsSaved": 22800,
            "basis": { "conversationsHandled": 367, "secondsPerConversation": 62 } } }
```

`basis` is required. The figure sits on the product's first screen; a number
nobody can derive is a number nobody trusts.

### 2.4 Agent presence

`AgentPresence` and its enum already exist. The only writer is the voice
service and nothing reads it, so today it would report everyone offline.

```jsonc
// GET /api/agents/presence
{ "data": [{
    "agentId": "usr_…",
    "status": "ONLINE",                  // ONLINE | BUSY | AWAY | OFFLINE
    "lastSeenAt": "2026-09-07T10:31:00Z",
    "awayUntil": null,
    "departmentName": "Wholesale"        // nullable — an agent may have several
  }] }

// POST /api/agents/presence/heartbeat → { "ok": true }
```

`AWAY` and `awayUntil` are additions; the design shows *"away until 11:00"*
and the current enum has no away state.

### 2.5 Realtime ticket

Short-lived, single-use, tenant-scoped.

```jsonc
// POST /api/realtime/ticket
{ "data": { "ticket": "…", "expiresInSeconds": 60 } }
```

Unblocks **both** Socket.IO (`handshake.auth.token`) and the notifications
`ws` server (`?token=`). Both currently want a bearer token that a browser
cannot supply, because it is in an HttpOnly cookie by design — which is the
reason XSS cannot steal it.

### 2.6 System health

*"Everything is running"* is a claim about the system. Asserting it without
checking is worse than omitting it, which is why it is currently omitted.

```jsonc
// GET /api/health/summary
{ "data": { "ok": true,
            "degraded": [{ "system": "shopify", "reason": "disconnected",
                           "since": "2026-09-07T06:00:00Z" }] } }
```

### 2.7 Last handover

`Conversation.handledBy` is a string with no timestamp and no transition
history, so *"Last handover 3 hours ago"* cannot be derived.

```jsonc
// GET /api/conversations/handovers/latest
{ "data": { "at": "2026-09-07T07:40:00Z", "from": "ai_agent", "to": "human" } }
```

### 2.8 Questions GOTCHA could not answer

`/api/analytics/top-questions` cannot serve this: `question` is the intent slug
repeated, `automatable` is literally `count > 5`, and it ranks by frequency
with no concept of failure.

```jsonc
// GET /api/analytics/unanswered?from&to
{ "data": [{
    "id": "unans_…",
    "question": "What is the dispatch cut-off?",
    "askedBy": 33,
    "lastAskedAt": "2026-09-06T16:20:00Z",
    "reason": "no_knowledge"             // no_knowledge | low_confidence | conflicting
  }] }
```

### 2.9 Dormant customers

```jsonc
// GET /api/customers/dormant?since=2026-03-01
{ "data": { "count": 640, "since": "2026-03-01",
            "audienceRef": "aud_dormant_since_spring" } }
```

**Returns an audience, never a message.** Reaching 640 people who have not been
in touch is a campaign: per-customer variables, and on WhatsApp a
business-initiated message outside the 24-hour window needs a Meta-approved
template.

All of that exists — `/api/broadcasts`, `/api/templates` with
`submit-to-meta`, `/api/audiences/preview`, `/api/scheduled-messages`. This
endpoint only names the audience so the card can hand off.

**The card's action enters that flow rather than bypassing it:**

```
GET  /api/customers/dormant                → count + audienceRef
  ↓  opens Outreach with the audience pre-selected
POST /api/broadcasts                       → create
POST /api/templates/{id}/submit-to-meta    → template goes for approval
  ↓  waits — nothing sends until Meta approves
POST /api/broadcasts/{id}/validate
POST /api/broadcasts/{id}/send
```

The waiting step is why this cannot be one button. A campaign whose template is
pending must be visible as pending — **please confirm the approval state is
readable from `GET /api/templates/{id}`.**

### 2.10 Unmet demand

*"22 people asked for navy towels this week. You do not stock them."* Product
mentions matched against the commerce catalogue. Nothing comparable exists.

```jsonc
// GET /api/analytics/unmet-demand?from&to
{ "data": [{ "term": "navy towels", "askedBy": 22,
             "weeksRunning": 2, "inCatalogue": false }] }
```

---

## 3 · Extend

### 3.1 `GET /api/analytics/overview` — one field

```jsonc
"pendingApprovalCount": 3
```

The metric strip's fourth figure. Currently renders an em dash.

### 3.2 `GET /api/analytics/insights` — one action

```
POST /api/analytics/insights/{id}/dismiss → { "ok": true }
```

**Deliberately not requested: a drafted response.** An earlier draft of this
spec asked for a `draft` on each insight with a `send` beside it. That would
have been a second, worse outbound path alongside `/api/broadcasts` — no
validation, no template approval, no audience preview, no cancellation. The
"Worth knowing" card is therefore informational: the trend, and Dismiss. If it
should act, its action belongs in Outreach through the flow in 2.9.

### 3.3 `GET /api/notifications` — typed, not free text

```jsonc
"eventType": "APPROVAL_REQUIRED",
"target": { "type": "conversation", "id": "conv_…" }
```

```
eventType:    APPROVAL_REQUIRED | ACTION_FAILED | INTEGRATION_DISCONNECTED
            | AI_PAUSED | CAMPAIGN_COMPLETED | COMPLAINT_SPIKE
target.type:  conversation | approval | integration | campaign | none
```

`eventType` is a plain `String` column today, written straight through from the
producing event; none of the six above are emitted, so nothing can branch on
it. `link` is free text with no typed id behind it — the frontend validates it
as an internal path before use, but a typed reference is safer and lets the
interface render the right affordance.

### 3.4 Per-user notification preferences

`/api/notification-preferences` is tenant-admin routing — which events go to
whom. A user cannot set their own, and `whatsapp` is not among the channels.

```
GET   /api/notification-preferences/me
PATCH /api/notification-preferences/me
{ "data": { "inApp": true, "email": true, "whatsapp": false,
            "approvals": true, "quietHours": { "from": "22:00", "to": "07:00" } } }
```

---

## 4 · Publish — endpoints that work but declare no shape

No code. A sample response for each is enough; the frontend is currently
guessing.

| Endpoint | Needed for |
|---|---|
| `GET /api/onboarding/status` | Home · day one — the whole setup block |
| `GET /api/onboarding/discovery` | pages read, answers drafted, answers needing confirmation |
| `GET /api/channels/summary` | connected channels and verification state |
| `GET /api/integrations` | commerce capability flags: read orders, refund, cancel, track |
| `GET /api/auth/setup/{token}` | invitation acceptance — workspace, role, team, expiry |
| `GET /api/templates/{id}` | template approval state, for 2.9 |
| `GET /api/billing/credit-summary` | the allowance, if 1.1 is confirmed |
| `GET /api/conversations` | its query parameters, for 1.2 |
| `GET /api/conversations/stats/workload` | the team panel, if 1.3 is confirmed |

For `/api/onboarding/status`, the screen consumes:

```jsonc
{ "data": {
    "isLive": false,
    "setupMode": true,
    "trial": { "daysLeft": 14, "conversationsUsed": 12, "conversationsLimit": 500 },
    "goLive": { "eligible": false, "blockedBy": ["connect_store", "handover_rules"] },
    "steps": [{
      "id": "confirm_knowledge",
      "title": "Confirm what GOTCHA learned",
      "detail": "26 answers are ready to use. 12 need your word.",
      "state": "next",                   // done | next | waiting | blocked
      "completedAt": null,
      "actionLabel": "Review 12 answers",
      "actionHref": "/studio/knowledge?review=pending",
      "estimateMinutes": 4
    }]
} }
```

Two invariants the screen depends on: **exactly one step is `next`**, and
`actionHref` is an in-app path — the design is explicit that every step
completes in place and never abandons the user in Settings.

### Also publish: the intent enum

`detectedIntent` exists on the conversation. Queue rows and message chips need
its domain:

```
FRUSTRATED · HIGH_INTENT · WAITING_EXTERNAL · ORDER_CHANGE · RETURN ·
REFUND · SHIPPING_ISSUE · PRODUCT_QUESTION · COMPLAINT · OTHER
```

---

## 5 · Product decision, not a contract

**No unauthenticated endpoint creates a workspace.** Every
`/api/public/onboarding/*` route requires `bearerAuth` despite the name, so the
"Create a workspace" screen cannot be built as designed.

If self-service signup should work:

```jsonc
// POST /api/signup   (no auth)
{ "name": "…", "email": "…", "businessName": "…", "website": "…" }
→ 201 { "workspaceId": "…", "redirectTo": "/api/auth/login?next=/home" }
→ 409 { "error": "email_in_use" }
```

The workspace must be created able to read but not to send, with an explicit
activation step.

If signup stays closed, `POST /api/waitlist` already works and the screen
becomes a waitlist. Either is buildable — it needs deciding.

---

## 6 · Blocking local development

Not an endpoint. `GET /api/auth/login` redirects with a fixed
`redirect_uri=https://dev.gotcha.co.il/api/auth/callback`, so the session
cookie lands on that host and a frontend on `localhost:3000` never receives it.
Every authenticated screen is unreachable in development, and every screenshot
so far shows an empty state for this reason alone.

**Two answers may resolve it with no code:**

1. What is the session cookie's `Domain`? If `.gotcha.co.il` rather than
   host-only, a developer serves the app on `local.gotcha.co.il:3000` via
   `/etc/hosts` and the cookie is shared.
2. Does the callback's `returnTo` accept an absolute URL on another host under
   that domain?

If both are no, the smallest fix is `GET /api/auth/login?redirectUri=…`
against an allow-list, plus `http://localhost:3000/api/auth/callback`
registered on the `gotcha-app` client in Authentik.

---

## Order

| | Cost | Unblocks |
|---|---|---|
| §6 cookie domain | **a reply** | all local development |
| §0 expose intelligence-reviews | config | a finished feature |
| §1 confirm three overlaps | a reply | may remove three builds |
| 3.1 `pendingApprovalCount` | one field | a metric-strip figure |
| 2.5 realtime ticket | small | Socket.IO **and** notifications `ws` |
| 2.4 agent presence | small — model exists | the team panel |
| §4 publish shapes | documentation | Home · day one, invitations |
| 2.1 queue rows | medium | Home's entire left column |
| 2.2 activity | medium | the activity card |
| 2.3 time saved | medium — needs a definition | that card's footer |
| 3.3 notification enum | small | correct routing |
| 2.8–2.10 quiet-day sources | large | three of four quiet cards |
