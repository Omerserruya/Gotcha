# The AI Employee - Definitive Product Experience

> **Framing:** written as a founder defining a category, not an engineer auditing a build.
> The cognitive architecture (kernel, agent loop, capability runtime, connectors) is **frozen and assumed complete.** Nothing here redesigns it. Everything here is about the **owner's experience** of hiring, training, trusting, supervising, and scaling AI Employees.
> **Companion (engineering lens):** `docs/architecture/ai-employee-platform-audit.md`. This document is the product lens that sits on top of it.
> **Date:** 2026-07-05

---

## 0. The One Idea That Changes Everything

GOTCHA today is an **excellent AI-configuration platform wearing the word "employee."**

The distance between *"configuring software"* and *"hiring an employee"* is **not a feature gap. It is a mental-model gap and a trust gap.**

When a business owner hires a human, a specific ritual happens - and every part of it exists to manufacture trust:

1. They write a **job posting** (one paragraph, not a form).
2. They read a **résumé** and interview a **candidate** (they evaluate; they don't fill in the candidate's skills themselves).
3. They **make an offer** with a role, a scope, and a compensation/authority envelope.
4. The hire starts on **probation** - supervised, watched, low authority, graduating as trust builds.
5. They get a **manager relationship** - check-ins, corrections, "come ask me if you're unsure."
6. They see **performance** - outcomes, not activity.
7. Over time the hire **learns the business**, needs less supervision, and eventually **supervises others.**

**The winning product is organized around those seven primitives - not around wizard steps and settings sections.**

Every screen in this document is evaluated by one test:

> **Does this feel like managing a person, or configuring a tool?**

The current product fails that test not because the intelligence is weak - the kernel is genuinely strong - but because the intelligence is dressed as configuration. The category-defining move is to **dress the exact same intelligence as a colleague.**

---

## 1. Executive Summary

### Current state (honest)
- **The brain is real; the body is a config panel.** The kernel reasons, plans, gates, and explains - to the database. The owner experiences a 4-step wizard, nine config sections, an inbox with no AI attribution, and (until this week) a fabricated analytics page.
- **The P0 correctness pass (done 2026-07-05) fixed the embarrassments:** unreachable employees, silent failures, fake analytics, cosmetic "pause," wrong cost math, one-way human takeover. Those were **table stakes**, not differentiation. Shipping them means the product no longer lies. It does not yet mean the product feels like hiring.
- **On the 14-question "does this feel like an employee" scorecard: 1 YES / 7 PARTIAL / 6 NO.** That single number is the whole thesis.

### Future state (the category)
An owner arrives, types one sentence about a job to be done, and **meets a candidate** - a named employee with a proposed résumé, a job description it wrote itself, the tools it says it needs, and the questions it still has. They hire it in minutes. It starts on **probation**, handling real traffic while they watch. It sends a **shift report** in plain language. It **asks before doing anything risky**, with the risk explained like a colleague would. It gets **better because they correct it.** When they have ten of them, an **AI Manager** supervises the team and escalates only what matters. The owner never once feels they are "configuring software." They feel they built a team.

### Biggest opportunities (ranked)
1. **Hiring, not configuring** - flip the wizard from *interviewing the owner* to *presenting a candidate*. This is the single highest-leverage change and almost nothing about the kernel needs to move.
2. **Probation as the trust unlock** - the shadow→supervised→autonomous machinery already exists in the kernel and is completely invisible. Surfacing it as a *supervision ritual* is the difference between "I'll never let AI touch my customers" and "I watched it for a week, it's ready."
3. **The living Employee Profile** - one page that answers "who is this, what did they do today, what are they waiting on, how are they doing" replaces nine settings sections.
4. **The Shift Report / Observatory** - the kernel already "thinks out loud" to the DB. Turn that into a proactive, human-language account of decisions. Trust is a *narrative*, not a log.
5. **Correction = training** - every override and 👎 becomes a coaching moment the employee remembers *and* a platform eval. Owner trust and product improvement become the **same pipeline.**
6. **Authority as spending limits** - express HITL as an authority envelope the owner sets like they would for a real new hire ("book freely; refunds up to $200 need me; never send a contract alone").
7. **The org layer** - teams, departments, shared knowledge, and eventually an **AI Manager** are the abstractions that let 1 employee become 100 without the experience collapsing into a list.

