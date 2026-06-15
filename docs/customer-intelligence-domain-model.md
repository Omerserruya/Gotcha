# GOTCHA Customer Intelligence - Domain Model (V2)

> **Status:** Domain design. **No code, no migrations, no Prisma DSL.** Conceptual
> entities, ownership, lifecycle, and storage strategy only.
> Companion to `customer-intelligence-v2.md` (the architecture review). This doc
> makes the three-domain model concrete enough to review before any schema work.
> **Author:** 2026-06-12, against the live codebase.

---

## 1. Entity map

Five core entities + a projection layer. Solid arrows = ownership (FK); dashed =
relationship edges (the implicit graph); the projection layer is **generated**, not
authored.

```
                         ┌───────────────────┐
                         │  FieldDefinition  │  scope-aware schema registry
                         │  (+ Pack)         │  (customer|opportunity|conversation)
                         └─────────┬─────────┘
                                   │ governs which facts may exist
                                   ▼
   ┌──────────────┐  1   ┌───────────────────┐  N   ┌────────────────────────┐
   │ CustomerProfile│◄───┤   (identity)      ├─────►│     Opportunity        │
   │ durable facts │     └───────────────────┘      │ per-deal intelligence  │
   └──────┬────────┘                                └───────────┬────────────┘
          │ 1                                                  │ N
          │ N                                                  │  ▲ sourced_from
          ▼                                                    ▼  │
   ┌──────────────────────────┐  N        contributes      ┌───────────────┐
   │ ConversationIntelligence │───────────────────────────►│ IntelligenceFact│
   │ per-interaction (exists) │     (provenance log)        │ append-only    │
   └──────────────────────────┘                            └───────────────┘
                                   │ project (generate)
                                   ▼
        ┌──────────── Projection layer (read models) ────────────┐
        │  CustomerBrief (prose)   Snapshot   ExecutiveSummary    │
        └────────────────────────────────────────────────────────┘
```

