# ADR 0001 - Customer Intelligence V2, Phase 1 Foundation

- **Status:** Accepted
- **Date:** 2026-06-13
- **Branch:** `feat/customer-intelligence-phase1`
- **Context docs:** `docs/customer-intelligence-v2.md` (architecture review),
  `docs/customer-intelligence-domain-model.md` (domain model),
  `docs/customer-intelligence-summaryfields-migration.md` (the bridge plan, ADR §4)
- **Supersedes:** the V1 single-object proposal in
  `docs/customer-intelligence-architecture.md` /
  `docs/customer-intelligence-phase1-spec.md`

---

## Summary

Phase 1 lays the **storage + schema foundation** for the V2 Customer
Intelligence model: a scope-aware field registry (`FieldDefinition`), three
intelligence domain records (`CustomerProfile`, `Opportunity`,
`ConversationIntelligence`), an append-only provenance log
(`IntelligenceFact`), and an Industry Pack catalog (`IntelligencePack`). It
ships the registry CRUD, pack apply, onboarding pack detection, and a Fields
Builder UI. It deliberately does **not** rewire any runtime extraction yet.

This ADR records the four decisions that most shape the codebase, because each
is a reversal of an "obvious" simpler choice and each has downstream cost if
misunderstood.

---

## Decision 1 - `FieldDefinition` is the canonical field registry (not `summaryFields`)

### Context

The system already had a tenant-level list of extra fields the post-conversation
summarizer should populate: `PostConversationConfig.summaryFields` - a JSON
array of `{ key, label, type, options }` on a single per-tenant config row. The
cheapest path for "industry packs + a fields builder" would have been to keep
piling onto that array.

### Decision

Introduce a first-class `FieldDefinition` table as the **single source of truth**
for what intelligence a tenant tracks. Packs clone into it; the Fields Builder
is CRUD over it.

### Why

- **Scope is a first-class attribute.** Every field declares
  `scope ∈ {customer, opportunity, conversation}` (Decision 2). A flat
  `summaryFields` array has no place to put this without overloading the shape,
  and scope is the *core anti-overwrite mechanic* - it cannot be a bolt-on.
- **Queryability.** `summaryFields` is a JSON blob on one row. Analytics,
  the Missing-Info engine, and CRM field-mapping all need to query fields by
  scope / origin / required-ness / stage-relevance. That is a table with
  indexes (`@@index([tenantId, scope])`), not a blob.
- **Provenance & origin.** A field needs to know whether it came from a pack,
  a human, or discovery (`origin ∈ {pack, custom, discovered}`) so that
  re-applying a pack can refresh pack fields **without clobbering** tenant
  custom fields. A blob can't express row-level origin cleanly.
- **Lifecycle flags per field** (`aiExtract`, `syncToCrm`, `required`,
  `stageRelevance`, `crmFieldMap`) are what later phases (extraction gating,
  CRM routing, gap detection) read. Modeling them as columns keeps those
  consumers simple.

### Consequences

- Two field stores exist **during the transition** (`summaryFields` and
  `FieldDefinition`). This is a deliberate, time-boxed overlap - see Decision 3
  and the migration doc. The risk (two competing sources of truth) is real and
  is the single most important thing Phase 2 must close.

---

## Decision 2 - Separate Customer / Opportunity / Conversation records

### Context

V1 modeled one Customer Intelligence Object and hung every extracted fact on it
(backed by `CustomerBrief`). The brief's stated fear was *"one conversation
overwrites valuable customer data."*

### Decision

Three records with different lifecycles and cardinalities:

| Record | Scope | Cardinality | Lifecycle |
|---|---|---|---|
| `CustomerProfile` | the person/identity | 1 per identity | durable, ~never expires |
| `Opportunity` | a deal / active need | **N per customer** | opens → progresses → closes |
| `ConversationIntelligence` | one interaction | 1 per conversation | frozen at close |

### Why

- **Multi-deal reality.** A repeat customer (a wedding in 2027, a bar-mitzvah in
  2029) cannot have two `guest_count`s on one record. Concurrent B2B deals
  can't coexist on one object. Only a separate `Opportunity` record (N per
  customer) expresses this.
- **Correct ownership of "pack fields."** Almost every industry-pack field
  (`event_date`, `guest_count`, `budget`, `order_number`, `property_type`) is
  **deal data**, not person data. Filing it on the customer is exactly what
  produces the overwrite bug: the next chat with a blank value nulls the real
  one. Reclassifying these to `Opportunity` (and making conversations *sources*,
  not *owners*, of durable facts) makes overwrite **structurally** unlikely.
- **Analytics & CRM routing.** Deal velocity, win rate, and value forecasting
  need typed `Opportunity` rows. CRM sync needs to route deal data → the CRM
  Deal object and customer data → the Contact. Neither is possible with one
  blended object.
- **Provenance, not hope.** `IntelligenceFact` (append-only) is the source of
  truth for *how* a value was learned; the entity `facts` JSON is a denormalized
  read snapshot folded from the log under the merge policy (manual-wins,
  confidence+recency, absence≠deletion). "No fact is ever deleted - superseded."