### Biggest risks
- **Trust cold-start.** Owners will not hand real customers to an AI they cannot supervise. If probation + observatory + authority ship weak, GOTCHA is a better chatbot, not an employee. **This is the make-or-break risk.**
- **Over-configuration relapse.** Every new capability tempts a new settings section. The discipline of *progressive disclosure* (hide config behind "manage," lead with the living profile) must be a founding law, or the product drifts back into a control panel.
- **Roles are compiled.** The "role library" is a marketing promise the codebase can't yet keep - a new role is 7-8 synchronized code edits. Until roles are data, the library stays thin and the "hire an SDR / a Receptionist / a Billing Specialist in one click" story is hollow.
- **The uncanny-manager valley.** If the employee explains too much, it overwhelms; too little, it's a black box. Getting the *altitude* of explanation right (colleague, not stack trace; not chat log either) is a genuine design risk.

---

## 2. The Owner Journey

The spine of the product. Six acts. Each maps to a human-management primitive, and each must pass the "person, not tool" test.

### Act 1 - CREATE → *"Hire," not "configure"*

**Today:** a 4-step conversational wizard interviews the *owner* for name, tone, languages, success criteria, funnel design, per-tool checkboxes. The owner does the candidate's work.

**The leap - Hire from a job posting:**
1. Owner writes **one sentence**: *"I need someone to answer support questions and refund small orders without bugging me."*
2. The platform returns a **candidate**: a name, an avatar, a **proposed résumé** ("I'm a Support Specialist. Here's how I'll handle refunds, escalations, and questions I can't answer."), a **draft job description**, the **tools I'll need** ("I'll need access to your orders and your help center"), and **questions I have for you** ("What's the biggest refund you're comfortable letting me issue alone?").
3. Owner **reviews and edits the candidate**, not a form. Hiring = **approving a person.**
4. **Everything else is inferred or deferred.** Tone, language, funnel structure, KPIs, escalation thresholds - the candidate proposes sensible defaults from the role and the business context already on file. The owner corrects by exception, not by interrogation.

> **What's actually required to hire:** the one-sentence job + a knowledge source + an authority envelope. That's it. Name, tone, languages, KPIs, funnel, tools → **proposed, not asked.**

**Minutes-to-hire target: under 5.** The felt experience: *"I described a job and a colleague showed up."*

### Act 2 - TRAIN → *"Teach," not "upload"*

**Today:** knowledge is a mandatory upload gate in the wizard; validation is a one-time "readiness test."

**The leap - Teach continuously, like onboarding a real hire:**
- **Day-one knowledge** is whatever the employee needs to not embarrass itself - pulled automatically from connected sources (help center, site, CRM, docs) with the employee saying *what it read and what it still doesn't know.*
- **Knowledge gaps surface as the employee works.** When it hits a question it can't answer, that becomes a **"teach me this"** card in the profile - not a silent failure, not a hallucination. The owner answers once; the employee remembers.
- **Corrections are training.** Every 👎, every edited draft, every override is captured as *"here's how I want this handled"* and folds into the employee's memory **and** the platform's eval corpus.
- The felt experience: *"I'm coaching a new hire who actually remembers what I told them."*

### Act 3 - LAUNCH → *"Probation," not "go live"*

**This is the trust unlock and it is almost entirely missing from the owner experience today** (the machinery exists in the kernel as shadow/autonomous modes; the owner never sees it).

**The leap - a first-class probation lifecycle:**

