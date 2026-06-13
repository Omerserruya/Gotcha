# GOTCHA Customer Intelligence Architecture

> **Status:** Design / architecture (no implementation). Source of truth for the
> Customer Intelligence Platform direction.
> **Author:** generated against the live codebase (2026-06-12).
> **Constraint baseline:** `CLAUDE.md` — no new microservices, NEW LLM calls only
> in `services/ai`, no new dependencies, every user-facing change touches UI +
> backend, sparse-patch contract preserved.

---

## 0. Thesis

GOTCHA is repositioned from a **messaging platform** to a **Customer Intelligence
Platform**. The central domain object is no longer the *conversation* or the
*message* — it is the **Customer Intelligence Object (CIO)**: one live, structured,
per-customer record that every channel enriches and every surface consumes.

```
            ┌──────────── enrich ────────────┐
  WhatsApp ─┤                                 │
  Voice    ─┤      Intelligence Engine        │
  Email    ─┼──►  (services/ai, LLM-only) ──► │  Customer Intelligence Object
  Instagram┤                                 │  (canonical: CustomerBrief)
  Webchat  ─┤                                 │
  AI Empl. ─┘                                 │
            └──────────── consume ────────────┘
                  │      │      │      │      │      │
                Inbox  Copilot AIEmp  CRM  Analytics Automation
```

The **summary becomes an output**, not the source of truth. The structured object
is the source of truth; summaries (human + executive) are *projections* of it.

---

## 1. What already exists (reuse map)

This architecture is ~60% assembly of existing primitives, not greenfield.

| Capability | Existing primitive | Location |
|---|---|---|
| Per-customer cross-channel memory (canonical store) | **`CustomerBrief`** (prose + signals + behaviors, per-locale, identity-keyed, CRM-linked) | `schema.prisma` model `CustomerBrief`; `services/ai/.../customer-brief.service.ts` |
| Per-conversation intelligence | **`ConversationIntelligence`** (intent, sentiment, topics, effort, confidence) | `schema.prisma` model `ConversationIntelligence`; `conversation-intelligence.service.ts` |
| Custom extraction fields (typed) | **`summaryFields`** in `PostConversationConfig` (key/label/type/enum/options) | `post-conversation-config.service.ts` |
| Structured extraction (LLM) | `summarizePostConversation` → sparse `crm_patch` gated by `allowedFields` | `post-conversation-summarizer.service.ts` |
| Live extraction during a session | **`LiveAnalysisRunner`** (frames, `missing_fields.updated`, urgency, risk) | `services/ai/.../intelligence/live-analysis-runner.ts` |
| CRM write (fields > status > note) | `applyCrmPatchKindAware` + `appendInteraction` | `post-conversation-crm.service.ts`, `connectors/crm-adapter.impl.ts` |
| Suggested-field seed signal | `bonus_highlights` (reusable snake_case labels, counted across calls) | `post-conversation-summarizer.service.ts` |
| Business type | `BusinessProfile.industry` (free text, AI-classified from website) | `services/auth/.../onboarding.ts` |
| Marketplace surface | `frontend/.../ai-studio/marketplace` | frontend |

**Net-new work** is therefore: (a) promote `CustomerBrief` to the structured CIO,
(b) Industry Packs catalog, (c) live extraction for *text* channels into the CIO,
(d) the unified Intelligence Card, (e) event-driven executive summary, (f) the
Discovery Engine.

---

## 2. Customer Intelligence Object (CIO)

### 2.1 Canonical store: extend `CustomerBrief`

The CIO is **not a new table**. `CustomerBrief` is already per-customer,
cross-channel, identity-keyed (`tenantId + identityKey + locale`), CRM-linked
(`crmContactId`, `crmObjectKind`), and refreshed by an existing pipeline. We
promote it into the canonical intelligence record by adding structured columns:

```
CustomerBrief (EXTENDED → "Customer Intelligence Object")
  // ── existing (keep) ──
  id, tenantId, identityKey, personId, contactId
  crmContactId, crmObjectKind, locale
  brief                  // headline prose briefing (human summary)
  signals  Json          // "keep in mind right now" phrases
  tone, mood
  recommendedBehaviors Json
  channels Json, conversationCount, lastSource*
  generatedAt, createdAt, updatedAt

  // ── NEW (structured intelligence) ──
  universalFields  Json   // typed universal slots (see §3)
  industryFields   Json   // typed industry/custom slots (see §4, §5)
  executiveSummary String? // event-driven living summary (see §6)
  packId           String? // FK → IndustryPack applied to this tenant
  fieldConfidence  Json    // per-field { value, confidence, source, extractedAt }
  intelligenceVersion Int  // bumped on every enrichment for optimistic concurrency
```

