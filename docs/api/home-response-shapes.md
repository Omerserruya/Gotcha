# Home: response shapes

Every shape below was **generated** by calling the real service function against
the real database, seeding one representative row where dev had none, and
replacing each leaf with its type. None of it is hand-written. A hand-written
sample is a claim about the code that nothing checks, and it begins drifting the
day after it is committed.

Regenerate rather than edit: seed, call, shape, clean up. The script lives in
the session scratchpad, not the repo, because the honest long-term fix is the
one `scripts/api-docs/README.md` already names - response types declared in the
code, read by the generator. This document is the interim, and it says so.

`string (ISO-8601)` means a UTC timestamp string. `"null"` means the field was
null in this capture and is nullable.

---

## Shipped and verified

### `GET /api/analytics/queue/items?limit&cursor`
Ranked "needs you now". Any tenant member.

```json
{
  "data": [{
    "conversationId": "string",
    "customer": { "id": "string", "name": "string | null" },
    "channel": "string",
    "preview": "string",
    "intent": "string",
    "waitingSince": "string (ISO-8601)",
    "urgency": "string",
    "rank": "number"
  }],
  "nextCursor": "string | null",
  "totalWaiting": "number"
}
```

- `channel` is the platform's `ChannelType`, **uppercase** (`WHATSAPP`), as every
  other endpoint returns it. The original spec wrote `whatsapp`; a second
  lowercase vocabulary for one concept would cost the frontend a second map
  forever.
- `intent` is one of the ten `CONVERSATION_INTENTS`, below.
- `urgency` is `high | medium | low | none`.
- `cursor` is an offset into a deterministic ordering, not a row id - the sort
  key is computed, so there is no column to seek on.

### `GET /api/analytics/activity?limit&cursor`
Tool executions merged with pending approvals, newest first. Any tenant member.

```json
{
  "data": [{
    "id": "string",
    "at": "string (ISO-8601)",
    "outcome": "string",
    "kind": "string",
    "values": { "amount": "number", "currency": "string", "customer": "string" },
    "subject": { "type": "string", "id": "string | null" },
    "conversationId": "string | null"
  }],
  "nextCursor": "string (ISO-8601) | null"
}
```

- `outcome`: `completed | failed | awaiting_approval`.
- `kind`: `<noun>.<outcome>`, e.g. `refund.completed`. An unmapped tool falls
  back to its slug (`some_new_tool.completed`) rather than a wrong noun.
- `values` carries only allow-listed scalars. Tool output is arbitrary provider
  JSON; passing it through would put addresses and card metadata on a dashboard.
- `subject.type`: `order | customer | contact | lead | deal | conversation | none`.
- **No rendered sentence anywhere.** The card renders in Hebrew as often as
  English, and a sentence composed on the server cannot be translated.

### `GET /api/analytics/time-saved?from&to`
```json
{
  "secondsSaved": "number",
  "basis": {
    "conversationsHandled": "number",
    "secondsPerConversation": "number",
    "source": "string",
    "sampleSize": "number",
    "method": "string",
    "period": { "from": "string (ISO-8601)", "to": "string (ISO-8601)" }
  }
}
```

