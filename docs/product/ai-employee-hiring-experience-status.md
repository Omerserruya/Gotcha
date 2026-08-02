# Hiring Experience - Built vs. Spec'd (Implementation Reconciliation)

> **Companion to** `ai-employee-hiring-experience-spec.md` (the vision) and `ai-employee-experience-vision.md`.
> **Purpose:** answer one question honestly - *of the "hire an employee" experience, what is already built, and what is only written?*
> **Method:** direct code survey of `frontend/`, `services/ai/`, `packages/shared/prisma/schema.prisma`, `packages/shared/src/lib/agent/` (2026-07-05).
> **Verdict in one line:** the **plumbing is ~60–70% there; the *experience layer* is ~10% there.** We built the machine that makes a hire possible. We have not built the feeling of hiring.

---

## The headline

The spec's thesis is *"stop letting owners configure an employee; let them meet, interview, hire, and watch it earn trust."* Today's product is still the thing the spec explicitly rejects: **a 4-step configuration wizard** (`chat → kb → refine → tools`) inside an "AI Studio / Agents" surface, with a template **marketplace** - the exact "template gallery + settings tabs" Part X of the spec says we rejected.

The good news: almost every *primitive* the experience needs (modes, approvals, per-tool permissions, readiness gaps, draft/resume, objectives/KPIs) **already exists in code**. The missing work is overwhelmingly **presentation, framing, and sequencing** - the product surface - not new architecture. This is consistent with the frozen-architecture premise: we are not blocked on the kernel.

---

## Map 1 - The nine hiring Moments (pre-employment)

| Spec Moment | Status | What exists in code | What's missing (the gap) |
|---|---|---|---|
| **0 - The Opening** ("Who do you need?") | ❌ Not built | Entry is `ai-studio/agents/[id]` "Agent Builder"; there's a `marketplace/` template gallery. | The one-line need→hire opener, role chips, "post the job" framing, "Hire" verb. Entry is *create agent*, not *open a role*. |
| **1 - The Candidate Arrives** (introduces itself) | ❌ Not built | Nothing. Agent has no identity until the owner names it. | Single-candidate arrival, first-person self-summary ("Hi, I'm Maya… I'd be your SDR"), avatar/personhood-before-parameters. |
| **2 - The Two-Way Interview** (heart of product) | 🟡 Partial | `AgentBuilder.tsx` step `"chat"` is a real conversational config step; `agent-builder.service.ts` + `wizard-binding.service.ts` drive a chat that elicits config. | It's the *owner describing config to the AI*, not the *AI interviewing the owner* with the 3–5 sharp questions, and **no owner-interviews-back / no live audition** ("show me how you'd reply"). |
| **3 - The Proposal** (AI writes its own JD) | ❌ Not built | No `jobDescription` artifact; config is captured as persona/style/objectives fields. | The self-authored one-page Job Description presented for approve/adjust/rewrite. The AI never proposes its own role. |
| **4 - Access Requests** (integrations, negotiated) | 🟡 Partial | Tools step is a checkbox/card picker with capability CONNECTED states + integration logos; OAuth connect flows exist. | Reframing as *"I need X because…, I'll only…, I'll never…"*, one-at-a-time, "Not yet" with stated cost. Today it's a logo grid - the exact anti-pattern §VIII calls out. |
| **5 - Training Request** (knowledge + honest gaps) | ✅ Mostly built | In-wizard KB creation/upload (`StepKnowledge`, `createKnowledgeBase`); **Readiness Test** (`agent-readiness.service.ts`) generates 28–36 real customer Qs, per-question coverage `full/partial/none`, `gapType knowledge/tool/data`, score + recommendations. | The *framing*: "I read it all tonight; here's what I still don't know - flag you or tell me now?" The honesty engine exists; the employee-voice narration around it doesn't. |
| **6 - The Authority Envelope** (permissions as trust) | 🟡 Partial (backend strong, UI absent) | Real backend: `AgentToolPermission`, `TenantToolPermission.requiresApproval`, `hitlPolicy` JSON, `ApprovalRequest` model, `PENDING_APPROVAL` status, `BusinessPolicy` (maxDiscount, refundRequiresApproval, escalationKeywords). | The **owner-facing 3-tier envelope** ("On her own / Ask me first / Never"), drag-between-tiers, dollar steppers, conservative-default + "I'd rather earn it" copy. All primitives exist; there is no envelope screen. |
| **7 - The Offer** (emotional climax) | ❌ Not built | Finalize/activate flips `AIAgentStatus DRAFT → ACTIVE`. | The one-page Offer letter, weighty "Extend the offer" CTA, the in-character acceptance beat, "joined your team" roster transition. Today it's Save & Activate. |

**Pre-hire scorecard:** 1 built, 3 partial, 4 not built. The *judgment-provoking surfaces* (introduction, JD proposal, offer) are all absent; the *data-collection surfaces* (knowledge, tools, permissions) exist but wear configuration clothes.

---

## Map 2 - Draft / resume / states

| Spec element | Status | Evidence |
|---|---|---|
| Draft "candidate waiting to hear back," resumable | ✅ Built (framing missing) | `AIAgentStatus DRAFT`, `builderStep` persistence, resume-into-step logic in `AgentBuilder.tsx`; incomplete = `DRAFT AND builderStep NOT NULL`, surfaced as "resume setup." Functionally exact; just phrased as a form, not a person. |
| Loading states as human-paced anticipation | ❌ Not built | Standard streaming/spinners; no "Finding you a candidate…" honest sub-steps. |
| Error-as-dialogue (in employee voice, one-tap recover) | ❌ Not built | Errors are conventional (`setError`, toasts). |
| Empty state "You haven't made your first hire yet" | ❌ Not built | Studio empty states are feature-oriented, not hire-oriented. |

