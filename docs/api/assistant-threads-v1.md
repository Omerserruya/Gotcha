# Assistant threads API contract v1 (Home chat, design 7 frame 01a) - Stage 1

Served by `services/ai` (the existing agent engine, extended; no second engine).
Base path: `/api/assistant`. All routes need a signed-in user of the workspace.

**Stage 1** gives threads, history, streaming with steps, follow-up suggestions,
cancel and resume. `blocks`, `sources` and `actions` exist in the message shape
and are always `[]` in stage 1 (stage 2: query layer, blocks, sources; stage 3:
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

**Language:** steps, suggestions, the auto-title and the answer are written in
`locale` when it is sent (the UI language); without it, the user's profile
language, then the workspace's default. `locale` wins.

**Errors before the stream opens** are plain JSON with a non-200 status (§6):
400, 402 (billing refuses before any model call), 404, 409, 429. Once the
stream is open (200), failures arrive as `error` + `message.done`.

Every event has an `id:` (`<runId>:<seq>`, seq from 1, increasing). A comment
line `: ping` is sent every 25 s.

| event | data | when |
|---|---|---|
| `run.start` | `{ runId, userMessageId, messageId }` | first; `messageId` is the assistant message being written |
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

The model call and any running tool are really stopped (not just the stream). The
stream ends with `message.done` `{ status: "cancelled" }`; the text written so far
is kept. Cancelling a finished message answers `200 { data: { status: "<its status>" } }`.
Closing the browser tab does **not** cancel; use this route.

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