> Per-locale note: `CustomerBrief` is unique on `(tenantId, identityKey, locale)`.
> **Structured fields are language-agnostic** (`guest_count: 350`,
> `status: "awaiting_quote"`) and must be stored **once per identity, not per
> locale**. Decision: keep structured `universalFields`/`industryFields` on the
> **default-locale row** (or a `locale="*"` canonical row) and let prose
> (`brief`, `executiveSummary`) remain per-locale projections. This avoids
> divergent numbers across language rows.

### 2.2 Conceptual shape (read model)

```jsonc
CustomerIntelligence {
  // identity
  customer_name, phone, email,
  // universal (§3)
  intent, status, sentiment, urgency,
  next_step, pending_action, last_objection,
  // projections
  ai_summary,            // human summary  (brief)
  executive_summary,     // living exec summary
  // structured
  industry_fields: { ...packId fields + custom fields },
  // operational
  pack_id, confidence, extracted_at, version
}
```

### 2.3 Provenance contract

Every structured value carries `{ value, confidence, source, extractedAt }` in
`fieldConfidence`. `source ∈ { llm_live, llm_close, rule, manual, crm_inbound }`.
**Manual edits always win** over LLM and are never overwritten by extraction
(mirrors the sparse-patch / "never wipe prior data" rule —
`feedback_post_conversation_crm_merge`).

---

## 3. Universal Fields

Channel- and industry-independent slots present on **every** CIO. These are the
"3-second understanding" core.

| Field | Type | Derived from (existing) |
|---|---|---|
| `intent` | enum/string | `ConversationIntelligence.detectedIntent`, summarizer `intent` |
| `status` | enum (lead/pipeline status) | summarizer `status_change`, funnel stage |
| `sentiment` | enum positive/neutral/negative/mixed | `ConversationIntelligence.sentiment`, summarizer |
| `urgency` | enum low/normal/high/critical | `LiveAnalysisRunner` urgency (`normalizeUrgencyEnums`) |
| `next_step` | string | summarizer `suggested_tasks` / stage goal |
| `pending_action` | string | open tasks / `awaiting_approval` / scheduled follow-up |
| `last_objection` | string | summarizer `bonus_highlights` (objection labels) |
| `ai_summary` | string | `brief` projection (human summary) |

Universal fields are a **fixed built-in pack** (analogous to the builtin keys in
`getSummarizerAllowedFields`: `status, stage, budget, timeline, decision_maker,
company, role`). They cannot be deleted, only augmented.

---

## 4. Industry Packs

### 4.1 Concept

An **Industry Pack** is a named, versioned bundle of predefined `summaryFields`
(typed extraction slots) plus optional default task/CRM rules. Selecting a pack
seeds the tenant's `PostConversationConfig.summaryFields` and the CIO schema.

### 4.2 Data model (new catalog table)

```
IndustryPack
  id, slug ("event_hall"), name, version
  fields      Json   // SummaryFieldDef[]  (reuses existing shape)
  defaultRules Json  // optional TaskRule[]/CrmRule[]
  isSystem    Bool   // shipped vs tenant-cloned
  locale-neutral
```

`SummaryFieldDef` is the **already-existing** shape — no new field schema needed:
`{ key, label, description?, type: text|number|boolean|enum, options? }`
(`post-conversation-config.service.ts:23`).

### 4.3 Seed packs (ship as `isSystem`)

- **Event Hall** — `event_type, event_date, event_time, guest_count, budget, kosher_level(enum), outdoor_ceremony(bool), parking_required(bool), special_requests, bride_name, groom_name`
- **Real Estate** — `property_type, rooms(number), budget, location, move_date, mortgage_required(bool)`
- **Recruiting** — `desired_position, expected_salary, availability, experience_years(number), security_clearance(bool)`
- **Ecommerce** — `order_number, order_status(enum), product, refund_requested(bool), shipping_issue(bool), delivery_date` (note: read paths can hydrate from the Shopify CRM adapter)
- Generic Business — universal fields only.

