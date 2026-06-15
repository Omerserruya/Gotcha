# GOTCHA Customer Intelligence - V2 Architecture Review

> **Status:** Architecture review / domain design. **No code, no migrations, no
> implementation.** Supersedes the single-object model in
> `customer-intelligence-architecture.md` (V1).
> **Author:** generated 2026-06-12 against the live codebase.
> **Mandate:** challenge assumptions aggressively - including V1's and the brief's.

---

## 0. The one-sentence correction

V1's central mistake: it modeled **one** Customer Intelligence Object and tried to
hang every extracted fact on it (backed by `CustomerBrief`). That collapses three
fundamentally different things - *who the customer is*, *what happened in a
conversation*, and *what deal is in flight* - into a single bag, where the newest
conversation silently overwrites durable truth and a customer can only ever have

**V2 thesis:** Customer Intelligence is not an object. It is a **layered domain**
of three records with different lifecycles, owners, and cardinalities, stitched by
an implicit graph, projected into one human surface (the Snapshot). The CRM is a
**downstream sync target**, never the source.

---

## 1. Three intelligence domains (the spine of V2)

| | **Customer Intelligence** | **Opportunity Intelligence** | **Conversation Intelligence** |
|---|---|---|---|
| **Scope** | the person/identity | a deal / active need | one interaction |
| **Cardinality** | 1 per identity | **N per customer** (sequential + concurrent) | 1 per conversation |
| **Lifecycle** | durable, slow-changing, ~never expires | opens → progresses → closes (won/lost) | ephemeral, frozen at close |
| **Owner** | the customer record | the opportunity record | the conversation record |
| **Examples** | language, preferred contact time, comms style, VIP tier, behavioral signals, timezone, role/title | pipeline stage, quote sent, estimated value, decision maker, objections, **event_date, guest_count, budget, requested product** | intent, sentiment, the issue raised, resolution outcome, effort, the question asked |
| **Today in code** | partial: `CustomerBrief` (prose), `Contact.metadata` | **missing** (only CRM-side deals + `TenantFunnel` stage) | ✅ `ConversationIntelligence` table |

### 1.1 I am challenging your own example

