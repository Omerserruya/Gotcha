# Assistant threads API contract v1 (Home chat, design 7 frame 01a) - Stage 1

Served by `services/ai` (the existing agent engine, extended; no second engine).
Base path: `/api/assistant`. All routes need a signed-in user of the workspace.

**Stage 1** gives threads, history, streaming with steps, follow-up suggestions,
cancel and resume. `blocks`, `sources` and `actions` exist in the message shape
and are always `[]` in stage 1. **Stage 2 (§9) fills `blocks` and `sources`**
(stage 3:
actions and undo).

The old Command Center keeps `POST /api/agent/run` until it moves here.

---

## 1. Objects

### Thread
```jsonc
{
  "id": "cmx...",
  "title": "Who asked about refunds this week?",   // null until auto-titled after the first answer
  "scope": {
    "range": "this_week",            // "this_week" | "last_7" | "last_30" | { "custom": { "from": "2026-10-01", "to": "2026-10-07" } }
    "channels": "all"                // "all" | ["WHATSAPP", "INSTAGRAM", ...]
  },
  "scopeDates": { "from": "2026-10-01", "to": "2026-10-07" },   // the scope resolved to the dates the assistant uses today (UTC days)
  "createdAt": "2026-10-07T12:00:00.000Z",
  "updatedAt": "2026-10-07T12:01:10.000Z",
  "lastMessageAt": "2026-10-07T12:01:10.000Z",
  "archivedAt": null
}
```
Default scope: `{ "range": "last_7", "channels": "all" }`.

### Message
```jsonc
{
  "id": "cmy...",
  "threadId": "cmx...",
  "role": "user" | "assistant",
  "text": "...",                     // user: what they wrote; assistant: the answer (markdown subset, see below; no wide dashes)
  "status": "done" | "streaming" | "cancelled" | "failed",
  "steps": [                         // assistant only; what it did, in order
    { "id": "s1", "text": "Searching conversations", "status": "done", "durationMs": 840 }
    // status: "running" | "done" | "failed" | "waiting_approval"
    // a waiting_approval step also has "approvalRequestId" (link it to Approvals)
  ],
  "scope": { "range": "last_7", "channels": "all" },   // assistant only: the scope this answer used
  "suggestions": ["Which of them are still open?", "Show me last month instead"],  // assistant only, 0-3
  "blocks": [], "sources": [], "actions": [],   // stage 1: always []
  "runId": "run_...",                // assistant only: the run that produced it
  "lang": "he" | "en",               // assistant only, optional: the turn's language (its question's), see §3
  "createdAt": "..."
}
```
A cancelled message keeps the text written so far (`status: "cancelled"`).

**Markdown in `text` (assistant):** bold, italics, bullet and numbered lists,
inline code, and links `[label](url)`. Render a link only when its url is
`http(s)://` or an in-app path starting with `/`; anything else as plain text.
No raw HTML, images or tables in stage 1.

**Scope:** a scope change (`PATCH`) applies to messages sent after it. Each
assistant message records the scope it was answered under (`scope`), so an old
answer stays readable as what it was.

---

## 2. Threads

