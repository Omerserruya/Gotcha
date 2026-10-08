# Conversation intelligence on every close

Status: BUILT, OFF until switched on (2026-10-08). Owner: backend. Design approved
by the supervisor; switching it on, the dev backfill and the incoming-worker rebuild
are Omer's.

The Home chat answers "by intent" and "by sentiment" from `ConversationIntelligence`.
On dev that table holds a usable answer for **0 of 88** real conversations: 14 rows,
12 of them `unknown / neutral / confidence 0` and 2 `general / neutral`. The Home
chat already says "recorded for N of M". This design makes N close to M: every real
conversation is analysed once when it closes, however it closes, at a capped cost.

## 1. What exists (evidence)

| Piece | Where | What it does |
|---|---|---|
| Close subscriber | `services/ai/src/workers/post-chat/subscriber.ts` | On `conversation:closed`: post-chat pipeline (summary to `Conversation.aiSummary`, CRM patch, tasks, follow-up), customer brief, CRM close note. Writes NO `ConversationIntelligence`. |
| AI analyser | `services/ai/src/services/conversation-intelligence.service.ts` `analyzeConversation` | 3 model calls: intent of the LAST inbound message only (free-form string), a summary, the sentiment. Upserts `ConversationIntelligence`. Reached only by `POST /api/ai-assist/:id/analyze`, a user-authenticated route. |
| Worker analyser | `services/incoming-worker/src/services/intelligence.service.ts` | POSTs to that route with NO auth header (always 401), then falls back to English keyword regexes ("general" for any Hebrew text) and upserts. |
| Who calls the worker analyser | `incoming-worker/src/workers/idle-conversation.worker.ts` :285 (idle auto-close), :105 (approval expiry handoff) | Only these two paths. |

### Close paths and what they publish

| Path | Sets | Publishes |
|---|---|---|
| Agent closes (`conversation.service close`) | CLOSED + closedAt | `conversation:closed` |
| Bot `close_conversation` (ai-bot.service :533) | CLOSED + closedAt | `conversation:closed` |
| Idle timeout (idle worker :262) | CLOSED + closedAt | `conversation:closed` |
| Website to WhatsApp handoff | CLOSED + closedAt | `conversation:closed` |
| Flow builder close node (flow-executor :2068) | CLOSED, **no closedAt** | `conversation:updated` {status CLOSED} only |
| Expired comment-DM bridge (idle worker :146) | CLOSED + closedAt | `conversation:updated` {status CLOSED} only |
| `close_conversation` from any other runner (agent-tools.ts :1813) | CLOSED + closedAt | nothing ("the caller publishes") |

## 2. Why the coverage is ~0

1. **One trigger out of seven close paths.** Only the idle timeout called the analyser.
2. **That call can never succeed.** The route requires a user token; the worker sends none.
   Every analysis fell to keyword heuristics (English only).
3. **The AI analyser itself is weak where it does run.** Intent of the last message, not
   the conversation; a free-form intent string (no two runs agree on a key, so a
   breakdown cannot group them); `classifyIntent` is called with `tenantId: ""`, so the
   call is not attributed (and possibly refused by the AI-units gate). On failure it
   returns `unknown / 0`, which is what dev holds.
4. **No cost control.** Three calls per analysis, unmetered, and nothing bounds a burst.

## 3. Design

**One analyser, in `services/ai`, one trigger family, one model call.**

### 3.1 Trigger
- The existing post-chat subscriber also handles `conversation:updated` when
  `data.status === "CLOSED"` (flow close, bridge expiry). It runs the analysis AFTER the
  post-chat pipeline, so the pipeline's summary is already on the conversation.
- **A sweeper** in the ai service (every 15 minutes, BullMQ repeatable job like the
  existing ones) catches whatever no event announced: real conversations, status
  CLOSED, updated in the last 7 days, whose analysis is missing or older than their
  last message. This is what makes "however it closes" true, including a lost event.
- Idempotent: skip when `analyzedAt >= lastMessageAt` (a reopened conversation that got
  new messages is analysed again when it closes again). A Redis lock
  `intel:lock:<conversationId>` (10 min) stops the event and the sweeper running twice.

### 3.2 Which conversations
- Real only: `REAL_CONVERSATION` (no rehearsals, no test rows).
- Not VOICE (voice has its own post-call analysis).
- Not a conversation with no customer text (nothing to analyse; no row is written, so
  the Home chat's "of M" counts it as not recorded rather than as "neutral").

### 3.3 The call
- One JSON call on the micro tier (`getMicroModel()`, gpt-5-nano by default), through
  `generateResponse` with the REAL `tenantId`: metered in AI units and refused by
  `assertAiAllowed` when the wallet is empty (then skipped and logged, never retried in
  a loop).
- Input: the last 40 non-system messages, each cut to 500 characters, the whole cut to
  6,000 characters, labelled customer / business. Workspace language from
  `resolveEffectiveLocale`.
- Output, validated (anything invalid becomes "not recorded", never a guess):
  - `intent`: one key from the fixed list in §4
  - `sentiment`: positive | neutral | negative, `sentimentScore` -1..1
  - `topics`: up to 3 short phrases in the workspace language
- `summary`: copied from `Conversation.aiSummary` (the post-chat pipeline's), no
  second summary call. `resolutionOutcome` and `customerEffort`: the existing
  deterministic rules.
- The intent is also written to the last inbound message's `metadata.intent` (the
  existing behaviour, which `conversation-memory.service` reads).

### 3.4 Removed
- incoming-worker's heuristic analyser and its two callers (idle close is covered by the
  event; the handoff summary it was meant to give never worked; see §8).
- The ai analyser's three-call body: `POST /api/ai-assist/:id/analyze` (manual
  re-analysis) runs the new analyser instead. One implementation.

