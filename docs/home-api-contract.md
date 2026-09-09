# Home — API contract for what is still missing

Scope: screens **01a Home**, **01b Home · a quiet day**, **01c Home · day one**.
Verified against the backend source on 2026-09-08. Everything not listed here
is already served and already wired.

Each item states what the screen does with it, so the shape can be argued with
rather than just implemented.

> **Status, 2026-09-08 (later the same day): all twelve delivered.**
>
> Verified independently against the backend source and the running gateway,
> not taken on report: the eight `requireRole("ADMIN")` guards are now
> `requirePermission(...)`, and all ten new or reshaped endpoints answer 401
> rather than 404 through the gateway — routed and reachable.
>
> Item 0 landed as a **two-permission split** rather than the single one asked
> for, and that is the better answer: `analytics:workspace:read` is the shared
> operational picture (queue, presence, pending approvals, today's numbers),
> while `analytics:dashboard:read` stays managerial reporting (per-agent
> performance, tool economics, department comparisons). An agent who needs to
> see the queue is not a reason to show them how they rank against colleagues.
>
> The shapes below match what shipped. Screen 01a is complete against them.
> **01c is still unbuilt on this side** — the endpoints exist, the frontend
> block does not.
>
> One thing needs a product decision, in §5.

---

## 0. Blocking everything: Home is ADMIN-only

This is the one to fix first. It is not a missing endpoint — it is a guard on
endpoints that already exist, and it makes Home unusable for the people who
use it most.

| Endpoint | Guard | What it feeds on Home |
|---|---|---|
| `GET /api/analytics/overview` | `requireRole("ADMIN")` | The whole metric strip, and `pendingApprovalCount` |
| `GET /api/analytics/queue` | `requireRole("ADMIN")` | The waiting count, and the busy/quiet decision |
| `GET /api/analytics/channel-performance` | `requireRole("ADMIN")` | Channel distribution |
| `GET /api/analytics/agents` | `requireRole("ADMIN")` | "Your team right now" |
| `GET /api/analytics/insights` | `requireRole("ADMIN")` | "Worth knowing" |
| `GET /api/analytics/dormant-customers` | `requireRole("ADMIN")` | A quiet-day card |
| `GET /api/onboarding/status` | `requireRole("ADMIN")` | 01c, all of it |
| `GET /api/onboarding/setup-map` | `requireRole("ADMIN")` | 01c, all of it |

The newer Home endpoints — `queue/items`, `activity`, `time-saved`,
`unanswered-questions`, `product-demand` — are correctly open to any
authenticated member. The list above looks like it simply was not revisited
when those were added.

**An agent opening Home today gets 403 on four of its six regions.** They see
the greeting, the command box, and nothing else. That is not a degraded
experience, it is a broken screen, and no frontend handling improves it —
hiding the regions would tell an agent their queue is empty when it is not.

**Asked for:** replace `requireRole("ADMIN")` with the permission the data
actually corresponds to (`analytics:read`, or per-resource equivalents), so
that role assignment decides this rather than a hard-coded rank. If some
figures genuinely are owner-only, say which, and Home will gate those regions
on the permission instead of failing the request.

---

## 1. Screen 01a — Home

### 1.1 Monthly conversation allowance

The design draws a progress bar in the dark card's footer, with
*"At today's pace that lasts until 12 September"*, and says it turns amber
under seven days of headroom and raises a notification.

`/api/usage/stats` and `/api/usage/by-tenant` are both `requireSystemAdmin()`
and neither returns a limit or period boundaries. Allowance lives in billing
and has no tenant-facing endpoint at all.

```
GET /api/usage/allowance
→ {
    "used": 1160,              // conversations this period
    "limit": 3000,             // null when the plan is uncapped
    "periodStart": "2026-09-01T00:00:00.000Z",
    "periodEnd":   "2026-10-01T00:00:00.000Z",
    "projectedExhaustionAt": "2026-09-12T00:00:00.000Z"  // null when uncapped or not projectable
  }
```

`projectedExhaustionAt` server-side on purpose: the client computing a run-rate
would put a different date on Home than the one billing acts on.

### 1.2 The "right now" line

The dark card opens with *"Right now: answering 9 conversations, checking 4
orders, and holding 3 actions for your approval."*

Nothing serves it. `/api/analytics/activity` is past tense — what happened, in
order. `/api/analytics/queue` counts customers waiting, not work in flight.

```
GET /api/analytics/in-flight
→ {
    "conversationsHandling": 9,    // AI is mid-conversation right now
    "toolsRunning": [ { "subject": "order", "count": 4 } ],
    "awaitingApproval": 3          // must equal overview.pendingApprovalCount
  }
```

`toolsRunning` grouped by subject rather than by tool: the sentence says
"checking 4 orders", not "4 executions of get_order".

### 1.3 Insights cannot be translated

`/api/analytics/insights` composes English prose with the numbers inside it:

```ts
title: `Automate "${top.detectedIntent}" responses`,
description: `The intent "${top.detectedIntent}" appeared ${count} times in the
              last 30 days. Creating an automated flow could reduce agent
              workload significantly.`
```

On a Hebrew screen this renders English. It cannot be translated, and a
translation table keyed on English breaks the first time someone rewords it.

**This is the same problem the activity stream had, and it is already solved
there.** `packages/shared/src/lib/activity-events.ts` emits `kind` + `values`
and lets the client own the wording — its own header comment gives the reason.
Insights need the same treatment:

```
GET /api/analytics/insights
→ { "data": [ {
      "id": "top-intent-automation",
      "kind": "intent.automatable",       // <noun>.<observation>
      "values": { "intent": "SHIPPING_ISSUE", "count": 43, "days": 30 },
      "impact": "high",
      "actionable": true
  } ] }
```

Until then "Worth knowing" cannot be built without putting untranslated English
on the screen, so it stays unbuilt.

---

## 2. Screen 01b — a quiet day

Mostly served. `unanswered-questions` (with `askCount`), `product-demand` and
`dormant-customers` all exist, and `agents/presence` covers team availability.

### 2.1 Conflicts do not say who they affect

The design asks for knowledge gaps and conflicts *"with how many customers each
affected"*. `/api/intelligence-reviews` carries no such figure, and the quiet-day
list is explicitly *ranked by how much future work each item removes* — which is
exactly that number.

**Asked for:** `affectedCustomerCount` on each review — distinct customers whose
conversations touched the field in dispute.

### 2.2 Not asked for: a drafted message on dormant customers

Recorded so it is not re-added. Dormant customers route through the campaign
flow — create → template approval → send — by product decision. No draft
endpoint, and no `insights/{id}/draft/send`: that would duplicate
`/api/broadcasts`.

---

## 3. Screen 01c — day one

This is the least served of the three. The design names seven things; the two
endpoints that exist answer a different question — they describe an onboarding
*wizard's* progress, not a workspace's readiness.

`/api/onboarding/setup-map` returns tiles of `{ id, done, deepLink, stage }`.
A boolean is not the state machine the screen is built on.

### 3.1 Setup state per step

The design names four states and they are not interchangeable: `done` (with a
timestamp), `next` (**exactly one, ever**), `waiting` (available but not yet),
`blocked` (cannot start until something else finishes). "Steps are ordered by
what unblocks GOTCHA, not by effort."

```
GET /api/setup/state
→ {
    "steps": [ {
      "id": "connect_store",
      "state": "next",                     // done | next | waiting | blocked
      "completedAt": null,
      "blockedBy": [],                     // step ids, when state is blocked
      "estimateMinutes": 5
    } ],
    "isLive": false,
    "goLive": {
      "eligible": false,
      "blockedBy": ["connect_store", "handover_rules"]
    },
    "trial": { "daysRemaining": 12, "conversationsUsed": 40 }
  }
```

`next` is the server's decision, not the client's. Two surfaces computing "what
should I do now" from the same booleans will disagree the moment either changes.

Titles and descriptions are **not** in this response — they are translated
copy and belong in the frontend, keyed on `id`. Sending English prose here
would repeat the insights mistake.

### 3.2 Knowledge ingest result

*"pages read, answers drafted, answers needing confirmation"* — the feedback
after pointing GOTCHA at a website. No endpoint reports it.

```
GET /api/knowledge/ingest/latest
→ { "pagesRead": 84, "answersDrafted": 61, "answersNeedingConfirmation": 7,
    "finishedAt": "2026-09-08T09:12:00.000Z" }   // null while still running
```

### 3.3 Per-channel state

`GET /api/channels/summary` returns `{ total, connected, unhealthy, pending }`.
The screen needs to name the channel and say whether it is verified — "WhatsApp
connected, Instagram awaiting verification" — which counts cannot express.

**Asked for:** a per-channel list — channel type, display name, connection
status, verification state — on an endpoint any member can call.

### 3.4 Commerce capability flags at tenant level

*"commerce integration state + capability flags (read orders, refund, cancel,
track)"*. These exist only on a per-conversation endpoint, so there is no way to
ask "can this workspace issue a refund at all" — which is what gates Go live.