Visibility: a thread is its **owner's only** (sharing is stage 2). Another user's
thread id answers **404** on every route, exactly like a missing one.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/assistant/threads` | `{ scope? }` | `201 { data: Thread }`. The client then sends the first message with `POST /threads/:id/messages`. |
| `GET /api/assistant/threads` | `?limit=20` (max 50) `&cursor=<id>` | `200 { data: [{ id, title, updatedAt, lastMessageAt }], nextCursor }`, newest first; archived ones excluded (`?archived=1` lists only those). |
| `GET /api/assistant/threads/:id` | | `200 { data: { thread: Thread, messages: Message[], activeRun: null \| { runId, messageId, lastEventId } } }`. Everything needed to rebuild the screen; `activeRun` set while an answer is still being written (reconnect with §4). |
| `PATCH /api/assistant/threads/:id` | `{ title?, scope?, archived? }` | `200 { data: Thread }`. `title` 1-120 chars. |
| `DELETE /api/assistant/threads/:id` | | `204`. Deletes the thread and its messages; a running answer is cancelled first. |

The title is written automatically after the first answer (one small model call,
logged and charged like every AI call). A title the user set is never overwritten.

---

## 3. Sending a message: the stream

`POST /api/assistant/threads/:id/messages` with `{ "text": "...", "locale"?: "he" | "en" }` (text 1-4000 chars)
answers `200` with `Content-Type: text/event-stream`. **One answer at a time per
thread**: while one is running, a second send is `409 RUN_IN_PROGRESS`.

**Language:** a turn is written in the language of the user's question
(Omer, 2026-10-07; extended 2026-10-08): the answer, its steps, the blocks'
titles and labels, the sources' labels, the suggestions, the auto-title (from
the first question) and the §9.4 full list. Hebrew letters against Latin ones,
the majority wins. Only a question with no clear language (a number, a name, a
tie) falls back to the interface language: `locale` when sent, else the
user's profile language, then the workspace's default. The client's own chrome
stays in the UI language; the answer's own chrome (step status and duration,
"N in all", coverage lines) follows `lang`: on `run.start` (always, the
language the turn was written in) and on a saved assistant message (derived
from its question; absent when the question had no clear language, and then
the turn fell back to the UI language, so the client keeps its own).
The words the model reads in a tool's result are in the turn's language too
(it repeats them: "right now" leaked into a Hebrew answer, 2026-10-08). A
citation the server drops (its source is not in the message) takes the space
before it.

**Errors before the stream opens** are plain JSON with a non-200 status (§6):
400, 402 (billing refuses before any model call), 404, 409, 429. Once the
stream is open (200), failures arrive as `error` + `message.done`.

Every event has an `id:` (`<runId>:<seq>`, seq from 1, increasing). A comment
line `: ping` is sent every 25 s.

| event | data | when |
|---|---|---|
| `run.start` | `{ runId, userMessageId, messageId, lang }` | first; `messageId` is the assistant message being written; `lang` (`he` \| `en`) is the turn's language |
| `step.start` | `{ stepId, text }` | a step begins (e.g. "Looking at this week's conversations") |
| `step.done` | `{ stepId, status, durationMs, approvalRequestId? }` | `status`: `done` \| `failed` \| `waiting_approval` (then with `approvalRequestId`) |
| `text.delta` | `{ text }` | a piece of the answer; append in order |
| `suggestions` | `{ items: string[] }` | 2-3 follow-up questions, produced by the same model call (no extra call); may be absent |
| `thread.title` | `{ title }` | the thread got its automatic title (after the first answer), before `message.done` |
| `error` | `{ code, message }` | something went wrong; followed by `message.done` with `status: "failed"` |
| `message.done` | `{ messageId, status, usage? }` | always last. `status`: `done` \| `cancelled` \| `failed` |

Error codes inside the stream (status 200 already sent): `BUDGET_EXCEEDED` (the
run used its token budget; the text so far is kept), `AI_UNAVAILABLE` (the model
provider failed, or billing refused mid-run). A failing tool is never fatal: it
appears as a failed step.

A `waiting_approval` step means the assistant proposed an action that needs
approval; in stage 1 it is shown, not resumed in the thread.

---

## 4. Reconnecting (resume)

If the stream drops, reconnect with:

`GET /api/assistant/threads/:id/runs/:runId/events` and header `Last-Event-ID: <runId>:<seq>`
(or `?after=<seq>`). The server replays every event after that id, then continues
live until `message.done`. Works for a running answer and for 15 minutes after it
ended. After that: `410 RUN_EXPIRED`; reload with `GET /threads/:id`.

The run's state lives in a short-lived store, so a reload of the page mid-answer
uses `activeRun` from `GET /threads/:id` and this route.

---

## 5. Cancel

`POST /api/assistant/threads/:id/messages/:messageId/cancel` → `202 { data: { status: "cancelling" } }`.

The model call is really stopped (its request is aborted, not just the stream),
and nothing after it runs: no further tool, no further round. A tool already
running when the cancel lands finishes first (stage 1 tools are short reads),
then the answer stops. The stream ends with `message.done` `{ status: "cancelled" }`
within about half a second; the text written so far is kept. Cancelling a
finished message answers `200 { data: { status: "<its status>" } }`. Closing the
browser tab does **not** cancel; use this route.

---

## 6. Limits and errors

| status | code | when |
|---|---|---|
| 400 | `TEXT_REQUIRED`, `TEXT_TOO_LONG` (`max: 4000`), `INVALID_SCOPE`, `TITLE_TOO_LONG` | |
| 402 | `AI_UNITS_EXHAUSTED` (and the billing codes the rest of the app uses) | the workspace cannot use AI now |
| 404 | `THREAD_NOT_FOUND` | missing, deleted, or another user's |
| 409 | `RUN_IN_PROGRESS` | a second send while an answer is running |
| 410 | `RUN_EXPIRED` | resume after the run store expired |
| 429 | `RATE_LIMITED` with `retryAfterSeconds` | more than 10 messages a minute per user |

Each answer has a token budget (all model calls of the run together); reaching it
ends the answer with `BUDGET_EXCEEDED` as above.

**What the assistant can see:** only what the signed-in user may see. Conversation
data follows the same visibility rules as the inbox (department / assignment).

---

## 7. Stage 1 tools (for the steps' wording)

The existing system tools (counts, metrics, customer search, conversation summary,
recent activity) and the workspace's connected integrations' read tools. Steps are
worded for people ("Searching customers", "Reading your HubSpot deals"), never tool
names.

---

## 8. Implementation notes (backend, 2026-10-07)

- Every answer is a run of the existing assistant runtime with the thread id as
  its memory session: the model sees the thread's earlier turns (tool calls
  included), never another thread's. Ctrl+K's "clear" leaves threads alone;
  deleting a thread deletes its memory.
- The scope reaches the model as absolute dates (`last_7` = today and the six
  days before; `this_week` starts on Sunday; UTC days).
- Suggestions are written by the same model call after a marker line that the
  server strips from the stream; they arrive as `suggestions` before
  `thread.title` and `message.done`.
- `error` codes in the stream: `AI_UNAVAILABLE` (the provider failed) and
  `BUDGET_EXCEEDED` (default 60,000 tokens per answer, all rounds together;
  `ASSISTANT_RUN_TOKEN_BUDGET`).
- A message saved as `streaming` whose run no longer exists (the process
  restarted mid-answer) is returned as `failed`.
- Known gap: when an answer is cancelled mid-stream, the provider's usage for
  that partial call is not reported back (it arrives only at the end of a
  stream), so it is not metered.

---

## 9. Stage 2: answers that come back as work (design 01a) - CONTRACT, not built yet

Numbers in an answer come from the server, never from the model. A query tool
computes them; the server turns its result into **blocks** and **sources**;
the model writes only the prose around them. A block or a source is never
generated, edited or rounded by the model.

Everything below follows the caller's visibility (the inbox's rule) and
excludes rehearsals (sandbox), test rows and imported history, like Home. Days
are the workspace's days (its business-hours timezone).

### 9.1 What the assistant can be asked, and how honestly

| Ask | Status | Blocks it produces |
|---|---|---|
| Conversations over a period by **day**, **channel**, **status**, **who handled them** (GOTCHA / team / waiting) | available | `chart` (by day), `breakdown`, `record_list` |
| Conversations that **mention** a word or phrase ("small", "late") in the period | available | `breakdown` (by channel) + `record_list` |
| Conversations by **intent** / **sentiment** | partial: recorded only for some conversations; the block says for how many (`coverage`). Never a distribution over all conversations | `breakdown` with `coverage` |
| **Orders** / **refunds** over a period by day or by product | depends on the store: a live read, capped (`partial`); Shopify needs Protected Customer Data approval (today: refused, the answer says so); WooCommerce from stage 2's own date filter | `chart`, `breakdown`, `record_list` (kind `order`) |
| A **product's stock** (per variant) | available (Shopify; WooCommerce where the store returns it) | `record` |
| Return **reasons** across the store, a product's **return rate** | **not available** (no store-wide source; stage 3 with return-reason classification). The assistant says so plainly | none |

### 9.2 Blocks (`message.blocks`, in order)

Every block has `id` ("b1", "b2"... per message), `type`, `title` (interface
language), `sourceId` and optionally `deepLink` (§9.5), `partial` and
`coverage`.

```jsonc
// chart: a series over days or categories
{ "type": "chart", "id": "b1", "title": "Conversations this week", "sourceId": "s1",
  "kind": "bar" | "line",
  "x": { "kind": "day" | "category", "values": ["2026-10-01", "...", "2026-10-07"] },  // days ISO: format them in the UI language
  "series": [{ "key": "conversations", "label": "Conversations", "values": [3, 4, 2, 5, 3, 9, 12] }],
  "unit": "count" | "currency" | "percent", "currency": "ILS" | null,
  "highlight": ["2026-10-06", "2026-10-07"],
  "deepLink": "/analytics?tab=overview" | null }