---

## Map 3 - The post-hire relationship (Part III of the spec - the actual product)

| Spec element | Status | What exists | What's missing |
|---|---|---|---|
| **Trust Ladder** (Shadowing → Supervised → Trusted) | 🟡 Runtime yes, owner-surface no | Runtime modes exist: agent loop `mode: advisory \| autonomous` (`loop.ts`, `AgentLoopRun`), and the `OFF → SHADOW → AUTONOMOUS` lifecycle (live-verified via `pilot-calendar-loop`). | The **owner-facing named ladder** on the employee card, and movement-as-ceremony. Autonomy is a runtime flag, not an earned, visible arc. |
| **First 24h - Shadowing / would-have-said** | 🟡 Partial | Shadow evals corpus (`ReasonerShadowEval`, `/api/reasoner-shadow`) captures would-have decisions - but for *engineering* eval, not owner review. | Owner-facing side-by-side "see what she'd have said" + "She nailed it / Not quite." |
| **Shift Report** (daily heartbeat) | ❌ Not built | No `ShiftReport` model; `AgentLoopRun/Iteration` is an observability corpus. | The entire daily report artifact and its morning delivery. |
| **First Approval** (colleague asks permission) | 🟡 Backend yes, framing no | `ApprovalRequest` + `PENDING_APPROVAL` + approvals page exist (`frontend/src/app/approvals/`). | The "Can I send this? [Send it / Edit / I'll take this]" colleague framing with plan-B-if-declined. |
| **First Mistake** (owned, logged as visible rule) | ❌ Not built | Thumbs/edit correction may feed model context, but no visible "I've logged that rule" loop. | The owned-mistake → visible rule → "won't happen again" exchange. |
| **First Coaching Moment** (generalize how far?) | ❌ Not built | - | "Warmer everywhere / just new leads / just this once" remembered coaching. |
| **First Success** (loud, ties to named pain) | ❌ Not built | Objectives engine tracks goal completion (`objectives.ts`, NBA) - the data exists. | The celebratory moment tied back to Moment-2's named pain. |
| **Weekly / Monthly Review** (1:1 ending in autonomy ask) | ❌ Not built | Analytics dashboards exist but are metrics, not a 1:1. | The check-in artifact that ends in an evidence-backed request for more authority. |
| **Promotion ceremony + track-record ledger** | ❌ Not built | Approval history is stored but not composed into a per-action ledger ("booking: 12 approved, 0 corrected"). | The ledger view + grant-authority ceremony + blameless demotion. |
| **Trust milestone - remove approvals** | ❌ Not built | Toggling `requiresApproval` is possible in data. | The meaningful "this is the moment it stopped feeling like software" surface. |

**Post-hire scorecard:** 0 fully built, 4 partial (runtime/backend only), 6 not built. **This is the product per the spec - and it is almost entirely unbuilt as an experience.** The relationship, which the spec correctly names as the real product, currently exists only as engineering telemetry.

---

## Map 4 - The 20 required brief elements, at a glance

Built ✅ · Partial 🟡 · Not built ❌

1. Philosophy of hiring - ✅ (spec)  · 2. Onboarding journey - 🟡 (spec complete; wizard reality diverges) · 3. Every screen - 🟡 · 4. Every state - 🟡 · 5. Every CTA - 🟡 · 6. AI's questions - 🟡 (config-elicit yes, interview no) · 7. Owner's questions - ❌ · 8. Empty states - ❌ · 9. Error states - ❌ (conventional) · 10. Loading states - ❌ · 11. Progressive disclosure - 🟡 (wizard hides depth, but still config) · 12. Trust built - 🟡 (readiness + approvals primitives) · 13. Autonomy earned - 🟡 (runtime modes, no owner arc) · 14. Integrations naturally - 🟡 (picker, not negotiation) · 15. Knowledge naturally - ✅ (KB + readiness gaps) · 16. Permissions naturally - 🟡 (strong backend, no envelope UI) · 17. After hiring - ❌ · 18. First 24h - ❌ · 19. First week - ❌ · 20. First month - ❌

---

## What this means (founder read)

1. **The spec is done and it is category-defining. Do not rewrite it.** It passes its own OpenAI/Apple/Linear test. The work now is *build*, not *think*.
2. **We are not architecture-blocked.** The frozen kernel already gives us modes, approvals, per-tool permissions, readiness-gap detection, objectives/KPIs, and draft/resume. The gap is a **presentation-and-sequencing layer**, which is exactly where a product team should be.
3. **The two highest-leverage builds, in order:**
   - **(a) The pre-hire experience layer** - reskin/resequence the existing wizard into Moments 0–7: introduction → two-way interview + live audition → self-written JD → access-requests-with-reasons → authority-envelope UI → offer letter. Every one of these sits on primitives that already exist; the live audition and JD-proposal are the only genuinely new AI behaviors, and both are within the frozen reasoning surface.
   - **(b) The Shift Report + Trust Ladder surface** - the smallest post-hire build that makes the *relationship* real: a daily report (compose from existing loop/approval data) and an owner-facing earned-autonomy ladder on the employee card. This is what converts "I configured a bot" into "I'm managing someone."
4. **One thing to kill:** the template **marketplace** as the front door contradicts "one confident candidate." Keep templates as a hidden accelerant; never as the entry.

---

## The single sentence

> **We built the mind and the muscles. We have not built the person.** The spec describes the person; the codebase proves the person is *possible today*. The remaining work is to let the owner *meet* what we've already made capable - and that is product surface, not architecture.
