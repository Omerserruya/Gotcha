# Kernel 10-Year Validation - AI Employee Vision

**Date:** 2026-07-03 · **Question:** can this kernel be the permanent foundation for 5–10 years - expansion only, no kernel evolution? · **Method:** adversarial proof against 9 real-world scenarios, judged strictly on *"is the architecture fundamentally capable"*, never on cleanliness. Every claim below is backed by code read first-hand, by an executed test, or by a live run - not by intention.

## 0. What "the kernel" is (the thing that must never change)

Nine components, ~1,600 lines total, each verified line-by-line in the 2026-07-03 audit:

| # | Component | Role | Domain refs (grep-verified) |
|---|---|---|---|
| K1 | `runAgentLoop` (agent-loop.ts) | the PERCEIVE→REASON→AUTHORIZE→EXECUTE→OBSERVE loop | 0 |
| K2 | `assembleOracleFacts` + `assembleFacts` | PERCEIVE (world composition, menu derivation) | 0 |
| K3 | `ReasonerProvider` contract + seam | REASON (vendor-swappable) | 0 |
| K4 | `authorizeOperation` (guardrails) | AUTHORIZE (deterministic, pure over Facts) | 0 |
| K5 | `resolveExecution` + contract types | EXECUTE (sole executor; invariants; approval; trace) | 0 |
| K6 | `projectObservation` | OBSERVE (neutral projection) | 0 |
| K7 | `writeReply` (Writer) | RESPOND (one voice, no tools) | 0 |
| K8 | Capability registry interface | the plug socket (describeWorld · ownsOperation · execute) | 0 |
| K9 | Shared kernel types (Facts, WorldView, WorkingMemory, AgentMemory, LoopPolicy) | the vocabulary | 0 |

Everything else - contracts, ports, connectors, the approval-gate mapping, employee binding, memory store, channel pipelines - lives **below or above** the kernel and is *expected* to grow.

---

## Scenario Verdicts

### S1 - Add a new Connector (Dynamics / Monday / Jira / Zendesk / Shopify / Stripe / Slack) → **PASS** (empirically proven ×4)

This is not a prediction; it has been *executed four times*: Commerce (a deliberately foreign domain, defined inline in a single test file, driven by the unchanged `runAgentLoop` - real mutation, invariant-blocked failure, Reasoner-decided escalation), then CRM, Knowledge, and Custom - each added as contracts + port + bindings + describeWorld + one `registerCapability` line, and each time the kernel blast-radius suite (57 tests over loop/runtime/registry) passed untouched. The registry line in `capability-plane/index.ts` is the designated composition root - registration data, not cognition.

**The one genuine landmine found (and it matters):** `executeOperation` dispatches **first-owner-wins** (`registeredCapabilities().find(...)` - registry.ts:89) and `deriveMenu` dedups by bare name. If Jira and Zendesk both expose `CREATE_TICKET` for one tenant, one silently vanishes from the menu and the other could receive the dispatch. **This does not require a kernel change** - the `CustomCapability` already proves the kernel handles namespaced operation names (`custom.<slug>`, `custom_db.<slug>`) end-to-end, including through the policy layer. The fix is a **binding convention**: every new connector's operations must be capability-qualified when a generic name could collide. This convention must be written down *now*; with it, S1 is unconditionally repeatable.

### S2 - Add a new Employee (SDR: book meetings; Calendar+CRM+Knowledge; no discounts/refunds; business hours) → **PASS** (with an honest account of policy strength)

The SDR exists today as one `AIAgent` row: role, goal ("book meetings"), salesContext, behavioral policies - the binding layer (`buildEmployeeBinding`) threads role+mission+guidance+persona into kernel slots that already exist; memory persists per agent×customer (live-verified accumulating across 3 turns). Zero business logic, zero kernel edits.

The honest decomposition of "policies", because this is where hand-waving would hide:
- **"No discounts / no refunds" - hard layer:** the employee simply *has no discount or refund operations on its menu* - the strongest enforcement possible (you cannot execute what PERCEIVE never offers, and AUTHORIZE denies off-menu proposals - `capability_unavailable`). Plus per-tool HITL policies (tenant data, enforced by the production gate the kernel now wraps).
- **"No discounts" - soft layer:** as *language* ("don't promise a discount in prose"), it is guidance text - LLM-steered, exactly the same enforcement strength these policies had in the legacy brain. The architecture is not weaker here; no architecture makes prose deterministic.
- **"Business hours only":** a *when-to-run* policy - it belongs to the pipeline (should this turn happen at all?), above cognition, implementable as data (worker/flow gating). Correctly not a kernel concern.
- One remaining data-plumbing item (not a kernel change): per-employee operation scoping via `permissions.allowedOperations` - the kernel slot exists and is enforced by Guardrails; the adapter currently passes allow-all for the pilot. Wiring `AgentToolPermission → allowedOperations` is adapter work.