### Consequences

- More records and a fact log to maintain. Accepted: the guarantees
  (no accidental overwrite, many deals per customer, full explainability) are
  non-optional for the product thesis. `CustomerBrief` is demoted to a
  **projection** (behavioral prose), not the canonical store.

---

## Decision 3 - `summaryFields` and the close-summarizer stay untouched in Phase 1

### Context

The post-conversation summarizer reads `summaryFields` via
`getSummarizerAllowedFields` and writes a sparse `crm_patch`. It is live,
load-bearing, and governed by hard-won invariants (sparse-patch, manual-wins).

### Decision

Phase 1 is **define + store + CRUD only**. It does **not** change the
summarizer, the live extractor, `getSummarizerAllowedFields`, or
`PostConversationConfig`. The new registry is populated and surfaced in the UI
but is **not yet read at runtime** by any extractor.

### Why

- **No regression on a load-bearing path.** Rewiring extraction to a new schema
  in the same change that introduces the schema couples two risky things. A
  tenant who never touches packs must behave exactly as today.
- **Ship the foundation, learn, then bridge.** The registry can be validated
  (CRUD, packs, onboarding, UI) against the real DB without putting live
  summarization at risk. The bridge is a separate, reviewable step.
- **The invariants live in the old path.** Sparse-patch and manual-wins are
  currently enforced in the summarizer + CRM-write layer. Phase 2 must
  re-home those invariants onto the fact merge policy *before* cutting over -
  not as a side effect of Phase 1.

### Consequences

- A real but bounded **dual-source-of-truth window**. Mitigations: (a) this ADR
  + the migration doc make the overlap explicit and time-boxed; (b) a code
  `TODO(ci-phase2)` anchored at `getSummarizerAllowedFields`; (c) Phase 1 packs
  write only to `FieldDefinition`, so the two stores don't fight over the same
  writes yet.

---

## Decision 4 - How Phase 2 bridges the old and new worlds

Full plan: `docs/customer-intelligence-summaryfields-migration.md`. The shape:

1. **Backfill.** One-time: project existing `summaryFields` into
   `FieldDefinition` rows (`origin=custom`, `scope=opportunity` default, flags
   from existing semantics). Idempotent, keyed by `(tenantId, key)`.
2. **Read cutover (single source).** `getSummarizerAllowedFields` (and the live
   extractor's allow-list) read from `FieldDefinition` where `aiExtract=true`,
   **scoped** - customer-scope fields route to the customer entity, opportunity
   to the open opportunity, conversation to the conversation. `summaryFields`
   becomes a read-through shim, then is retired.
3. **Write cutover (scoped facts).** The close summarizer and live extractor
   stop writing a flat `crm_patch` and instead emit `IntelligenceFact` rows
   routed by `FieldDefinition.scope`; the merge policy (manual-wins,
   confidence+recency, absence≠deletion, conflict capture) folds them into the
   entity `facts` snapshot. The existing sparse-patch + manual-wins invariants
   are **preserved by being re-expressed as the merge policy**, not dropped.
4. **CRM routing.** `syncToCrm` + `crmFieldMap` drive the existing
   `applyCrmPatchKindAware` layer, now routing opportunity facts → CRM Deal and
   customer facts → Contact.
5. **Retire `summaryFields`.** Once reads + writes are on `FieldDefinition` and
   verified at parity, delete the `summaryFields` UI/path; keep the column for
   one release as a read-only fallback, then drop.

**Cutover guard:** a parity check (same input → same `crm_patch`/facts under
both paths) gates each tenant's switch. No big-bang.

---

## Alternatives considered (and rejected)

- **Extend `summaryFields` only (no new tables).** Cheapest, but cannot express
  scope, multi-opportunity, provenance, or typed analytics - i.e. it can't hold
  the V2 thesis. Rejected.
- **Make `CustomerBrief` the canonical typed store (V1).** Locale-scoped unique
  key, prose-shaped, single-row-per-identity (no multi-deal), regenerated by the
  LLM on every refresh. Wrong grain and unsafe as an authoritative store.
  Rejected; demoted to a projection.
- **A graph database (Neo4j) for relationships.** Violates no-new-service /
  no-new-dep; sync burden for little gain at this scale. The three records +
  `Opportunity.relationships` JSON already *are* a graph, walked at prompt-time.
  Rejected.
- **Rewire extraction in Phase 1.** Couples schema introduction with runtime
  cutover on a load-bearing path. Rejected in favor of the staged bridge.

---

## Guardrails honored (CLAUDE.md)

No new microservice; all logic in `services/ai`. No new dependencies (graph
stays relational). No new LLM call sites (onboarding classifier contract is an
extension of an existing grandfathered call). UI + backend both shipped.
Sparse-patch + manual-wins remain invariants - Phase 1 by leaving the old path
untouched, Phase 2 by re-expressing them as the fact merge policy.