## 4. Intents (fixed list, labelled in both languages)

| key | en | he |
|---|---|---|
| order_status | Order status | סטטוס הזמנה |
| shipping | Shipping and delivery | משלוח |
| returns_exchanges | Returns and exchanges | החזרות והחלפות |
| refund | Refunds | החזרים כספיים |
| product_question | Product questions | שאלות על מוצר |
| pricing_purchase | Pricing and buying | מחיר ורכישה |
| booking | Appointments | תיאום פגישה |
| billing_payment | Billing and payment | חיוב ותשלום |
| technical_issue | Technical issue | תקלה טכנית |
| complaint | Complaint | תלונה |
| account | Account | חשבון |
| other | Other | אחר |

The Home chat's intent breakdown shows these labels (today it shows the raw key).

## 5. Cost cap

- Per workspace per day: `CONVERSATION_ANALYSIS_DAILY_CAP` (default 300), a Redis
  counter `intel:cap:<tenantId>:<YYYY-MM-DD>` (workspace day, 48h TTL). Over the cap:
  skipped and logged; the sweeper picks it up on a later day while it is still within
  the 7-day window. The Home chat's coverage shows the gap honestly.
- At most 2 analyses at once per ai process (a burst of closes queues, not fans out).
- Bounded input (§3.3) bounds the price of one analysis.
- **How a capped day reads.** A conversation over the cap gets no row. The Home chat's
  intent and sentiment breakdowns say "recorded for N of M": on a capped day N is lower
  than M by the conversations still waiting, and N catches up as the sweeper analyses
  them on later days (within 7 days of the close). A gap is therefore "not analysed
  yet", never "no intent": the breakdown never fills it with a guess.
- **What else is "not recorded".** A conversation with no customer text, an answer the
  model gave outside the list, and three failed calls each leave a row WITHOUT an
  intent (`metadata.outcome` says which). They count in M, not in N, and are not tried
  again until the conversation has new messages.

Price of one analysis, at gpt-5-mini prices (the repo's documented basis, $0.25 / 1M
input, $2 / 1M output; nano is cheaper): about 450 prompt tokens + the transcript
(dev median about 120 tokens, the 6,000-character cut at most about 3,000) + about
80 output tokens: **$0.0003 typical, $0.001 at the cut**. At the default cap a
workspace spends at most about $0.30 a day.

## 6. Dev backfill (only with Omer)

Dev has 68 closed real conversations (transcripts: mean 545 characters, median 239,
max 15,900; one above the 6,000 cut). One analysis each: about **$0.02 to $0.03** in
total (worst case, every one at the cut: $0.07), well under 10 AI units. The backfill is
the sweeper run once with the 7-day window lifted, by hand, in the ai container. It
overwrites the 14 existing junk rows.

## 7. Switching it on

Automatic analyses are OFF until switched on, because they spend money and the first
sweep analyses the last 7 days (a partial backfill):
- `CONVERSATION_ANALYSIS=on|off` in the ai service's environment decides when set;
- otherwise the Redis key `intel:enabled` = `"1"` switches it on (and deleting it
  switches it off) with no rebuild and no compose change.
- A person asking (`POST /api/ai-assist/:id/analyze`) is never switched off.

## 8. What changes where

| Service | Change | Needs |
|---|---|---|
| ai | analyser, subscriber (`updated` + CLOSED), sweeper, cap, labels in the Home chat | restart (src is bind-mounted) |
| incoming-worker | remove the heuristic analyser and its 2 callers | image rebuild |
| shared | nothing (no migration: `ConversationIntelligence` already has every field) | none |

## 9. Decisions taken (assumptions, per "decide and document")

- **Handoff summary (F7): removed, on the backlog.** The approval-expiry handoff was
  meant to give the incoming human an instant analysis; it never worked (401, then
  English keyword guesses). Removed, not rebuilt. No screen presents it as working: the
  only reader of a conversation's intelligence is the old (v1) co-pilot panel
  (`frontend/src/components/conversations/CoPilotPanel.tsx`), which shows whatever row
  exists and falls back to "general / neutral" when there is none (a guess on screen:
  reported, not changed here). The redesign does not read it.
- **Backlog: an instant summary for the human who takes over** (approval expiry,
  escalation). Would reuse `analyzeConversationOnClose` with a `handoff` trigger on an
  open conversation, under the same cap. Not built.
- **Backlog: remove the superseded `analyzeConversation`** in
  `services/ai/src/services/conversation-intelligence.service.ts` together with its test
  (`per-message-intent.test.ts`, which holds someone else's uncommitted edits). Nothing
  calls it.
- **Flow close sets no `closedAt`.** Not changed here (it is incoming-worker behaviour
  with its own readers); the sweeper keys on status and `updatedAt`, so it does not need
  it.
- **Fixed intents, not per-business intents.** A breakdown needs stable keys; a
  workspace's own topics live in `topics`.
- **Sentiment of the customer's side only**, as today.

## 10. Tests and live check

- Through the subscriber with a fake bus event: each close path's event shape analyses
  once; `updated` without CLOSED does nothing; a rehearsal, a test row, VOICE and a
  conversation with no customer text are skipped; a second event within the lock does
  not double-run; a reopened-and-closed conversation is analysed again.
- The sweeper finds a CLOSED conversation no event announced; respects the 7-day window.
- The cap: the 301st analysis of the day is skipped; the next day it runs.
- Output validation: an intent outside the list, a malformed JSON, a model error, all
  write nothing.
- Mutation checks on the cap, the lock, the window and the filters.
- Live check (with Omer's word): close a fake webchat conversation on dev, see one row
  with a listed intent; then the Home chat's "by intent" shows it with its label.