### S3 - Replace OpenAI (Claude / Gemini / local) → **PARTIAL** - cognition swaps cleanly; the infra client layer is single-vendor

- **The cognitive pipeline: PASS.** The Reasoner is behind a provider seam (`reasoner/index.ts`: implement `ReasonerProvider` in a sibling file, select via `REASONER_PROVIDER` - "nothing above the boundary changes"); its I/O contract (`ReasonerInput → ReasonerOutput`) is vendor-neutral and schema-validated; grep of loop/oracle/guardrails/resolver: **zero OpenAI references**. Everything OpenAI-shaped (prompt text, JSON coaxing, SDK call) is confined to one 200-line provider file.
- **The leakage, precisely located:** `services/ai/src/services/ai.service.ts` - the metered LLM client - is a **single OpenAI SDK client** (`import OpenAI from "openai"`, one `client.chat.completions.create` path). The Writer, the legacy brain, and the Reasoner provider all call through it. Also `embedding.service.ts` (OpenAI embeddings for the KB). Swapping vendors fully therefore means adding a provider branch to the *metering/client layer* - which is **infrastructure, not the cognitive pipeline**, but it is real work that doesn't exist yet.
- Verdict: the architecture is fundamentally capable (the seams are in the right places; no cognitive component knows the vendor); the platform is not yet *configured* multi-vendor at the client layer. That is implementation debt below the kernel, not an architectural flaw.

### S4 - Ten new Operations (SEARCH_ORDER … CREATE_QUOTE) → **PASS**

The exact recipe (contract-as-data + port + bindings + describeWorld + register) was executed 12 times plus a dynamic family. Mapping the ten: SEARCH_ORDER/CREATE_ORDER/SEARCH_PRODUCT/CREATE_QUOTE → commerce connectors (Shopify/Wix/WooCommerce adapters already exist below); CREATE_TICKET/UPDATE_TICKET → Jira/Zendesk connectors (S1); SEND_EMAIL/SEND_SMS → connectors over the existing outbound infrastructure (channel constraints like WhatsApp templates remain pipeline data, correctly); SEARCH_KNOWLEDGE → already shipped; **REFUND** - the adversarial one - is money-moving: `approval: "configurable"` + the production HITL floor (`always` for high-risk, exactly like `create_task` today, *proven* to never auto-execute in the hermetic test) + the AWAITING_APPROVAL flow already modeled end-to-end. Idempotency for money ops = contract `dedupKey` + connector-level dedup (the booking-store pattern). **No kernel component is touched by any of the ten.**

### S5 - Same employee, advisory ↔ autonomous → **PASS** (proven daily, by construction)

Verified at the type level and empirically: `mode` **does not exist** in the cognition contract (`cognition.ts` - zero occurrences), so reasoning *cannot* branch on it; Guardrails explicitly exclude mode ("mode changes only EXECUTE's effect, never authorization"); the resolver short-circuits WRITEs to RECOMMENDED in advisory *after* PRE invariants, READs execute in both. The entire shadow-evaluation program and the copilot run on exactly this property, thousands of times over.

### S6 - Voice (phone agent) → **PASS architecturally, with one honest engineering caveat**

The kernel is I/O-agnostic by construction: input is a text transcript + identity, output is one reply string; STT→transcript and reply→TTS are adapters, exactly like the WhatsApp pipeline is today. Turn abortion is first-class (`signal: AbortSignal` threaded through the loop - barge-in maps to it). Loop bounds are per-policy data (a voice deployment sets tight `maxIterations`/`maxWallMs` and a fast model - configuration, not code).

The caveat, stated plainly: measured multi-iteration turns run 15–70s with the current model - unacceptable for voice. That is **model selection and policy configuration, not architecture** (nothing in K1–K9 imposes latency). One true interface note: the Writer returns a single string; token-streaming TTS would change the Writer's *implementation* (explicitly designed as swappable - "changes only this file") but full streaming through the loop would touch the K7 signature. Streaming is not *required* for a functional phone agent (sentence-level TTS on the reply works); it is an optimization. So: fundamentally capable - voice needs an adapter + tuned policy, not a new kernel.

### S7 - Multi-Agent (Sales → Finance → Support) → **PASS for the stated shape; scope honestly bounded**