// breakdown: parts of a whole (bar length = share)
{ "type": "breakdown", "id": "b2", "title": "By channel", "sourceId": "s1",
  "items": [{ "key": "WHATSAPP", "label": "וואטסאפ", "value": 23, "share": 0.61 }],
  "total": 38, "unit": "count" | "currency" | "percent", "currency": null,
  "other": { "label": "Other", "value": 2 } | null,
  "coverage": { "covered": 14, "of": 88 } | null,   // intent/sentiment: recorded for 14 of 88
  "deepLink": "/inbox?channel=WHATSAPP" | null }

// record_list: the rows behind a number (first page). A conversation row's
// subtitle is "<channel> · <state> · <who has it>", `meta` its time, `preview`
// its last message (null for media or none; optional, additive 2026-10-08).
// kind "customer" (system_find_customers): title = name, subtitle = channels ·
// phone/email, meta = open conversations · last contact, deepLink /customers/<id>.
{ "type": "record_list", "id": "b3", "title": "Conversations that mention size", "sourceId": "s2",
  "kind": "conversation" | "customer" | "order" | "product",
  "items": [{ "id": "...", "title": "Dana Cohen", "subtitle": "Return #2207", "meta": "7 October", "deepLink": "/inbox?c=..." }],
  "total": 12, "hasMore": true }                     // the rest: §9.4