| Stage | What the employee does | What the owner does | Authority |
|-------|------------------------|---------------------|-----------|
| **Shadow** | Handles real traffic in the background; drafts what it *would* say/do; never sends | Watches decisions on real conversations, side-by-side with what actually happened | None (observe-only) |
| **Supervised** | Handles traffic for real, but **every action waits for a thumbs-up** | Approves/edits in-flight; sees it get things right | Propose-only |
| **Autonomous** | Acts within its authority envelope; escalates by policy | Reviews the shift report; spot-checks | Full within envelope |

- The owner **graduates the employee** stage-by-stage, on evidence they watched accumulate. Graduation is a **deliberate, earned moment**, not a toggle.
- Probation is **per-employee** and **reversible** - a struggling employee gets *demoted back to supervised*, exactly like a real one.
- The felt experience: *"I didn't flip a switch and pray. I watched it work for a week and promoted it."*

> Probation is where "I'd never trust AI with my customers" becomes "I trust this one, because I supervised it." **No single feature moves adoption more.**

### Act 4 - OBSERVE → *"The shift report," not "the logs"*

**Today:** the richest explainability corpus in the category - written to the database, surfaced almost nowhere (1 YES on the scorecard). A "Why" button exists on some conversations; that's the seed.

**The leap - the employee reports to you like a person would:**
- A **daily/shift summary** in plain language: *"Handled 34 conversations. Booked 3 demos. Refunded 2 small orders. Escalated 1 angry customer to you. I got stuck twice on questions about your return window - can you teach me?"*
- A **decision timeline** per conversation, at colleague altitude: *what I saw → what I decided → what I did → what happened → what I'll do next.* Not a reasoning dump. Not a chat log. A narrative.
- **Proactive surfacing of the important, silence on the mundane.** The owner should never scroll logs; the employee tells them what matters.
- The felt experience: *"My employee tells me how the day went. I don't audit a machine."*

### Act 5 - IMPROVE → *"Coach," not "reconfigure"*

**The leap - the correction loop is the product's flywheel:**
- The owner **corrects in the flow of work** - edits a draft, overrides an action, thumbs-down a reply - and the employee **treats it as coaching it remembers.**
- Override rate **trends down over time** and the product *shows that trend*: *"You used to correct me 1 in 5 times. Now it's 1 in 40."* That single declining line is the most trust-building metric in the entire product.
- Behind the scenes (owner never sees this, but it's the strategic gift): **every correction is also a platform eval** - the same signal that grows owner trust also earns the right to delete legacy compensation code. *Owner trust and engineering progress are one pipeline.*

### Act 6 - SCALE → *"Build a team," not "manage a list"*

**The leap - the abstraction that appears is the org:**

| Scale | The right abstraction |
|-------|-----------------------|
| **1 employee** | The living Profile |
| **~10** | A **team view** (org chart), shared knowledge, a routing "front desk" |
| **~100** | **Departments**, an **AI Manager** layer that supervises employees and escalates to the human only what's above the line, delegation between employees, shared knowledge bases owned at the department level |

- The **AI Manager** is the killer scale primitive: at 100 employees the owner cannot supervise each one, so they supervise the *manager*, who supervises the team. This is the same recursion humans use to scale - and it's the natural extension of the frozen kernel (a manager is an employee whose customers are other employees' escalations).
- The felt experience: *"I went from hiring one to running a department, and the interface grew with me instead of drowning me."*

---

## 3. AI Employee Product Architecture (concepts, not services)

The product's mental model. These are the nouns the owner should think in. (Deliberately *not* a map of microservices.)

```
OWNER
  └─ owns ─▶ ORGANIZATION
                ├─ DEPARTMENTS  (Sales, Support, Billing …)
                │     ├─ shared KNOWLEDGE
                │     └─ EMPLOYEES
                │           ├─ IDENTITY      (name, role, mission, persona, voice)
                │           ├─ JOB           (responsibilities, goals, KPIs - the "job description")
                │           ├─ KNOWLEDGE     (what it's been taught + what it knows it doesn't)
                │           ├─ TOOLS/ACCESS  (integrations it's authorized to use)
                │           ├─ AUTHORITY     (the envelope: what it may do alone vs must ask)
                │           ├─ PROBATION     (shadow → supervised → autonomous, per employee)
                │           ├─ MEMORY        (per-customer + learned corrections)
                │           └─ RECORD        (activity, decisions, performance, corrections)
                └─ (at scale) AI MANAGER  ── supervises EMPLOYEES, escalates to OWNER
CUSTOMERS  ── talk to ─▶ EMPLOYEES   (via the "front desk" / routing)
```