**Reuse vs new:**
- `ConversationIntelligence` - **exists**, keep (minor additions).
- `CustomerProfile` - **new** (can inherit `CustomerBrief`'s identity spine).
- `Opportunity` - **new** (the keystone).
- `FieldDefinition`/`Pack` - **new** (formalizes today's `summaryFields`).
- `IntelligenceFact` - **new** (provenance/history log).
- `CustomerBrief` - **exists**, demoted to a projection.

---

## 2. Identity & keying (reuse what's there)

The customer is resolved by the existing identity machinery - do **not** reinvent.

- `CustomerProfile` is keyed by `identityKey` (the same cross-channel key
  `CustomerBrief` already uses: `(tenantId, identityKey)`), with optional
  `personId`, `contactId`, `crmContactId`, `crmObjectKind`.
- One `CustomerProfile` per resolved identity per tenant - **language-neutral**
  (unlike `CustomerBrief` which is per-locale). Locale-specific prose lives only in
  projections.
- Identity merges (two channels → one person) merge the `CustomerProfile` and
  re-parent its Opportunities/facts. Merge policy reuses the existing identity
  service; facts carry provenance so a merge never silently loses data.

---

## 3. Storage strategy - the key decision

Packs and custom fields are **dynamic**, so fixed columns are impossible. Three
candidates:

| Option | Read speed | Query/analytics | History/provenance | Verdict |
|---|---|---|---|---|
| A. JSON blobs on the entity | fast | weak | none | insufficient |
| B. Pure EAV fact rows | slow (joins) | strong | strong | too slow for the card |
| **C. Hybrid (recommended)** | fast | strong | strong | ✅ |

### Recommended: Hybrid (denormalized snapshot + append-only fact log)

- **Current snapshot** = a denormalized JSON map of `{ fieldKey → value }` on each
  entity (`CustomerProfile.facts`, `Opportunity.facts`). Powers the Snapshot/card in
  one read. This is the **fast read model**.
- **`IntelligenceFact`** = append-only log; one row per *observation* of a field.
  This is the **source of truth** for how a value was learned, conflicts, history,
  and analytics. The snapshot is a materialized fold of the log under the merge
  policy.

```
IntelligenceFact (append-only)
  id, tenantId
  entityType   customer | opportunity | conversation
  entityId
  fieldKey                      // FK → FieldDefinition.key
  value        Json
  confidence   Float 0..1
  source       manual | crm_inbound | llm_close | llm_live | rule | derived
  observedAt   DateTime
  conversationId?               // provenance: where observed
  validUntil?  DateTime         // temporal validity (deal/seasonal facts)
  supersededBy?                 // id of the fact that replaced it (audit chain)
```

The snapshot is recomputed (or incrementally updated) whenever a new fact lands,
applying §5 merge rules. **No fact is ever deleted** - superseded, never lost. This
is what structurally guarantees "a conversation can't destroy customer data."

---

## 4. Entity specifications (design-level)

> Field tables are **conceptual** (name · type · scope/owner · notes), not a schema.

### 4.1 CustomerProfile - durable, per-identity

| Field | Type | Notes |
|---|---|---|
| identityKey | string | canonical cross-channel key (reuse) |
| personId / contactId / crmContactId / crmObjectKind | string? | links (reuse from CustomerBrief) |
| displayName, phone, email | string? | identity basics |
| facts | Json snapshot | durable customer facts (see below) |
| behavioralSignals | Json | trust/friction/relationship (reuse BEL signals) |
| firstSeenAt, lastSeenAt | DateTime | lifecycle |

**Owned durable facts** (examples, governed by `FieldDefinition` scope=customer):
`language`, `preferred_contact_time`, `communication_style`, `vip_tier`, `timezone`,
`role_title`, `do_not_contact`. These **never** belong to a conversation or a deal.

### 4.2 Opportunity - per-deal intelligence (the keystone)

| Field | Type | Notes |
|---|---|---|
| id, tenantId | | |
| customerProfileId | FK | parent customer |
| type / packId | string | e.g. `event_hall`, `ecommerce_order` |
| title | string | "Wedding · Sept 2027" (generated) |
| stage | string | FK to `TenantFunnel`/`FunnelStage` (reuse) |
| status | enum | open · won · lost · abandoned · archived |
| estimatedValue | number? | for analytics/forecasting |
| nextAction | string? | the single next step |
| facts | Json snapshot | deal facts (event_date, guest_count, budget, …) |
| relationships | Json | edges (see §6): proposed_entity, decision_maker, … |
| openedAt, closedAt, lastActivityAt | DateTime | lifecycle |

**Owned deal facts** (governed by `FieldDefinition` scope=opportunity): everything
the industry packs describe - `event_date`, `guest_count`, `budget`, `kosher_level`,
`order_number`, `property_type`, `desired_position`, plus `decision_maker`,
`objections[]`, `quote_sent_at`, `estimated_value`.

> This is where V1's "industry pack fields" actually live - **not** on the customer.

### 4.3 ConversationIntelligence - per-interaction (exists; small delta)

Keep the existing table (`summary`, `detectedIntent`, `sentiment`, `topics`,
`resolutionOutcome`, `customerEffort`, `aiConfidence`). **Add**:

| Field | Type | Notes |
|---|---|---|
| opportunityId? | FK | which deal this conversation advanced (nullable: pure support) |
| contributedFactIds | Json | provenance: facts this conversation produced |

Conversation Intelligence stays **about the interaction**. Durable/deal facts it
discovers are written as `IntelligenceFact` rows into the customer/opportunity scope
- never owned here.

### 4.4 FieldDefinition + Pack - scope-aware schema registry

Formalizes today's `PostConversationConfig.summaryFields` with two critical
additions: **scope** and **lifecycle flags**.

| Field | Type | Notes |
|---|---|---|
| key | string | stable snake_case |
| label, description | string | |
| type | enum | text · number · boolean · enum · date · entity_ref |
| options | string[]? | for enum |
| **scope** | enum | **customer · opportunity · conversation** (the new core attribute) |
| required | bool | for the Missing-Info engine |
| stageRelevance | string[]? | stages where this field is expected |
| aiExtract | bool | include in extractor allow-list |
| syncToCrm | bool | eligible for CRM field mapping |
| crmFieldMap | Json? | per-vendor target column |
| origin | enum | pack · custom · discovered |

`Pack` = a named, versioned bundle of `FieldDefinition`s (system or tenant-cloned),
exactly as in the Phase-1 spec - but field defs now carry scope.

---

## 5. The Fact merge policy (the anti-overwrite contract, made concrete)

When a new `IntelligenceFact` lands, the entity snapshot updates by these rules
(folding the log):

1. **Scope gate** - a fact may only target a field whose `FieldDefinition.scope`
   matches the fact's `entityType`. A conversation extractor producing a
   `customer`-scope field writes it to the **customer** entity, not the conversation.
2. **Manual supremacy** - if the current snapshot value has `source=manual`, an LLM
   source never overwrites it (records a conflict instead).
3. **Confidence + recency** - within the same source class, higher confidence wins;
   ties broken by `observedAt`.
4. **Absence ≠ deletion** - a missing/omitted field in an extraction produces **no
   fact**, so it can never null an existing value.
5. **Conflict capture** - cross-source disagreement (CRM 100k vs chat 120k) is
   stored as an unresolved conflict surfaced in the UI, never silently merged.
6. **Temporal validity** - facts past `validUntil` (e.g. an event date in the past)
   drop out of the active snapshot; the Opportunity may auto-archive.

This is the formal answer to *"one conversation overwrites valuable customer data."*

---

## 6. Relationships (the implicit graph)

Stored only when an edge **crosses entities**; within-entity facts stay as facts.

| Edge | From → To | Where stored |
|---|---|---|
| `has_opportunity` | Customer → Opportunity | FK |
| `sourced_from` | Opportunity/fact → Conversation | `IntelligenceFact.conversationId` |
| `decision_maker` | Opportunity → Person | `Opportunity.relationships` |
| `proposed_entity` | Opportunity → Entity(Venue/Product) | `Opportunity.relationships` |
| `about_entity` | Opportunity → Entity | `Opportunity.relationships` |

`Entity` (Venue, Product, Property) is a **light, optional** node - created only when
a thing is referenced across records and worth naming. Most "entities" remain plain
typed fields. The graph the AI consumes is **walked and rendered at prompt-time** -
no separate graph store (honors no-new-dep). Defer named-entity nodes until a
concrete query needs them.

---

## 7. Projection layer (generated read models)

None of these is a source of truth - all are folds of §3–§6.

| Projection | Shape | Built from | Consumers |
|---|---|---|---|
| **Snapshot** | structured card JSON | CustomerProfile + active Opportunity + gaps + last Conversation | inbox, contact, CRM panel |
| **CustomerBrief** | behavioral prose (per-locale) | CustomerProfile.behavioralSignals + recent activity | bot/copilot context (keeps current role) |
| **ExecutiveSummary** | living narrative | Opportunity + timeline events | Snapshot header |
| **Timeline** | event stream | IntelligenceFact log + messages + tasks | Snapshot "recent", analytics |

`CustomerBrief` thus keeps doing exactly what it does today - it simply stops
pretending to be the canonical structured store.

---

## 8. Lifecycle & state machines

### Opportunity
```
        (inbound matches type / explicit create)
                    │
                    ▼
   open ──advance(stage)──► open ──won/lost──► closed ──(validUntil passed)──► archived
     │                                  ▲
     └────────── stalled (gap/age) ─────┘   (triggers Missing-Info automation)
```

### Fact validity
`active → superseded` (new higher-confidence fact) or `active → expired`
(`validUntil`). Never `deleted`.

### Conversation
Unchanged: `open → closed`, intelligence frozen at close; contributes facts during
and at close.

---

## 9. Multi-opportunity resolution

On inbound, after identity resolution:

```
candidates = open Opportunities for this CustomerProfile
if an open opportunity of the inbound's inferred type exists → ATTACH
elif inbound clearly implies a new deal (new type / explicit) → PROPOSE create
else → leave unattached (pure support); facts go to customer scope only
```

Auto-create is conservative (mirrors the bot's "clarify before acting" rule). A
human/AI can split or merge opportunities; facts re-parent with provenance intact.

---

## 10. CRM mapping (entity → CRM object)

| GOTCHA entity | CRM object | Fallback |
|---|---|---|
| CustomerProfile | Contact / Lead | - |
| Opportunity | **Deal / Opportunity** object | contact custom-fields if vendor has no deal object (Shopify, Airtable) → else synthetic |
| Conversation | Activity / Note | - (this is the log entry we already write) |
| Fact (`syncToCrm`) | mapped column on the owning object's CRM target | activity note (last resort) |

This finally routes deal data to the **deal**, customer data to the **contact** -
the correction from V1 (which dumped everything on the contact). CRM stays a **sync
target**; conflicts resolve in GOTCHA's favor (it holds the live truth).

---

## 11. Mapping to the existing codebase

| Concept | Existing | Action |
|---|---|---|
| identity spine | `CustomerBrief` (identityKey/personId/crmContactId) | extract into `CustomerProfile`; brief becomes projection |
| per-conversation | `ConversationIntelligence` | keep + add `opportunityId`, `contributedFactIds` |
| field schema | `PostConversationConfig.summaryFields` | evolve into `FieldDefinition` (+scope/flags) + `Pack` |
| stages | `TenantFunnel` / `FunnelStage` (exit criteria) | `Opportunity.stage` references it; Missing-Info reads `mustHaveFields` |
| live extraction | `LiveAnalysisRunner` (`missing_fields.updated`) | emits facts into the log; generalize beyond voice |
| close extraction | `summarizePostConversation` (`crm_patch`, `allowedFields`) | becomes a fact producer (scope-routed) |
| CRM writes | `applyCrmPatchKindAware`, `appendInteraction` | becomes the §10 mapping layer |
| discovery seed | `bonus_highlights` labels | one source of Discovery V2 candidates |
| behavioral signals | BEL trust/friction/relationship | `CustomerProfile.behavioralSignals` |

Nothing here requires a new service - all of it lives in `services/ai`
(intelligence) + the existing schema package, per `CLAUDE.md`.

---

## 12. Query & analytics patterns (why the model is shaped this way)

- **Snapshot read** → one row per entity (denormalized `facts` JSON). O(1)-ish.
- **"How did we learn budget?"** → `IntelligenceFact` by `(entityId, fieldKey)`
  ordered by `observedAt`.
- **Deal velocity / win rate / value forecast** → `Opportunity` rows by `stage`,
  `status`, `openedAt/closedAt`, `estimatedValue` - proper typed columns, not blobs.
- **Gap-completion rate** → expected vs present facts per Opportunity over time.
- **Which missing field predicts loss** → join lost Opportunities to their gap
  history. This is only possible because facts are logged, not overwritten.

---

## 13. Open decisions (need sign-off before schema work)

1. **Snapshot materialization** - recompute the entity `facts` snapshot on every
   fact (simple) vs incremental update (faster, more code). Recommend: incremental
   with a periodic full-fold safety net.
2. **Entity nodes** - ship `Opportunity.relationships` JSON only at first; defer a
   first-class `Entity` table until a query needs cross-opportunity entity joins.
3. **Opportunity ↔ CRM deal** for deal-less vendors (Shopify/Airtable) - synthetic
   deal vs contact-field projection (recommend the latter initially).
4. **CustomerProfile vs CustomerBrief coexistence** - introduce `CustomerProfile`
   alongside and let `CustomerBrief` read from it, or migrate the brief generator to
   read the new model directly. Recommend coexist-then-cut-over.
5. **Fact retention** - append-only log growth: keep full history vs compact
   superseded facts older than N months into a summary. Recommend keep, revisit at
   scale.
6. **Default scope for ambiguous fields** - when a discovered field's scope is
   unclear (e.g. "address"), default to `customer` or force human choice at approve.
   Recommend force-choice at approval.

---

## 14. What this model guarantees

- A conversation can **never** overwrite durable customer or deal data (scope gate +
  append-only log + absence≠deletion + manual supremacy).
- A customer can hold **many** deals, concurrent or sequential, without collision.
- Every value is **explainable** (provenance) and **reversible** (fact history).
- The Snapshot reads in **one query**; analytics reads **typed deal data**.
- The CRM becomes a **downstream replica**, not the source of truth.
- Nothing violates `CLAUDE.md` (no new service, no new deps, LLM-only-in-`services/ai`,
  services own state).