// record: one thing and its facts
{ "type": "record", "id": "b4", "title": "Linen Duvet Set · King", "sourceId": "s3",
  "kind": "product" | "order" | "customer" | "conversation",
  "fields": [{ "key": "stock", "label": "In stock", "value": "14" }],
  "deepLink": null }

// on any block
"partial": { "reason": "capped", "cap": 250 } | { "reason": "store_limit" } | null
```
`label`s, `title`, `subtitle`, `meta` and `fields[].value` are finished text in
the interface language (render verbatim); raw numbers are in `series[].values`,
`items[].value`, `total`. `unit: "percent"` values are 0-100 (38 = 38%);
`share` is 0-1. Money in finished text (`subtitle`, labels) is symbol first
in both languages ("₪10,539.69"), with no invisible direction marks; raw
amounts stay numbers. `chart.x.values` of kind `day` are the workspace's calendar
days: format them as dates, no timezone shift. A store read that is refused or
unsupported produces no block; the assistant says why in one plain sentence.
A query that finds nothing produces no block either (no breakdown without
items, no chart of zeros): its source still comes, and the answer says the 0
in words. When the period is the reason (none STARTED in it, some are in that
state now), the answer says both ("none started this week; 17 are open").
The same query asked twice in one answer runs once: one step, one block, one
source.

Store blocks (part 2), offered only to a caller with `customer:commerce:read`
and only when a store is connected:
- orders / sales / refunds by day: `chart`, sales with `unit: "currency"` and the
  store's `currency`;
- by product: `breakdown` of UNITS ("Units sold by product", "Units refunded by
  product": an order's total is not split across its lines);
- refunds: also a `record_list` of kind `order` (the refunded orders,
  `deepLink: null`); refunds are those on orders placed in the period;
  `groupBy: "reason"` gives a `breakdown` "Refunds by reason" with `coverage`
  (a reason given for N of M). WooCommerce does not say when a refund was made
  or which lines it covered: by day / by product give no split card (never an
  empty chart), only the list, and the answer says why;
- a product's stock: `record` of kind `product`, fields `stock` then
  `variant:<name>` per variant (a single "Default Title" variant shows only
  `stock`; an untracked product says so in `value`).
Sources: `orders` / `refunds` (`query.tool: "orders"`) and `product`
(`query.tool: "product_stock"`). The §9.4 list serves `orders` sources from a
fresh store read; it is 409 SOURCE_UNAVAILABLE when the store refuses or the
reader no longer holds `customer:commerce:read`.

### 9.3 Sources and citations (`message.sources`)

```jsonc
{ "id": "s1", "label": "12 שיחות שמזכירות “קטן”",
  "kind": "conversations" | "orders" | "refunds" | "product" | "order" | "customer" | "conversation",
  "count": 12 | null,
  "deepLink": "/inbox?channel=WHATSAPP" | null,
  "query": { "tool": "conversations", "params": { "mention": "קטן", "from": "2026-10-01", "to": "2026-10-07", "channels": "all" } } }