### 4.4 Onboarding wiring (extends existing flow)

`BusinessProfile.industry` is already AI-classified from the website
(`onboarding.ts:1152-1199`). Extend the classifier output to also return a
`packSlug` (best-match against the pack catalog) and present it as a confirm step:

```
Detected business type: Event Hall  →  Load "Event Hall Pack" (11 fields)?  [Approve]
```

On approve: clone the system pack's `fields` into
`PostConversationConfig.summaryFields` and set `CustomerBrief.packId` default for
new customers. Packs are also browseable in the existing **Marketplace** surface.

---

## 5. Custom Fields

Tenants extend any pack with their own fields. This **already exists** as
`PostConversationConfig.summaryFields` — the Custom Fields Builder is a UI over it.

Field configuration (maps 1:1 to `SummaryFieldDef` + two new flags):

| Builder field | Backing |
|---|---|
| Name / Description / Type / Examples(options) | `SummaryFieldDef.{label,description,type,options}` |
| Required | new `required: boolean` on `SummaryFieldDef` |
| AI Extraction Enabled | new `aiExtract: boolean` (when true → key added to `allowedFields`) |
| Sync To CRM | new `syncToCrm: boolean` (when true → key allowed into `crm_patch` mapping, §8) |

`getSummarizerAllowedFields` already merges builtins + `summaryFields.map(key)` —
the only change is honoring the `aiExtract`/`syncToCrm` flags when composing the
allow-lists.

---

## 6. Executive Summary (living)

Two distinct summaries, both **projections** of the CIO (not the source):

1. **Human summary** (`brief`) — 3-5 sentence behavioral briefing, already produced
   by `customer-brief.service.refreshCustomerBriefFromConversation`.
2. **Executive summary** (`executiveSummary`, NEW) — a living operational narrative
   regenerated on **business events**, not only at conversation close.

### 6.1 Regeneration triggers (event-driven)

Subscribe (existing event bus, `subscribeToEvents`) to:
`conversation:closed`, `status.changed`, `quote.sent`, `meeting.scheduled`,
`task.completed`, `followup.scheduled`. Each fires a **debounced** regeneration
of `executiveSummary` from the current CIO + recent timeline (§7).

```
Lead is currently evaluating proposals. Quote sent on July 12.
Follow-up call scheduled for July 15. Customer requested vegan menu options.
```

### 6.2 Cost discipline

Debounce (e.g. ≤1 regeneration / 60s / customer), cap input via the existing
bounded-context patterns (`getSessionMemory limit`, transcript slicing). LLM call
lives in `services/ai` only.

---

## 7. Customer Timeline

A unified, append-only event stream per customer — the substrate the executive
summary and analytics read from.

### 7.1 Source

No new write path required for most of it — **derive** from existing rows:
`Message`, `ConversationIntelligence`, `ToolExecution`, `ScheduledMessage`,
`ApprovalRequest`, CRM `appendInteraction` activity, task/followup events. A thin
`CustomerTimeline` read-model (view or lightweight table) keyed by `identityKey`
orders these into:

```
[Δ] field changed   guest_count: 200 → 350        (llm_live, conf 0.82)
[✉] message          inbound WhatsApp
[⚑] status changed   new → awaiting_quote
[✓] task completed   "Send vegan menu PDF"
[📅] meeting          venue tour scheduled 15/09
```

### 7.2 Use

Powers the card's "what changed" strip, the executive-summary regeneration input,
and analytics funnels (§13).

---

## 8. CRM Mapping Layer

The CIO becomes the **single writer** to CRM, replacing ad-hoc per-path writes.
Mapping precedence (already partially implemented in
`applyCrmPatchKindAware`/`renderInteractionBody`):

```
1. Structured fields  → updateRecord(kind, { mapped CIO fields })   (preferred)
2. Status             → updateRecord(status field)
3. AI summary         → activity note (appendInteraction)            (fallback only)
```

### 8.1 Field mapping

Each `summaryFields[]` entry with `syncToCrm: true` gets a per-vendor target
column mapping (extends the existing per-vendor field maps in
`crm-adapter.impl.ts`, e.g. Fireberry/Airtable `fieldMap`). Universal `status`
maps to the vendor's lead-status field. **Never** push a raw note when a
structured field exists for the same datum — enforce in the mapping layer.