- `source`: `measured` (the tenant's own median) or `platform_default`.
- `method`: `median_span_first_inbound_to_last_outbound` or `platform_default`.
- `secondsSaved` is exactly `conversationsHandled x secondsPerConversation`, so
  the reader can check it.

### `GET /api/analytics/unanswered-questions?limit&includeResolved`
```json
{
  "data": [{
    "id": "string",
    "question": "string",
    "reason": "string",
    "askCount": "number",
    "askedBy": "number",
    "firstAskedAt": "string (ISO-8601)",
    "lastAskedAt": "string (ISO-8601)",
    "resolvedAt": "string (ISO-8601) | null"
  }]
}
```

- `reason`: `no_knowledge | low_confidence | conflicting`. **`conflicting` has no
  writer yet** - deciding two passages disagree rather than corroborate takes
  reading them, and only `services/ai` may make a new LLM call. It is in the
  domain so the frontend can be built against the whole set.
- `askedBy` is approximate and never overstates reach.

### `GET /api/analytics/product-demand?limit&week&includeStocked`
```json
{
  "weekKey": "string",
  "data": [{
    "id": "string", "term": "string",
    "askCount": "number", "askedBy": "number", "inCatalogue": "boolean",
    "firstSeenAt": "string (ISO-8601)", "lastSeenAt": "string (ISO-8601)"
  }]
}
```

- `weekKey` is ISO-8601 (`2026-W37`) and is echoed back, never left implicit: a
  card claiming "this week" beside a number is making a claim about which week.
- Defaults to the current week and to misses only.

### `GET /api/analytics/dormant-customers?limit&days&minConversations` (ADMIN)
```json
{
  "definition": {
    "quietForDays": "number",
    "minConversations": "number",
    "quietSince": "string (ISO-8601)"
  },
  "data": [{
    "customerId": "string", "channel": "string", "name": "string | null",
    "conversationCount": "number", "lastSeenAt": "string (ISO-8601)",
    "quietDays": "number"
  }]
}
```

- The definition travels **with** the rows. "Dormant" is a judgement, and nobody
  reading "47 dormant customers" can otherwise tell whether that means a month
  or a year.
- `data` was empty in this capture - dev has no customer quiet long enough. The
  row shape above is from the code, not from a captured row.

### `GET /api/conversations/handovers/latest`
```json
{ "data": { "at": "string (ISO-8601)", "from": "string | null", "to": "string" } }
```
`data` is `null` when nothing has been recorded. Render that as **absence**, not
as zero: a tenant deployed this morning and a tenant whose AI has never needed
help are not the same thing.

### `GET /api/notification-preferences/me`, `PATCH` same
```json
{
  "data": {
    "inApp": "boolean", "email": "boolean", "whatsapp": "boolean",
    "approvals": "boolean",
    "quietHours": { "from": "HH:MM", "to": "HH:MM" }
  }
}
```
`quietHours` is `null` when off. A window that wraps midnight (`22:00`→`07:00`)
is the common case and is accepted. A user who has never opened the page gets
the defaults, not nulls.

### `GET /api/notifications`
Each row now also carries:
```json
{ "category": "string", "target": { "type": "string", "id": "string | null" } }
```
`category` is **derived on read** from `eventType`, which is preserved. See the
coverage warning below.

### `POST /api/analytics/insights/:id/dismiss` (ADMIN)
`{ "ok": true }`. Idempotent.

---

## Enums the frontend branches on

**`CONVERSATION_INTENTS`** - `FRUSTRATED`, `HIGH_INTENT`, `WAITING_EXTERNAL`,
`ORDER_CHANGE`, `RETURN`, `REFUND`, `SHIPPING_ISSUE`, `PRODUCT_QUESTION`,
`COMPLAINT`, `OTHER`.

Intent reports the **subject**. Someone furious about a refund shows `REFUND` -
that is what the agent acts on - while the frustration is carried separately
into the ranking, so the row still scores like a complaint.

**`NOTIFICATION_CATEGORIES`** - `APPROVAL_REQUIRED`, `ACTION_FAILED`,
`INTEGRATION_DISCONNECTED`, `AI_PAUSED`, `CAMPAIGN_COMPLETED`, `COMPLAINT_SPIKE`,
`OTHER`.

> **Coverage.** Four of the twenty-five emitted event types map onto a category.
> The whole billing, subscription, invoice and AI-credit family has none, and
> `INTEGRATION_DISCONNECTED`, `AI_PAUSED` and `COMPLAINT_SPIKE` have no producer
> anywhere in the codebase. `OTHER` is what keeps those notifications reaching
> the bell instead of vanishing or being filed under a wrong heading.

---

## Not documentation - these need building

Four of the nine endpoints in the original section 4 do not return a different
shape from the one assumed. They return a **different contract**.

| Endpoint | What it actually returns | What Home needs |
|---|---|---|
| `GET /api/onboarding/status` | `tenant`, `onboarding`, `businessProfile`, `coreSystemConnected`, and three counts | `steps[]` with `state`/`actionHref`/`estimateMinutes`, `trial`, `goLive.blockedBy`. None exist. |
| `GET /api/channels/summary` | `{ total, connected, unhealthy, pending }` - four counts | connected channels **per channel**, with verification state |
| `GET /api/auth/setup/{token}` | **302 redirect** in every branch. Never JSON. | `{ workspace, role, team, expiry }` |
| `GET /api/integrations` | catalogue plus `tenantConnection`, no commerce capability flags | `canRefund`/`canCancel`/`canReturn` per tenant. Those live on `CommerceCapabilities`, served only by `GET /api/commerce-context/:conversationId`, which is **conversation-scoped** - there is no tenant-level "can this store refund". |

---

## One convention breach worth deciding on

`GET /api/analytics/insights` returns `title` and `description` as **composed
English sentences**:

```json
{ "id": "string", "type": "string", "title": "string",
  "description": "string", "impact": "string", "actionable": "boolean" }
```

Every other surface here returns codes and lets the frontend translate. These
cannot be translated - the sentence is built server-side with numbers already
interpolated. It predates this work and I have not changed it, because changing
the shape would break whatever renders it today. Worth a decision: either the
insight becomes `{ code, values }` like the activity stream, or Home renders
English on a Hebrew screen.