```
A conversations source about the CURRENT state (`"how many are open"`, `"how
many of them are on WhatsApp"`) has `params: { "now": true, "status": "OPEN" |
"WAITING", "groupBy": ..., "channels"?: [...] }` and no `from`/`to`: every
conversation in that state now, whenever it started (the figure Home and
`open_conversations` show; split by channel it adds up to exactly that). Its
label ends "· right now" / "· כרגע" and its `deepLink` is null. A period counts
the conversations that STARTED in it.

The open-conversations figure (`system_get_metric open_conversations`) also
has a source, with no block: `{ "now": true, "status": "OPEN" }`, label "17
שיחות (פתוחות) · כרגע", so a metric answer has something real to cite.

A conversations source may also carry `customerIds` (a customer's
conversations on every channel of the person), `assignee` ("gotcha",
"unassigned" or a user id), `waitingForPerson: true` (the inbox queue's rule)
and `list: true` (a record_list of rows, newest activity first for the current
state). All replay through §9.4. A customers source (`kind: "customer"`,
`query.tool: "customers"`) lists every match in its block and has no further
pages.
A conversation read (`system_read_conversation`) gives a `record` of kind
"conversation" (fields channel, state, handler, started, last, summary when
there is one; deepLink /inbox?c=<id>) and a source `{ kind: "conversation",
query: { tool: "conversation", params: { conversationId } } }`, which has no
§9.4 list. Unnamed Shopify shoppers are named "קונה באתר" / "Website shopper"
in the assistant's cards (the stored name is "Shopper on <domain>").
A conversation record's summary comes as labelled fields (summary_reason,
summary_asked, summary_status, summary_opportunity; labels in the turn's
language, content as stored, no markdown), or one "summary" field when the
stored text is not in that shape; "started" is the earlier of the row's
creation and its first message.
A customer card (`system_customer_card`) is a `record` of kind "customer"
(fields channels, phone, email, tags, open, last, learned, notes, orders;
deepLink /customers/<id>?tab=everything) followed by the record_list of their
conversations; both cite one source, the customer's conversations (§9.4
replays it).
Two more record_list kinds (2026-10-08): "approval" (system_list_approvals:
title = what, subtitle = customer · amount · risk, meta = since when,
deepLink /approvals?id=<id>; source kind "approvals", deepLink /approvals)
and "question" (system_list_knowledge_gaps: title = the question, subtitle =
how often and by how many, deepLink /studio/knowledge?section=gaps). Their
sources have no §9.4 list; `hasMore` says more exist on the linked screen.
A thread about one approval request (design 03): POST /threads accepts
`context: { approvalId }`; the request must be the workspace's and, when it
is tied to a conversation, one the caller can see, else 404
{ code: "APPROVAL_NOT_FOUND" }. `context` comes back on create, GET
/threads/:id and the list, and survives a scope PATCH. There the assistant
reads the request (system_read_approval: a `record` of kind "approval" with
`state` pending|approved|rejected|expired and `expiresAt` ISO, deepLink
/approvals?id=<id>) and can only explain it: no tool approves or rejects.
The record's fields are what, steps or action, why (the gate in words: a plan
from Home or the command bar always waits; a tool says which approval setting;
known tags in words, internal tags never), risk (a plan's is its highest
step's), asked_by, customer, state, expires or created. A thread about a
request never suggests proposing a plan. It is created with its title,
"על הבקשה: <the request's summary>" ("About the request: ..." in English, by
`locale` in the body, else the user's or workspace's), never a model's; a
rename by the user still wins.

The answer cites a source after the claim it supports with `[^s1]` in `text`.
The client renders it as that source's chip. The server removes any `[^...]`
that is not a source of the message (`[^s9]`, or the model's own words in
brackets), with the space before it, in the saved text AND in the stream (a
possible marker is held back until it closes), so `text.delta` never carries
one. The chips under the answer
(design 01a) are `sources`, in order.

### 9.4 The full list behind a source

`GET /api/assistant/threads/:id/messages/:messageId/sources/:sourceId/records?cursor=`
→ `200 { data: RecordListItem[], nextCursor }` (25 a page). Re-runs the saved
`query` with the caller's CURRENT visibility (a list never shows what the user
may no longer see). `404` when the thread is not theirs or the source does not
exist; `409 { code: "SOURCE_UNAVAILABLE" }` when the store can no longer be read.

### 9.5 Deep links

In-app paths without the locale prefix (the client adds it), from a fixed
server table, never written by the model:

| Target | Path |
|---|---|
| a conversation | `/inbox?c=<conversationId>` |
| conversations in a period | `/inbox?view=all&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>` (started in it, workspace days) |
| conversations on a channel in a period | `/inbox?view=all&channel=<CHANNEL>&from=...&to=...` (WHATSAPP, INSTAGRAM, MESSENGER, EMAIL, WEBCHAT, SHOPIFY_LIVE_CHAT) |
| waiting for the team | `/inbox?view=queue` |
| a customer | `/customers/<contactId>` |
| a customer's orders / returns | `/customers/<contactId>?tab=orders` (`&filter=returns`) |
| analytics | `/analytics?tab=overview` (`gotcha`, `team`, `sales`, `topics`) |

**Asks for Frontend (found while mapping the redesign):**
Both former asks are done and live on dev (frontend d197839 and 579fca8 in
961f886; `GET /api/conversations?from&to`). `view=all` (frontend 542e695: every
conversation, automated included) is required: without it the link opens the default
"Waiting in queue" view, far fewer rows than the chart. Until 542e695 is on dev the
server sends NO period link. A conversations source links to
the inbox only when the inbox shows the same rows: no link for a mention, a
status, several channels, or a channel the inbox cannot filter (VOICE...).

### 9.6 Stream

Two new events, both before `message.done`:

| event | data | when |
|---|---|---|
| `block` | `{ block }` | a query tool finished; the block is final (render it as it arrives) |
| `sources` | `{ items: Source[] }` | once, after the text: every source the text cites or a block uses |

`text.delta` may contain `[^sN]` markers. `GET /threads/:id` returns
`blocks` and `sources` on each assistant message.