### 8.2 Invariants (carried over)

- **Sparse**: only changed, mentioned fields are written (`sparsifyPatch`).
- **Kind-aware**: Lead vs Contact routing preserved.
- **Idempotent**: `[gotcha_source_interaction_id=…]` marker drives dedup/update.
- **Localized note frame** with language-correct summary (the 2026-06-12 fix).

---

## 9. AI Suggested Fields (Discovery Engine)

### 9.1 Signal source (already emitted)

The summarizer already emits `bonus_highlights` with **reusable snake_case
labels** explicitly designed so "identical observations across calls can be
counted later" (`post-conversation-summarizer.service.ts`). This is the discovery
substrate — no new extraction needed.

### 9.2 Discovery loop (new, scheduled)

A scheduled job (cron, in `services/ai`) aggregates `bonus_highlights.label`
frequency over a rolling window per tenant:

```
SELECT label, COUNT(*) FROM bonus_highlights_window
GROUP BY label HAVING COUNT(*) >= threshold
AND label NOT IN (existing summaryFields keys)
```

Produces suggestions surfaced in the Fields Builder:

```
Suggested field:  Outdoor Ceremony   — appeared in 72 conversations   [Approve]
```

Approve → append a `SummaryFieldDef` (type inferred from sampled values) to
`PostConversationConfig.summaryFields`. Backfill is optional (re-extract recent
conversations for the new key).

---

## 10. Inbox UI

One component — `<CustomerIntelligenceCard>` — driven by the CIO read model,
rendered identically everywhere it appears.

```
┌─ Wedding · 350 guests · 15/09/2027 ───────────────┐
│ 💰 120,000 ₪      Status: Waiting For Quote        │
│ Sentiment: Positive   Urgency: Normal             │
│ Next action: Send pricing proposal                │
│ ── AI snapshot ─────────────────────────────────  │
│ Customer is planning a wedding for 350 guests,    │
│ interested in vegan menu. Awaiting proposal.      │
│ ── recent ──  guest_count 200→350 · venue tour 📅 │
└────────────────────────────────────────────────────┘
```

- Field rows render from `universalFields` + `industryFields` (typed → formatted:
  dates `dd/mm/yyyy`, currency, enums localized).
- Low-confidence fields visually flagged; click-to-edit writes `source: manual`.
- Opens in: inbox conversation header, contact profile, CRM panel
  (`routes/crm-panel.ts` already aggregates much of this).

---

## 11. Copilot Integration

Copilot already loads facts via its ASSIST tool surface and proposes write actions
for approval (`openai.provider.ts::suggestResponse`). Change: **inject the CIO as
structured context** into the copilot prompt so suggestions are grounded in
extracted facts without a tool round-trip.

- CIO `universalFields` + `industryFields` rendered into the copilot context slot
  (alongside the existing customer-context block).
- Copilot's proposed `quick_action`s (update CRM, schedule meeting) operate on
  CIO fields; approval still human-gated (unchanged).
- The card's "Next action" is the same `next_step` the copilot reasons about.

---

## 12. AI Employee Integration

The autonomous AI Employee (`ai-bot.service.ts`, agent runtime) consumes the CIO
as **conversation-entry context** so it continues with full memory:

- On inbound, load the CIO for the resolved identity → inject `universalFields` +
  `industryFields` into the system prompt (the bot already loads customer context;
  this makes it structured + typed).
- The bot's tool calls that capture data (`link_customer_identifier`, CRM tools)
  write back into the CIO via the same extraction/merge path (§7 provenance:
  `source: llm_live`).
- Pipeline/funnel `stage` ↔ CIO `status` stay in sync (existing stage-transition
  machinery in the summarizer + advance-worker).

---

## 13. Analytics Integration

The CIO + Customer Timeline make analytics **structured-first** instead of
text-mined.

- **Field-level reports**: distributions over typed fields (avg `guest_count`,
  `budget` by `event_type`, `status` funnel) — queryable because values are typed,
  not buried in prose.
- **Funnel/aging**: timeline status transitions → time-in-stage, stuck leads.
- **Sentiment/urgency trends**: already in `ConversationIntelligence`
  (`@@index` on sentiment/intent) — roll up to customer level via the CIO.
- Feeds the existing analytics service via read models (no cross-service DB joins;
  go through APIs per `CLAUDE.md`).

---

