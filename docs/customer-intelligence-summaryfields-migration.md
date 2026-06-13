# Design Note / TODO — `summaryFields` → `FieldDefinition` Migration

> **Status:** Planned (Phase 2). **Owner:** Customer Intelligence.
> **Why this doc exists:** Phase 1 introduced `FieldDefinition` as the canonical
> field registry but **left `PostConversationConfig.summaryFields` and the live
> summarizer untouched** (see ADR 0001, Decision 3). That is a deliberate,
> time-boxed **dual-source-of-truth window**. This note is the explicit plan to
> close it so we do not drift into two competing schemas.

---

## The risk, stated plainly

Today, after Phase 1, two stores describe "fields a tenant tracks":

| | `PostConversationConfig.summaryFields` | `FieldDefinition` (new) |
|---|---|---|
| Shape | JSON array on one row | table, one row per field |
| Read by | the live close-summarizer (`getSummarizerAllowedFields`) | **nothing at runtime yet** — CRUD + UI only |
| Written by | Settings → Post-Conversation; legacy | Fields Builder; pack apply; onboarding |
| Scope-aware | no | yes (`customer/opportunity/conversation`) |

**They do not currently fight** — packs and the Fields Builder write only to
`FieldDefinition`, and the summarizer reads only `summaryFields`. The danger is
**time**: the longer both exist, the more likely a tenant configures fields in
one and expects them honored by the other. Phase 2 must make `FieldDefinition`
the *only* runtime source and retire `summaryFields`.

---

## Target end-state

- `FieldDefinition` is the **only** field registry, read by both the
  close-summarizer and the live extractor.
- Extraction is **scope-routed**: an extracted value is written as an
  `IntelligenceFact` into the entity its `FieldDefinition.scope` names
  (customer → `CustomerProfile`, opportunity → the open `Opportunity`,
  conversation → `ConversationIntelligence`), folded into the entity `facts`
  snapshot by the merge policy.
- `summaryFields` is gone (column kept read-only for one release, then dropped).
- The sparse-patch + manual-wins invariants are **preserved**, re-expressed as
  the fact merge policy (manual-wins, confidence+recency, absence≠deletion,
  conflict capture).

---

## Migration steps (ordered, each independently shippable)

### Step 0 — Parity harness (do this first)
Build a test that runs a fixed set of transcripts through **both** paths and
diffs the resulting `crm_patch` / facts. This is the gate for every later step;
no tenant cuts over until parity is green for them.

### Step 1 — Backfill `summaryFields` → `FieldDefinition`
One-time, idempotent, keyed by `(tenantId, key)`:
- For each `summaryFields[i]`: upsert a `FieldDefinition` with
  `origin=custom`, `scope=opportunity` (default — see "scope inference" below),
  `type` mapped from the legacy lowercase type, `aiExtract=true`,
  `syncToCrm=true`.
- Never clobber an existing `FieldDefinition` (a pack/custom field already owns
  the key) — backfill only fills gaps.
- Built-in summarizer keys (`status`, `stage`, `budget`, `timeline`,
  `decision_maker`, `company`, `role`) stay built-in; do **not** create
  `FieldDefinition` rows for them unless a tenant customized them.

### Step 2 — Read cutover
`getSummarizerAllowedFields(tenantId)` returns the union of built-ins +
`FieldDefinition` rows where `aiExtract=true`. Implement behind a per-tenant
flag; flip only when Step 0 parity is green. `summaryFields` becomes a
read-through shim (still honored if present, but `FieldDefinition` wins).

### Step 3 — Write cutover (scoped facts)
The close summarizer and `LiveAnalysisRunner` stop emitting a flat `crm_patch`
and instead emit `IntelligenceFact` rows:
- route each extracted `(key, value)` by `FieldDefinition.scope`;
- stamp `source` (`llm_close` / `llm_live`), `confidence`, `observedAt`,
  `conversationId`;
- the merge fold updates `CustomerProfile.facts` / `Opportunity.facts` /
  `ConversationIntelligence` under the merge policy.
The legacy `crm_patch` is produced as a **derived projection** of the
opportunity/customer facts during the transition, so downstream CRM writes keep
working unchanged.

### Step 4 — CRM routing on `syncToCrm` / `crmFieldMap`
`applyCrmPatchKindAware` consumes the scoped facts: opportunity facts → CRM Deal
object, customer facts → Contact, with the activity note as last-resort
fallback. Driven by `FieldDefinition.syncToCrm` + `crmFieldMap`.

### Step 5 — Retire `summaryFields`
Once Steps 2–4 are live and parity-verified for all tenants:
- remove the Settings → Post-Conversation "summary fields" editor (or redirect
  it to the Fields Builder);
- keep the `summaryFields` column as a read-only fallback for one release;
- then drop the column in a clean additive-reversal migration.

---

## Scope inference for backfill (the one judgement call)

Legacy `summaryFields` have no scope. Default rule:
- known deal-ish keys (`budget`, `timeline`, `*_date`, `*_count`, `order_*`,
  `event_*`, `property_*`) → `opportunity`;
- known person-ish keys (`language`, `timezone`, `role`, `vip*`,
  `preferred_*`) → `customer`;
- everything else → `opportunity` (the safe default — most custom fields are
  deal data) **and flag for human review** in the Fields Builder rather than
  silently guessing. Per the domain model's open decision, ambiguous scope is a
  force-choice-at-approval, not a silent default.

---

## Code anchors

- `services/ai/src/services/post-conversation-config.service.ts` —
  `getSummarizerAllowedFields` (carries a `TODO(ci-phase2)` pointing here). This
  is the read site to cut over in Step 2.
- `services/ai/src/services/intelligence-registry.service.ts` — the
  `FieldDefinition` registry (target store).
- `services/ai/src/services/intelligence/analyzers/missing-field-extractor.ts`
  + `LiveAnalysisRunner` — the live extractor to scope-route in Step 3.
- the close summarizer (`summarizePostConversation` / `crm_patch`) — Step 3/4.

---

## Definition of done

- `FieldDefinition` is the only runtime field source; `summaryFields` column
  dropped.
- Extraction writes scope-routed `IntelligenceFact` rows; entity `facts`
  snapshots are folds of the log.
- Parity harness green for all tenants across the cutover.
- Sparse-patch + manual-wins demonstrably preserved by the merge policy
  (a manual edit is never overwritten by an LLM source; an omitted field never
  nulls an existing value).
