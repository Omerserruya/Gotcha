# Historical Intelligence Import

How GOTCHA learns from a business's existing conversation history.

First and only source implemented: **WhatsApp Business App**, through Meta
Coexistence chat-history sync. The pipeline below the adapter is source
agnostic on purpose, so Glassix / Gorgias / Intercom / CSV can be added later by
writing one adapter and nothing else. None of those are implemented now.

---

## 1. What the source can actually give us

Everything downstream is shaped by four hard limits Meta imposes. They are not
design choices of ours and they cannot be engineered around.

| Limit | Consequence for the product |
|---|---|
| **180 days** of history, measured from onboarding | The import is a snapshot, never a full archive. Copy must not promise "all your history". |
| **24 hours** to receive it, then the business must offboard and redo signup | A watchdog has to fail the import honestly rather than wait forever. |
| **Once only.** No re-sync API | A channel *reconnect* is NOT a new import. Re-import requires re-onboarding, and the UI has to say so. |
| Media asset ids only for media **< 14 days** old | Most historical media arrives with no downloadable asset. That is normal, not a failure. |

Payload facts that drive the parser:

* Webhook field is `history`; `phase` (0/1/2), `chunk_order` and `progress`
  are documented by Meta under `value.metadata` and by 360Dialog under
  `value.history[].metadata`. **We read both.**
* Chunks **arrive out of order** - Meta says to re-sequence by `chunk_order`.
* `progress` is an integer percentage. `100` is the only completion signal;
  there is no separate "done" event.
* A business that declined sharing produces `history[].errors[]` with code
  **2593109**. That is `NOT_AVAILABLE`, not a failure.
* `threads[].id` is the customer's phone number. Direction is derived by
  comparing `from` against the business display phone number.

Full researched spec, with sources: see the reference memory and
`docs/integrations/whatsapp/`.

---

## 2. Shape

```text
WhatsApp Business App
        |
Meta Coexistence `history` webhook          <- services/webhook (unchanged shape)
        |
WhatsApp history adapter                    <- packages/shared/src/channels
        |
Normalized historical chunk  ---------------- the source-agnostic seam
        |
HistoricalImportChunk (raw, idempotent)     <- services/incoming-worker
        |
Ingest: Conversation + Message, origin=HISTORICAL_IMPORT
        |
Identity resolution (lookup only)
        |
   +------------------+---------------------+
   |                  |                     |
Customer memory   Knowledge mining     Analytics
(internal)        (review required)    (business insight)
```

The seam is the **normalized historical chunk**. Everything above it is
WhatsApp-specific; everything below it knows only `source`, `externalThreadId`,
`sender`, `direction`, `timestamp`, `content`. A second source implements
`extractHistorySync()` and reuses the entire lower half.

### Why the pipeline is not WhatsApp-specific

`HistoricalImport.source` is an enum, not a boolean. The ingest handler, the
identity resolver, the memory synthesizer, the knowledge miner and the analytics
stage all take an `importId` and never read a WhatsApp field. The only
WhatsApp-aware code is the adapter and the webhook field registration.

---

## 3. Two states, never one

`ChannelAccount.connectionStatus` and `WhatsAppNumber.state` describe whether
the channel **works**. `HistoricalImport.status` describes whether the **import**
worked. They are separate rows and separate lifecycles.

A failed import must never make a working WhatsApp number look disconnected,
and a healthy number is not evidence that history arrived. The UI renders them
as two lines for exactly this reason:

```text
WhatsApp connected           <- channel
History sync 72%             <- import
```

---

## 4. Historical is not live

A historical message is data. A live message is an event.

`Message.origin` is an explicit enum column (`LIVE` | `HISTORICAL_IMPORT`),
defaulted to `LIVE`, never inferred from a timestamp. Historical rows are
written by a handler that has no path to the bot: it does not call
`ai-bot.service`, does not touch `chatbotFlowId`, does not publish
`message:new`, does not evaluate SLAs and does not mark a conversation as
needing attention.

The same rule the live and echo paths honour applies here: an
`InboundExclusion` match drops the thread. A number the owner deliberately keeps
private stays private, history included.

---

## 5. Data model

New enums and models, all tenant-scoped.

```prisma
enum RecordOrigin { LIVE HISTORICAL_IMPORT }
enum HistoricalImportSource { WHATSAPP_BUSINESS_APP }
enum HistoricalImportStatus {
  NOT_AVAILABLE PENDING SOURCE_SYNCING SOURCE_COMPLETE
  INGESTING IDENTITY_RESOLUTION CUSTOMER_LEARNING
  KNOWLEDGE_EXTRACTION KNOWLEDGE_CLUSTERING ANALYTICS
  REVIEW_READY COMPLETED FAILED
}
enum KnowledgeCandidateStatus { PENDING APPROVED REJECTED SUPERSEDED }
```