### The employee, defined

**Minimum viable employee** (what's truly required to hire):
1. **A job** - one-sentence responsibility ("qualify inbound leads and book demos").
2. **A knowledge source** - something to be right about.
3. **An authority envelope** - what it may do alone.

Everything else is **proposed by the platform and refined by exception.**

**Ideal (complete) employee:**
- **Identity** - name, role, mission ("why I exist"), persona/voice.
- **Job** - responsibilities, goals, KPIs (proposed from the role, tuned over time).
- **Knowledge** - taught + self-declared gaps.
- **Access** - the integrations it's authorized to touch.
- **Authority** - the escalation/approval envelope (see §HITL).
- **Boundaries** - working hours, tone limits, hard "never do" rules.
- **Memory** - per-customer continuity + learned corrections.
- **Record** - its activity, decisions, performance, and coaching history.

> **The critical reframe:** today these are *nine config sections.* In the target they are *facets of one person* - shown as a **profile**, edited by **exception**, most of them **never touched by the owner at all** because the platform proposes and the employee self-manages.

### Lifecycle

```
POSTED (job described)
  → CANDIDATE (résumé proposed, owner reviewing)
  → HIRED (approved)
  → PROBATION: SHADOW → SUPERVISED → AUTONOMOUS   (reversible)
  → EMPLOYED (working within authority, reporting, learning)
  → [PAUSED / DEMOTED / OFFBOARDED]   (all first-class, all reversible where it makes sense)
```

Two things the current product gets *wrong* on lifecycle and the target must get right:
- **"Active" is not a binary.** The current ACTIVE/PAUSED/DRAFT enum flattens the entire probation arc into one bit. The owner needs to feel the *arc*.
- **Offboarding matters.** A real employee who leaves hands off their customers and their knowledge. Deleting an AI Employee should ask *"who inherits its conversations and what it learned?"* - not orphan them.

---

## 4. Audit by Surface (current → ideal → the leap)

A crisp verdict on each area you asked about.

### Employee Creation
- **Current:** wizard interviews the owner; ends by wiring no routing (the "go live" was a broken promise until P0). Right species, wrong ending, wrong direction of questioning.
- **Ideal:** owner writes a job posting; platform returns a candidate to hire. Required = job + knowledge + authority. Inferred = name, tone, language, KPIs, funnel, tools. Deferred/progressive = everything else.
- **The leap:** invert the interview. *Stop asking the owner what the employee should be. Show the owner a candidate and let them react.*

### Employee Identity
- **Current:** identity is scattered across config fields; roles are compiled, so identity is shallow.
- **Ideal:** identity = role + mission + persona, mostly proposed. Mission ("why I exist, in one line") is the emotional core and is currently absent.
- **The leap:** give every employee a **one-line mission** it can state in its own voice. That single sentence does more for the "it's a person" feeling than any avatar.

### Employee Onboarding
- **Current:** upload-and-test gate.
- **Ideal:** continuous teaching; day-one auto-knowledge from connected sources; gaps surfaced as they occur.
- **The leap:** onboarding never "ends" - it becomes the improve loop. The employee tells you what it learned and what it still doesn't know.

### Employee Profile
- **Current:** nine config sections (a settings page).
- **Ideal:** one **living profile** - *Overview (who + mission + health), Today (activity + what it's waiting on), Knowledge (taught + gaps), Access (integrations + authority), Performance (outcomes + trend), and a quiet "Manage" drawer for the rare config edit.*
- **The leap:** **demote configuration.** The profile leads with *life* (what it's doing, how it's doing), not *settings*. Config hides until asked for.

### Employee Trust
- **Current:** the corpus exists; the owner sees ~1/14 of what would build trust.
- **Ideal:** the owner can always answer, in plain language: what happened, why, what it knows, what it decided, what it tried, what it escalated, what it learned.
- **The leap:** trust is a **narrative the employee proactively tells**, not an audit the owner performs. The approval card (already the best-explained surface in the product) is the tonal template for everything else.

### Employee Observatory / Explainability
- **Current:** write-rich, read-poor. A "Why" button is the seed.
- **Ideal:** shift report (proactive) + decision timeline (on demand) at *colleague altitude.*
- **The leap - get the altitude right:** three layers, owner chooses depth. (1) **Headline** - "Booked a demo with Acme." (2) **Reasoning** - "They asked about pricing, qualified as a fit, so I offered times." (3) **Trace** - the full kernel timeline, for the rare deep dive. Default to layer 1-2. *Never* dump layer 3 unprompted. **The risk is overwhelm; the antidote is progressive depth.**

### Employee Management (1 → 10 → 100)
- **Current:** a list of agents.
- **Ideal:** profile (1) → team/org view + shared knowledge + front desk (10) → departments + **AI Manager** + delegation (100).
- **The leap:** the **AI Manager** - supervise the supervisor. Without it, scale is a spreadsheet of anxieties.

### Role Library
- **Current:** roles are **compiled** - a new role is 7-8 synchronized code edits across two packages + frontend; two shipped roles (Receptionist, Customer Success) are internally broken; language is hardwired into role mechanics.
- **Ideal:** a **role registry as data** - hire an SDR, Support Specialist, Receptionist, Billing Specialist, Account Manager in one click; roles are templates you *inherit and customize*; a role marketplace becomes possible.
- **The leap:** roles must become **data** before the "role library" story is honest. This is the biggest *believability* gap between the pitch and the code. (Kernel-safe: the loop binding is already ~90% of the pure-data target - this is a product-facing registry, not a kernel change.)

### Knowledge Experience
- **Current:** mandatory upload + one-time readiness test.
- **Ideal:** auto-ingest from connected sources; the employee declares what it knows/doesn't; gaps become "teach me" cards; corrections become knowledge.
- **The leap:** the employee is an **active learner that asks**, not a passive document store you fill.

### Integrations Experience (architecture frozen - owner-feel only)
- **Current:** capabilities exist; the owner authorizes via config.
- **Ideal - integrations feel like giving an employee keys:** *discover* ("your employee could do more if it could see your orders"), *understand* (plain-language "here's what it'll be able to do / never do"), *authorize* (one consent, framed as access-granting), *trust* (the effective-permissions card - already built in P1 - shown as "here's exactly what I can and can't touch"), *debug* (when a tool fails, the employee says so in the shift report, not a silent error).
- **The leap:** frame every integration as **"giving your employee access,"** with the employee narrating what that unlocks and where its limits are.

### Human In The Loop
- **Current:** a genuinely good approval card (what/why/risk/params/policy/decide), but authority is invisible config and takeover was one-way (P0 fixed the hand-back).
- **Ideal - authority as an envelope the owner sets like a manager:** *"Book meetings freely. Refunds up to $200 on your own. Anything over $200, or any contract, ask me first. Never do X."* Approvals are then the **natural consequence** of the envelope, explained in the employee's voice, with **if-you-reject-this-here's-what-I'll-do** and a **track record** ("you've approved 47 of my last 50 refund requests - want to raise my limit?").
- **The leap:** stop expressing HITL as policy configuration. Express it as **spending/authority limits for a new hire**, and let the employee *earn raises.*

### Analytics
- **Current:** was fabricated demo data (P0 replaced it with real governance metrics - good, but still a *telemetry* frame).
- **Vanity metrics to demote:** messages sent, tokens, raw "AI handled %," response time in isolation.
- **Trust metrics to feature:** resolution rate, escalation rate + reasons, **override-rate trend** (declining = learning), customer sentiment, approval rate.
- **Revenue metrics to headline:** meetings booked, leads qualified, deals influenced, **revenue touched, cost per outcome (not per token), $ saved vs a human FTE.**
- **The leap:** the dashboard headline is a **performance review**, not a console: *"This month, this employee handled the work of ~1.4 full-time reps, booked 22 demos, needed your help 8% of the time (down from 19%), and cost $180 to run."* Money and outcomes on top; telemetry buried.

---

## 5. Gap Analysis (current product vs the vision, ranked by impact)

Impact = weight of (trust unlocked × adoption unlocked × "feels like an employee").

| # | Gap | Today | Impact | Why it's the gap |
|---|-----|-------|--------|------------------|
| **G1** | **No hiring metaphor** - wizard interviews the owner | Config form | ★★★★★ | The entire "employee vs software" feeling starts here |
| **G2** | **Probation invisible** - shadow/autonomous exist in kernel, unseen | Env flag | ★★★★★ | The #1 lever on "I'd never trust AI with customers" |
| **G3** | **No living profile** - nine settings sections | Config panel | ★★★★★ | The owner's home base doesn't feel like a person |
| **G4** | **No proactive shift report** - corpus write-only | "Why" button seed | ★★★★☆ | Trust is a narrative the employee tells; today it tells nothing |
| **G5** | **Correction ≠ learning (visibly)** - no felt improvement loop | Overrides vanish | ★★★★☆ | The flywheel; also the eval pipeline for legacy deletion |
| **G6** | **Authority is invisible config, not an envelope** | Policy config | ★★★★☆ | HITL is the safety story; owners can't reason about risk |
| **G7** | **Roles are compiled** - library is a promise the code can't keep | 7-8 code edits/role | ★★★☆☆ | Kills the "hire any role in one click" pitch |
| **G8** | **No org/manager layer** - a list of agents | Flat list | ★★★☆☆ | Scale collapses past ~10 employees |
| **G9** | **Analytics is telemetry, not a performance review** | Real but console-framed | ★★★☆☆ | Owners buy outcomes/money, not token counts |
| **G10** | **Knowledge is passive** - upload + test, no "teach me" | One-time gate | ★★☆☆☆ | Employee should ask, not silently not-know |
| **G11** | **No offboarding / inheritance** | Delete = orphan | ★★☆☆☆ | Real employees hand off; AI ones shouldn't vanish |

Note: the P0 correctness items (reachability, silence, fake analytics, cosmetic pause, cost math, one-way takeover) are **prerequisites, not differentiators** - they move the product from *lying* to *honest*. They are done. The gaps above are what move it from *honest tool* to *hired colleague.*

---

## 6. Prioritized Roadmap (by business impact, trust, adoption, quality)

> Sequenced so that **each phase makes the product feel more like hiring**, and each unlocks the next. Kernel is frozen; all of this is product surface + data, riding the intelligence that already exists.

### P0 - *Make it honest* ✅ (DONE 2026-07-05)
Reachability, fail-loud, real analytics, enforced pause, correct cost, hand-back-to-AI. **The floor. Shipped.** The product no longer embarrasses itself. It is not yet differentiated.

### P1 - *Make it feel hired* (the trust core - highest ROI)
1. **Probation lifecycle, owner-visible** [G2] - surface the existing shadow→supervised→autonomous machinery as a supervision ritual with an earned graduation moment. *Biggest single adoption unlock.*
2. **The living Employee Profile** [G3] - collapse nine config sections into Overview / Today / Knowledge / Access / Performance + a quiet Manage drawer.
3. **The Shift Report + decision timeline at colleague altitude** [G4] - proactive, plain-language, progressive-depth. (Timeline read-API already landed in engineering P1-5 - this is the *product* framing of it.)
4. **Authority as an envelope** [G6] - express HITL as a new-hire authority limit the owner sets and the employee can earn raises against.

### P2 - *Make it improve* (the flywheel)
5. **Correction → learning, made felt** [G5] - every override/👎 becomes remembered coaching + the declining override-rate line, shown proudly. (Doubles as the eval corpus that earns legacy deletion.)
6. **Hiring flow: job posting → candidate → offer** [G1] - invert the wizard. (Sequenced after the profile so the "hire" lands the new hire on a home that feels alive.)
7. **Analytics as a performance review** [G9] - money and outcomes on top; telemetry buried.
8. **Active knowledge - "teach me" cards** [G10].

### P3 - *Make it scale* (the org)
9. **Role registry as data** [G7] - the honest role library; sets up a role marketplace. (Kernel-safe registry.)
10. **Team / department / org view + shared knowledge** [G8].
11. **The AI Manager layer** [G8] - supervise the supervisor. The scale primitive.
12. **Offboarding + inheritance** [G11].

**Sequencing logic:** trust before scale (nobody scales an employee they don't trust), and *feel* before *breadth* (a believable single employee beats a shallow library of ten). P1 is where adoption is won or lost.

---

## 7. Brutally Honest Assessment

*If GOTCHA launched tomorrow, as-is (post-P0):*

### Why customers would love it
- The **intelligence is genuinely strong** - the kernel reasons, plans, gates risk, and can explain every decision. Most "AI employee" products are a prompt and a vibe; this one has a real cognitive spine.
- The **approval experience is best-in-class** - what/why/risk/params/policy/decide, live and idempotent. When the product explains itself, it's excellent.
- It **now tells the truth** - real metrics, enforced pause, no silent failures, correct costs. That alone beats a surprising number of competitors.
- **Cost discipline is real** - it won't quietly bankrupt anyone.

### Why customers would hesitate
- **It still feels like configuring software.** The first run is a wizard and nine settings sections. The word "employee" is on the box; the experience inside is a control panel. That dissonance is felt in the first five minutes.
- **They can't supervise it into trust.** The probation machinery exists but is invisible, so the owner's only options are "off" or "let it talk to my customers" - a terrifying binary. Most SMB owners will choose "off."
- **It doesn't report back.** After launch, the employee goes quiet. No shift report, no proactive "here's how the day went." Silence from a new hire reads as *out of control.*
- **Correcting it feels like it goes nowhere.** Override an action and nothing visibly changes. The employee doesn't feel like it's learning, so the owner never relaxes.
- **The role library is thinner than the pitch.** "Hire an SDR, a Receptionist, a Billing Specialist" - but roles are compiled, two are internally broken, and non-English businesses silently lose role behavior. The demo will out-promise the product.

### What would prevent widespread adoption
- **The trust cold-start, unsolved.** This is the whole game. An owner will not hand real customers to an AI they cannot watch earn their trust. **Probation + observatory + authority-as-envelope are the unlock, and none are owner-visible yet.** Ship those and adoption inflects; skip them and GOTCHA is a very good chatbot competing on features instead of defining a category.
- **The configuration relapse.** Every roadmap has gravity back toward "add a settings toggle." If the team doesn't treat *progressive disclosure* as a founding law, the product slides back into a control panel one feature at a time.

### What's missing before it truly feels like hiring, not configuring
Five things, in order:
1. **A candidate to hire** (not a form to fill).
2. **A probation you can watch** (not a switch you flip).
3. **A profile that's alive** (not settings that are static).
4. **A colleague that reports and asks** (not a system that's silent).
5. **An employee that visibly gets better because you coached it** (not a config you re-edit).

Everything the kernel produces is already enough to deliver all five. **The category-defining work is not more intelligence. It is dressing the intelligence that exists as a colleague instead of a control panel.** That is a product and design mission, and it is entirely achievable on the frozen architecture.

---

### The one-sentence thesis
> **You already built the brain of an employee. The remaining work - and the entire moat - is building the *relationship*: hiring it, supervising it into trust, hearing how its day went, coaching it, and watching it grow into a team.**