The stated collaboration is **sequential handoff/delegation**, and the kernel supports it two ways without modification:
1. **Handoff as pipeline routing** - reassigning `assignedAiAgentId` mid-conversation already exists in production (the flow-executor does it today). Each agent runs its own loop with its own mission/memory/permissions. Above the kernel.
2. **Delegation as an Operation** - a `DELEGATE_TO_<ROLE>`/`CONSULT_COLLEAGUE` operation whose connector *invokes another `runAgentLoop`*. The kernel permits this trivially: `runAgentLoop` is a plain async function; the sub-agent's answer returns as an observation; the Runtime remains the sole executor on both sides; each agent's Guardrails apply to its own facts. A "colleague" is just another external system behind a connector.

What is *not* covered - and I won't pretend otherwise: genuinely parallel agent teams with shared working memory, negotiation, or consensus would need an **orchestrator above the kernel** (a component that runs multiple loops and merges results). That is new machinery, but it is *composition of kernels*, not modification of one - the same way the migration router composed brains without changing either. Nothing in the stated 5–10-year scenario requires kernel surgery.

### S8 - Knowledge (RAG / vector / Notion / Confluence / Drive) → **PASS** (already demonstrated)

`SEARCH_KNOWLEDGE` shipped as a pure operation wrapping the production RAG - and the reasoner has **zero** knowledge-specific code (grep-verified; the world view renders generically like every other capability). Notion/Confluence/Drive already feed the *same* KB through the existing hourly sync - sources plug in below the operation, invisible to cognition. The legacy brain's strategy-gated retrieval heuristic dies with the legacy brain; nothing in the kernel assumes knowledge exists.

### S9 - Customer's internal ERP → **PASS** (this exact scenario is already in production form)

`CustomCapability` is literally this: tenant-defined HTTP/DB tools become operations with dynamic per-tenant menus, host whitelists, risk-based approval floors priced by the production policy layer - registered once, kernel untouched (proven by the untouched kernel suite when it landed). A "real" ERP product (SAP/Priority/NetSuite) graduates from custom tools to a first-class connector via S1's proven recipe. Cognition never changes either way.

---

## Adversarial findings that did NOT break the kernel (but must become law)

1. **Operation namespacing convention** (S1) - first-owner-wins dispatch + name-dedup menu means colliding generic names silently misroute. The kernel already supports qualified names; the convention must be mandatory for new connectors. *Below-kernel rule, write it into the connector recipe.*
2. **Multi-vendor LLM client** (S3) - one OpenAI SDK client behind the metering choke point. Provider branch to add when the second vendor is actually wanted. *Infra, not cognition.*
3. **Approval-resume post-legacy** - today an approved action executes via the legacy dispatcher; when legacy dies, the approvals route must call `executeOperation` instead. *A route change above the kernel; already noted in the migration roadmap.*
4. **Context extensibility** - `ExecutionContext` is open (`[k: string]: unknown`) by design; `CapabilityContext` carries fixed identity fields and may gain optional ones (additive, non-breaking). *The escape hatch exists.*
5. **Menu scale** - 10 connectors × 10 ops = a large menu; filtering is already data (`permissions.allowedOperations` ∩ employee scoping). *No kernel change; watch prompt size.*

None of these is a modification to K1–K9. Each is a rule, an adapter, or an infra branch.

---

## Final Answer

**YES - this architecture can realistically be GOTCHA's permanent foundation for the next 5–10 years.**

Why, in one paragraph: the kernel is nine small components (~1,600 lines) that contain **zero domain knowledge, zero vendor knowledge, and zero business policy** - all three verified by grep, by tests, and by four real capability additions that each left it byte-untouched. Every axis of product growth maps to a slot that already exists and has already been exercised: new integrations → connectors + operations (proven ×4, incl. a deliberately foreign domain); new employees → rows of data through a binding layer (proven with the pilot); new models → a provider seam (contract in place); new modalities → adapters at the edges (transcript in, one reply out, abortable); new policies → menu scoping + deterministic guardrails + HITL data; collaboration → composition of loops, not modification of one. The scenarios that scored below PASS failed on *infrastructure configuration* (a single-vendor LLM client) or on *engineering caveats* (voice latency is model/policy tuning), never on the kernel's shape.

**Explicit statement, as requested:** the remaining work for the coming years is **adding Operations, Connectors, Employees, prompts, memory, and evaluation/training - plus finishing the migration (cutover, copilot, legacy deletion) - and none of it requires changing the kernel.** Architecture evolution is over, on two conditions that are rules rather than redesigns: (1) the operation-namespacing convention becomes mandatory for every new connector, and (2) the kernel freeze is enforced going forward the same way it was proven - any PR that touches K1–K9 to ship a business capability is, by definition, a bug in the capability, not in the kernel.