| Model | Purpose |
|---|---|
| `HistoricalImport` | One import run. Status, real progress counters, summary, failure reason, completion-email latch. |
| `HistoricalImportChunk` | Raw chunk as received. `@@unique([importId, phase, chunkOrder])` is the webhook-retry idempotency anchor and makes the whole pipeline replayable. |
| `HistoricalImportEvent` | Append-only audit per step, modelled on `WhatsAppNumberEvent`. |
| `HistoricalCustomer` | Per-import participant: normalized phone, link results, per-customer processing state. The unit of work for customer learning and the source of the analytics counts. |
| `CustomerHistoricalMemory` | Durable, tenant-scoped customer understanding. `@@unique([tenantId, customerExternalId])` so a retry rebuilds rather than appends. |
| `KnowledgeCandidate` | A reviewable suggestion. Never production knowledge. |
| `KnowledgeCandidateEvidence` | The conversations behind a candidate, for "view examples". |

Columns added to existing tables, both defaulted so existing rows are untouched:

* `Message.origin`, `Message.historicalImportId`
* `Conversation.origin`, `Conversation.historicalImportId`

Two **partial** unique indexes are created in raw SQL. Partial, because a plain
unique index on `messages.external_message_id` would be a risky migration on a
large live table, while a predicate-scoped one constrains only rows this feature
creates:

```sql
CREATE UNIQUE INDEX messages_historical_external_id_key
  ON messages (tenant_id, external_message_id)
  WHERE origin = 'HISTORICAL_IMPORT' AND external_message_id IS NOT NULL;

CREATE UNIQUE INDEX conversations_historical_customer_key
  ON conversations (historical_import_id, customer_external_id)
  WHERE historical_import_id IS NOT NULL;
```

---

## 6. Identity: linking is not creation

Historical participants are resolved against what already exists. Nothing is
created in Shopify, a CRM, or any other external system of record.

This is enforced structurally rather than by discipline. Resolution goes through
`getSourceOfTruth(tenantId)` (`services/ai/src/services/connectors/source-of-truth.ts`),
whose `SourceOfTruthProvider` interface exposes `identifyCustomer` and has **no
create method at all**. `createLead` / `customerCreate` live on the raw
`CRMAdapter` beneath the facade, which this pipeline never obtains. A future
edit that tried to create an external customer here would not compile.

Order of resolution, cheapest first:

1. Normalize the phone to E.164 with the existing `normalizePhone` helper.
2. `resolveContactByChannelId` - an existing GOTCHA `Contact`.
3. `getSourceOfTruth(tenantId).identifyCustomer({ phone })` - lookup only.

Internal GOTCHA identities *may* be enriched from what the conversations reveal
(an email, an Instagram handle), stamped with
`source: "historical_whatsapp_import"`, and only where the field is currently
empty. Weaker inferred data never overwrites stronger known data, and none of it
is written back outward.

---

## 7. Knowledge is evidence, not truth

Human agents make mistakes, grant exceptions, quote old policies and contradict
each other. So a mined answer is never promoted automatically, and "high
confidence" means only *we consistently observed this*, never *this is current
policy*.

Extraction is a staged pipeline, deterministic wherever it can be:

```text
messages -> per-customer chunks -> Q&A extraction (LLM, schema-validated)
  -> normalization -> embedding -> clustering -> canonical candidate
  -> conflict detection -> review queue
```

* Embeddings and clustering reuse the existing stack: `text-embedding-3-small`
  into **Qdrant** (vectors have never lived in Postgres here), filtered by
  `tenantId` on every query.
* Before a candidate is created, and again before approval, it is searched
  against the tenant's existing KB. An equivalent hit marks it
  `duplicateOfDocumentId` rather than creating a second entry.
* Contradictory answers in one cluster set `conflict = true` and keep every
  variant with its own counts. The owner picks or writes the right one. Nothing
  is silently chosen, and conflicted or low-confidence items are excluded from
  bulk approve.

Approval writes a `KnowledgeDocument` in the existing Knowledge Base, stamped
`source = historical_conversations`, `sourceProvider = whatsapp_business_app`,
with the candidate id retained for audit.

---

## 8. Progress that is real

Meta's own `progress` drives the bar while history is transferring. After 100
the bar is replaced by stage text with **counted** work, never an invented
percentage:

```text
WhatsApp history received
Analyzing customers  842 / 1,247
Finding business knowledge...
```

Every number shown anywhere - channel card, results page, email - is read from
the persisted summary, which is computed from rows that exist.

---

## 9. Orchestration

Ingest rides the existing `incoming-messages` queue as a new job name
(`process-history`), exactly as the Coexistence echo does. The webhook still
acknowledges before doing work.

The intelligence stages run on a new `historical-intelligence` queue owned by
`services/ai`, one job per stage per import so any stage can be retried alone
without redoing the ones before it. Every LLM call lives in `services/ai`, per
the repository rule, and is schema-validated, metered through `trackAIUsage` +
`meterAiUnits`, and batched per customer or per cluster - never one call per
message, never thousands of messages in one prompt.

---

## 10. Completion

The email is sent once, and only after ingest, identity, memory, knowledge and
analytics have all finished and the results are reviewable. Meta reporting
`progress = 100` is not sufficient and does not trigger it.

Idempotency is a conditional update on a latch column: whichever worker sets
`completionEmailSentAt` from null wins and enqueues; every retry loses and sends
nothing.