## 14. Automation Integration

The CIO is a **trigger source** and **condition source** for workflows
(`services/webhook` triggers + chatbot/workflow runtime).

- **Triggers**: `field.changed`, `status.changed`, `urgency >= high`,
  `pending_action set` emit events the automation engine subscribes to.
- **Conditions**: workflow branches read typed CIO fields
  (`if status == awaiting_quote && days_in_stage > 3 → task`).
- **Escalation**: `urgency = critical` or churn-risk signal (already detected by
  `LiveAnalysisRunner` `risk.detected`) → auto-escalate / notify.
- Actions remain service-owned (AI proposes/triggers, services execute) per the
  Service Ownership Boundary rule.

---

## 15. Live Extraction Flow (end-to-end)

```
inbound message (any channel)
   │
   ▼
identity resolve  ──►  load CIO (CustomerBrief by identityKey)
   │
   ▼
debounced live extractor  (services/ai, LLM, allowedFields = universal + pack + custom[aiExtract])
   │   reuse summarizePostConversation shape, run incrementally (not only at close)
   ▼
merge into CIO  (sparse, manual-wins, provenance-stamped, version-bumped)
   │
   ├─► append Customer Timeline events (field deltas)
   ├─► event-driven executive summary regen (debounced)
   ├─► CRM mapping layer (structured → status → note)
   └─► emit field.changed / status.changed → Automation + Analytics

conversation:closed  ──► final pass (existing post-chat-pipeline) reconciles CIO
```

**Voice** already does live frames via `LiveAnalysisRunner`; the new work is
giving **text** channels an equivalent incremental extractor that writes the CIO
(today text only extracts at close). Reuse the summarizer prompt + `allowedFields`;
gate by debounce + min-new-content to control cost.

---

## 16. Phased rollout (no half-work; each phase ships UI + backend)

| Phase | Scope | Key files |
|---|---|---|
| **P1 — CIO + Packs** | Extend `CustomerBrief` (structured cols + migration); `IndustryPack` table + 3–4 seed packs; onboarding industry→pack confirm; Fields Builder UI over `summaryFields` (+`required`/`aiExtract`/`syncToCrm`). | `schema.prisma`, `onboarding.ts`, `post-conversation-config.*`, frontend settings |
| **P2 — Live text extraction** | Incremental extractor on inbound → CIO merge (sparse, provenance); reconcile at close. | `services/ai` extractor, `post-chat-pipeline` |
| **P3 — Intelligence Card** | `<CustomerIntelligenceCard>` from CIO read model; inbox + contact + CRM panel. | frontend, `crm-panel.ts` read model |
| **P4 — Executive summary + Timeline** | Event-driven exec summary regen; `CustomerTimeline` read model. | `services/ai`, event subscribers |
| **P5 — CRM mapping layer** | Per-vendor field maps for `syncToCrm` fields; enforce structured-over-note. | `crm-adapter.impl.ts`, `post-conversation-crm.service.ts` |
| **P6 — Discovery Engine** | Scheduled `bonus_highlights` aggregation → suggested fields. | `services/ai` cron |
| **P7 — Analytics + Automation** | Field-level reports; CIO triggers/conditions. | analytics/webhook via APIs |

---

## 17. Open decisions (need product sign-off)

1. **Locale & structured fields** — confirm the "structured once per identity,
   prose per locale" model (§2.1). Recommended.
2. **CIO store** — confirmed: extend `CustomerBrief` (not a new table).
3. **Live extraction cadence/cost** — debounce window + model tier for the
   incremental text extractor (cost vs freshness).
4. **CRM field-map ownership** — auto-map by name heuristics vs explicit per-field
   mapping UI for `syncToCrm` fields.
5. **Backfill on new field approval** — re-extract recent conversations or
   forward-only.
6. **Confidence display threshold** — when to show a field as "unconfirmed" in the
   card and require human confirmation.

---

## 18. Guardrails carried from CLAUDE.md

- No new microservice — all of this lives in existing services (`services/ai` owns
  extraction + summaries; `auth`/onboarding owns packs config; CRM via adapters).
- NEW LLM calls only in `services/ai`.
- No new dependencies.
- AI proposes/extracts; **services own state** — the CIO is read/enriched via
  service APIs, never cross-service DB joins.
- Sparse-patch + manual-wins invariants are non-negotiable across every write path.