You filed **event_date / guest_count / budget** under *Conversation* Intelligence.
**I disagree.** A guest count is not a property of a chat - it's a property of the
**wedding** (the opportunity). The conversation is merely where it was *discovered*.
Put it on the conversation and you get exactly the bug you fear: the next chat (a
follow-up where she doesn't restate the number) has a "blank" guest_count and
overwrites the real one.

**Rule:** *Conversation Intelligence describes the interaction. Opportunity
Intelligence describes the deal. Customer Intelligence describes the person.*
Conversations are **sources**, not **owners**, of durable facts.

### 1.2 Why "Opportunity" is the missing primitive

Almost every "industry pack field" in V1 (event details, property details, order
details, role sought) is really **deal data**, not customer data. Without an
Opportunity record:

- A repeat customer (wedding in 2027, bar-mitzvah in 2029) has colliding
  `guest_count`s on one object.
- Concurrent needs (a B2B buyer evaluating two products) can't coexist.
- "Quote sent / next action / estimated value" have nowhere correct to live.
- Analytics can't compute deal velocity, win rate, or value - there's no deal.

This is the single biggest structural gap in V1. **Opportunity Intelligence is the
keystone V2 adds.**

---

## 2. Ownership boundaries & the anti-overwrite contract

The brief's real fear - *"one conversation overwrites valuable customer data"* - is
solved by three mechanics, not by where data is stored alone.

### 2.1 Scope ownership (which record may hold a fact)

Each declared field has an **owning scope**: `customer | opportunity | conversation`.
The extractor may only write a fact into its declared scope. Pack/field definitions
carry this (e.g. `guest_count → opportunity`, `language → customer`,
`sentiment → conversation`). A conversation extractor **cannot** write a customer
field directly - it *proposes* a customer-scope change that the customer record
merges under its own rules.

### 2.2 Provenance + confidence (who said it, how sure, when)

Every value is `{ value, confidence, source, observedAt, conversationId? }`.
`source ∈ { manual, crm_inbound, llm_close, llm_live, rule, derived }`. Merge policy:

- **manual always wins** and is never overwritten by any LLM source.
- Higher-confidence + newer beats lower/older **within the same source class**.
- **Absence is not a value.** A null/omitted extraction never clears an existing
  fact (this is the V1 sparse-patch rule, elevated to a global invariant).
- Cross-source conflicts (CRM says budget=100k, chat says 120k) are recorded as a
  **conflict**, surfaced for human resolution, not silently overwritten.

### 2.3 Temporal validity (facts decay)

Customer facts are durable; opportunity facts are valid until the deal closes;
conversation facts are frozen. Some facts carry a `validUntil` (e.g. "event_date in
the past → opportunity auto-archives"). This prevents stale deal data from polluting
the Snapshot forever.

> Together these make overwrites **structurally impossible by accident** - a far
> stronger guarantee than V1's "store it on CustomerBrief and hope."

---

## 3. Knowledge Graph layer - yes, but *implicit and generated*

**Is it valuable?** Yes - for multi-entity questions the AI must answer:
"what venue did we propose for *her* wedding?", "which order is the refund about?".
Flat fields can't express *Venue -proposed_for→ Wedding*.

**Explicit or implicit? Stored or generated?** **Implicit + relational, generated
on demand - NOT a graph database.** A separate graph store (Neo4j) violates the
no-new-service / no-new-dep constraints and adds sync burden for little gain at this
scale.

The three-domain model **already is a graph**:

```
Customer ──has──► Opportunity ──about──► Entity(Wedding)
   │                  │                      ├─ scheduled_for 2027-09-15
   │                  ├─proposed──► Entity(Venue)
   │                  └─sourced_from──► Conversation
   └──speaks──► language(he)
```

- **Nodes** = the domain records (Customer, Opportunity, Conversation) + a light
  `Entity` notion for cross-record things worth naming (a Venue, a Product, a
  Property). Most "entities" are just typed fields and need no node.
- **Edges** = foreign keys + a small set of **first-class typed relationships**
  stored only when they cross records (`opportunity.proposed_entity`,
  `opportunity.decision_maker → Person`). Within-record facts stay as fields.
- The "graph" the AI consumes is **generated** by walking these relations into a
  compact context block at prompt-time - never maintained as a duplicate store.

**Benefits per consumer:** AI Employee answers relational questions with no
hallucination; Copilot references the right opportunity; Analytics joins
deal→entity→outcome; CRM Sync maps opportunity→deal cleanly. **Recommendation:**
build the relational backbone now (records + a `relationships` JSON on Opportunity);
defer any named-entity graph until a concrete query needs it. Don't gold-plate.

---

## 4. Re-evaluating CustomerBrief as canonical store (challenge accepted)

**Verdict: reject V1. Do NOT make `CustomerBrief` the canonical CIO.** Introduce
proper domain models; demote `CustomerBrief` to a **projection/cache**.

### Why CustomerBrief fails as canonical

| Concern | Detail |
|---|---|
| **Locale-scoped key** | unique on `(tenantId, identityKey, locale)` - structured facts would duplicate/diverge per language. Wrong grain for language-neutral data. |
| **Prose-shaped** | it's a behavioral *brief* (tone/mood/recommendedBehaviors) - a narrative artifact, not a typed fact store. Overloading it muddies two concerns. |
| **No multi-opportunity** | one row per identity ⇒ cannot hold two concurrent deals. Fatal for the whole opportunity concept. |
| **Analytics** | reporting wants typed, queryable deal rows (value, stage, age), not JSON blobs on a per-locale brief. |
| **Regeneration churn** | the brief is rewritten by the LLM on every refresh - unsafe to also treat as the authoritative typed store the merge policy depends on. |

### What CustomerBrief *should* be

The **human projection layer**: `brief` (behavioral prose) and the per-locale
narrative stay exactly as-is, but they are **generated from** the canonical
Customer/Opportunity/Conversation records - one of several read projections
(alongside the Snapshot and the executive summary). It keeps its job; it loses the
"source of truth" title.

### The canonical model (conceptual - not a migration)

- **CustomerProfile** - durable, language-neutral customer facts + behavioral
  signals. (Could evolve out of `CustomerBrief`'s identity spine, but a distinct
  structured record.)
- **Opportunity** - per-deal intelligence: type/pack, structured fields, stage,
  value, decision maker, objections, status, `relationships`. **New primitive.**
- **ConversationIntelligence** - keep as-is (per-conversation).
- **CustomerBrief** → **projection** of the above.
- **FieldDefinition / Pack** - the schema registry (scope-aware: each field
  declares customer|opportunity|conversation).

> This is the deliberate reversal of V1's headline recommendation. The multi-deal
> reality and analytics requirements make a dedicated model non-optional.

---

## 5. Missing Information Engine (the differentiator)

Extraction asks *"what did they tell us?"* The Missing Info Engine asks *"what
SHOULD we know by now, and don't?"* - turning GOTCHA from a recorder into an
**active profile-completer**. (Foundation exists: `LiveAnalysisRunner` already emits
`missing_fields.updated` for voice - V2 generalizes it across the opportunity
lifecycle.)

### 5.1 Gap = Expected − Known, weighted by stage

```
expected(opportunity) = pack.fields ∪ stage.requiredFields ∪ learned.fields
known(opportunity)    = fields with confidence ≥ τ
gaps                  = expected − known
```

Each gap is scored:

```
gap.importance = f( required?, stage_relevance, deal_value, recency_of_need )
```

A field is "missing" only when it's **expected at the current stage** - don't nag
for a venue date during a cold inquiry. This is stage-aware, reusing the existing
`FunnelStage` exit-criteria (`mustHaveFields`) the summarizer already reads.

### 5.2 Confidence model

Three states per field, not binary: **known** (conf ≥ τ_high), **uncertain**
(τ_low ≤ conf < τ_high - show but flag, ask to confirm), **missing** (no value or
conf < τ_low). Uncertain values are the ones Copilot asks the agent to verify.

### 5.3 Real-time updates

Fields fill live during the conversation (P2 live extractor) → gap set shrinks in
real time → the Snapshot's "Missing" section and the gap-driven prompts update
without waiting for close. Event: `intelligence.gaps.changed`.

### 5.4 Consumer integrations (this is where it pays off)

- **Copilot:** "You don't have the **guest count** yet - ask now." Renders the
  missing-field as a one-tap prompt insert. Turns the Missing engine into agent
  coaching.
- **AI Employee:** proactively *drives* the conversation to fill required gaps
  before advancing the stage ("Before I send pricing - roughly how many guests?").
  The bot already has stage goals; gaps become its sub-objectives.
- **Automation:** gap-based triggers - `budget missing > 7 days in "awaiting_quote"
  → task to sales`; `decision_maker unknown at "negotiation" → escalate`.
- **Snapshot:** the "What's missing / what must happen next" section is literally
  the ranked gap list.

> This is the feature competitors don't have: the system that **knows what it
> doesn't know** and works to close it.

---

## 6. Discovery Engine V2 - multi-source field learning

V1 learned only from conversation `bonus_highlights`. That's the weakest signal.
V2 mines **five** sources into one candidate pipeline; CRM schema is the strongest
and cheapest.

| Source | Signal | Why it matters |
|---|---|---|
| **CRM schema / custom fields** | the tenant already created "Kosher Level" in Fireberry/HubSpot | strongest signal - a human deliberately modeled it. Read via existing adapter capabilities (we already enumerate vendor fields). |
| **Frequently-updated CRM fields** | which custom fields humans actually edit | separates live fields from dead ones |
| **Conversation bonus_highlights** | recurring snake_case labels across calls | emergent, bottom-up needs |
| **Website / KB content** | service pages, FAQs ("we offer Badatz certification") | domain vocabulary before any conversation |
| **AI Employee interactions** | what the bot repeatedly had to ask | reveals expected-but-unmodeled fields |

### 6.1 Unified candidate model

All sources emit `FieldCandidate { key, label, inferredType, scope, sources[], freq,
sampleValues }`. Score:

```
candidate.score = Σ(source_weight × frequency) × business_fit(industry)
```

CRM-schema candidates start near "auto-approve" (a human already validated them by
creating the field); conversation candidates need volume; website candidates seed
labels but need a second source to confirm.

### 6.2 Output

Suggestions in the Fields Builder, **scope-tagged** (so "Kosher Level" lands as an
*opportunity* field, "preferred language" as a *customer* field):

```
Suggested field · Kosher Level (opportunity)
  seen in: Fireberry schema + 43 conversations
  type: enum [Regular, Mehadrin, Badatz]      [Approve]  [Edit]  [Dismiss]
```

### 6.3 Bi-directional CRM learning

Because CRM schema is a source, GOTCHA **inherits the tenant's existing field model
on day one** instead of rediscovering it - and then enriches it. This makes
onboarding feel instant for tenants with a mature CRM.

---

## 7. Customer Snapshot - the primary surface

The Snapshot replaces "open conversation → read history" as the default view. It is
a **projection of the three domains + the gap engine**, ranked by what an agent
needs in 3 seconds.

### 7.1 Priority order (top = first glance)

```
1. WHO          identity + VIP + language + sentiment           (Customer)
2. WHAT         active opportunity: "Wedding · 350 · 15/09/27"  (Opportunity)
   + status     "Awaiting Quote"
3. NOW          last interaction, live state, urgency           (Conversation)
4. MISSING      ranked gaps: "Budget? Kosher level?"            (Missing engine)
5. NEXT         the single next action                          (Opportunity.next_step)
6. NARRATIVE    executive summary (living prose)                (projection)
```

### 7.2 Layout

```
┌─────────────────────────────────────────────────────────┐
│ ⭐ Dana Levi · VIP · 🇮🇱 he · 🙂 positive                 │  WHO
├─────────────────────────────────────────────────────────┤
│ 🎉 Wedding  ·  👥 350  ·  📅 15/09/2027  ·  💰 120,000₪   │  WHAT
│ Status: Awaiting Quote        Urgency: ●●○ normal        │
├─────────────────────────────────────────────────────────┤
│ NOW   last: WhatsApp 2h ago · requested vegan menu        │  NOW
├─────────────────────────────────────────────────────────┤
│ MISSING  ⚠ Budget confirmed? · ⚠ Kosher level · parking? │  MISSING
├─────────────────────────────────────────────────────────┤
│ NEXT  ▶ Send pricing proposal           [Do it] [Snooze] │  NEXT
├─────────────────────────────────────────────────────────┤
│ "Wedding lead, 350 guests, Sept 15. Requested vegan…"    │  NARRATIVE
└─────────────────────────────────────────────────────────┘
```

### 7.3 Multi-opportunity

When a customer has >1 open opportunity, the WHAT/MISSING/NEXT block is **per
opportunity** (tabs or stacked cards); WHO + behavioral signals stay shared. This is
only expressible *because* opportunities are separate records (§1).

### 7.4 Mobile

Collapse to the priority stack: WHO + WHAT + NEXT visible without scroll; NOW /
MISSING / NARRATIVE one tap down. The "Do it" on NEXT is the primary thumb action.

### 7.5 Inbox

The Snapshot renders as the conversation **header** (collapsed: WHO + WHAT + NEXT)
and expands to the full card. Same component, same data, everywhere - inbox, contact
profile, CRM panel.

---

## 8. Intelligence across surfaces (under the V2 model)

| Surface | Reads | Behavior change vs V1 |
|---|---|---|
| **Inbox** | Snapshot projection | shows per-opportunity, not one blob |
| **Copilot** | customer + active opportunity + gaps | grounded in the *right* deal; suggests gap-filling questions |
| **AI Employee** | full 3-domain context as prompt | continues with deal memory; drives gap closure as sub-goals |
| **CRM Sync** | opportunity → deal, customer → contact | **deal data syncs to the CRM deal**, customer data to the contact - correct objects, not all notes on the contact |
| **Analytics** | typed opportunity rows + timeline | deal velocity, win rate, value, gap-completion rate - impossible with V1's blob |
| **Automation** | field/stage/gap events | gap-based + value-based triggers |
| **Knowledge Mgmt** | KB ↔ Discovery | KB content seeds field discovery; gaps reveal missing KB |

**CRM Sync correction:** V1 pushed everything to the contact. V2 routes **Opportunity
Intelligence → the CRM's Deal/Opportunity object** and **Customer Intelligence → the
Contact/Lead**, with the activity note as last-resort fallback only. This is what
"CRM as sync target, not source" actually requires.

---

## 9. Future state - GOTCHA in 3 years

If executed correctly, the conversation becomes invisible infrastructure; the
**intelligence** is the product.

- **Inbox** → an *operations console*. Agents work a ranked queue of
  *opportunities-needing-action*, not a list of unread chats. You open a customer
  and act in 3 seconds; reading transcripts is a rare drill-down.
- **Copilot** → a *deal co-pilot*. It knows the customer, the open deal, the gaps,
  and the next best action - and drafts it. It asks the right question because it
  knows which fact is missing.
- **AI Employee** → an *autonomous account manager*. It maintains the intelligence
  profile across channels, proactively fills gaps, advances deals through stages,
  and escalates with full context. It never re-asks what's already known.
- **CRM Sync** → the CRM is a *replica*. GOTCHA holds the live truth; the CRM is one
  of several sync targets (with analytics warehouses, billing, etc.). Tenants could
  drop their CRM and lose nothing operational.
- **Analytics** → *intelligence analytics*: win rates by objection type, gap-to-close
  correlation, which missing field most predicts loss, value forecasting from typed
  opportunity data.
- **Automation** → *intelligence-driven*: triggers fire on facts, gaps, stages, and
  value - not on message keywords. "High-value wedding stalled 7 days with budget
  unconfirmed → escalate to senior sales."
- **Knowledge Management** → a *living domain model per tenant*: packs + discovered
  fields + the implicit graph become the business's operational ontology. New hires
  (human or AI) inherit it instantly.

**The test:** a new agent opens any customer and operates as if they'd handled the
account for a year - because the system *is* the institutional memory.

---

## 10. What V2 reverses, and open questions

### Explicit reversals from V1
1. **One CIO → three domains** (Customer / Opportunity / Conversation).
2. **CustomerBrief canonical → CustomerBrief is a projection**; introduce
   `CustomerProfile` + `Opportunity` records.
3. **All facts on the contact → scope-correct routing**, incl. CRM deal object.
4. **Extraction-only → extraction + Missing Information Engine.**
5. **Conversation-only discovery → multi-source discovery (CRM schema first).**
6. **event_date/guest_count/budget reclassified** Conversation → **Opportunity**.

### Open questions for product sign-off
1. **Opportunity auto-creation policy** - when does an inbound spin up a new
   opportunity vs attach to an open one? (heuristic: open opportunity of matching
   type exists → attach; else propose-create.)
2. **Opportunity ↔ CRM deal mapping** for vendors with no deal object (Shopify,
   Airtable) - fall back to contact fields? Synthetic deal?
3. **Confidence thresholds** (τ_high/τ_low) per field type - global vs per-pack.
4. **Graph depth** - how many first-class relationships before it's over-built?
   (recommend: start with `opportunity.relationships` JSON only.)
5. **Snapshot as default route** - does opening a conversation land on the Snapshot
   or the thread? (recommend: Snapshot header always; thread below.)
6. **Customer vs Opportunity field ambiguity** - a field like "preferred language"
   is clearly customer; "budget" clearly opportunity; some (e.g. "address") are
   ambiguous and need a default-scope rule in the field definition.

### Carried-forward guardrails (CLAUDE.md)
No new microservice; LLM-only-in-`services/ai`; no new deps (graph stays relational);
AI proposes, services own state; sparse-patch + manual-wins are global invariants.