```
GET /api/integrations/commerce/capabilities
→ { "connected": true, "provider": "shopify",
    "can": { "readOrders": true, "refund": true, "cancel": true, "track": false } }
```

### 3.5 Handover rules and approval limits

*"set or unset"*. Go live is sealed until these are set — they decide whether
GOTCHA can act or only talk. A boolean per rule group is enough; the screen does
not need the rules themselves.

### 3.6 Test conversations kept out of analytics

*"test conversations sent during setup, kept out of analytics"*. Setup mode is
real: until Go live, GOTCHA answers only the team's own numbers. Those
conversations must not enter the figures Home reports the next morning, or
day one ends with a metric strip counting the team talking to itself.

**Asked for:** a flag on the conversation (`isTest`, or an origin of `setup`),
excluded from every analytics aggregate.

### 3.7 Invitation acceptance returns HTML, not JSON

`/api/auth/setup/{token}` answers 302s. The frontend cannot render an
acceptance screen against a redirect: it needs the invitation's state as data —
valid, expired, already used, and who invited whom.

---

## 4. Summary

| # | Screen | Item | Kind |
|---|---|---|---|
| 0 | all | Home endpoints are ADMIN-only | **guard change, blocking** |
| 1.1 | 01a | Monthly allowance | new endpoint |
| 1.2 | 01a | "Right now" in-flight summary | new endpoint |
| 1.3 | 01a | Insights as `kind` + `values` | reshape existing |
| 2.1 | 01b | `affectedCustomerCount` on reviews | field on existing |
| 3.1 | 01c | Setup state machine | new endpoint |
| 3.2 | 01c | Knowledge ingest result | new endpoint |
| 3.3 | 01c | Per-channel state | reshape existing |
| 3.4 | 01c | Commerce capabilities, tenant level | new endpoint |
| 3.5 | 01c | Handover rules set/unset | field on existing |
| 3.6 | 01c | Test conversations excluded | flag + aggregate change |
| 3.7 | 01c | Invitation state as JSON | reshape existing |

Item 0 is worth more than the other eleven combined: those add regions, that one
makes the screen work for anyone who is not an owner.

---

## 5. Open decision — how far `analytics:workspace:read` reaches

The `agent` role template now carries `analytics:workspace:read`, which is what
makes Home work for a non-owner. `dormant-customers` moved under that
permission with the rest of the operational set.

That endpoint returns customer names, channel identifiers and last-seen dates.
The backend's reasoning is that agents already hold `crm:contacts:read`, so it
exposes nothing new — which is true today, and stops being true the moment
someone narrows `crm:contacts:read`.

If dormant customers should stay manager-only, it moves back to
`analytics:dashboard:read` on its own and nothing else changes: the quiet-day
card degrades for agents and works for managers, which the screen already
handles. This is a product call about who may pull a customer list, not a
technical one.
