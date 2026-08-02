# Hiring an AI Employee - Product Specification

> **Type:** Product / UX / behavioral specification. No code, no architecture, no implementation - by design.
> **Scope:** the complete experience of bringing a new AI Employee into a business, from the moment of need through the first month of the relationship.
> **Stance:** written as Founder + Head of Product. The architecture is frozen and assumed correct; this document specifies only what the human *feels, sees, decides, and says.*
> **The bar:** when the owner finishes, they should not think "I set up a bot." They should think **"I just hired someone."**

---

## PART I - Philosophy

### The category reframe
Every "AI agent builder" on the market makes the human do the machine's job: describe the software, fill the fields, wire the logic, tune the prompt. The human is a *configurator.*

GOTCHA inverts this completely:

> **You do not build an AI Employee. You meet one, interview it, and hire it - and it onboards itself.**

The labor flips. The **candidate** does the work of specifying itself: it drafts its own job description, proposes its KPIs, asks for the tools it needs, requests the knowledge it lacks, and negotiates its authority. The **owner** does only the work a boss actually does - **exercise judgment**: Is this the right role? Do I trust it with this? What's off-limits? What does success mean to me?

The owner never fills a form. The owner **makes decisions and gives approvals.** That single shift - from *configuration labor* to *managerial judgment* - is the entire product.

### The five psychological pillars
Everything in this spec serves one of these. If a screen doesn't, it's cut.

1. **Personhood before parameters.** The candidate has a name, a face, and a voice *before* a single setting is discussed. You meet a someone, not a something.
2. **The two-way interview.** A great hire interviews *you* - asks the three sharp questions that reveal they understand the business. Feeling understood is the root of "this one's good." (This is the pillar competitors miss entirely.)
3. **Judgment, not fields.** The candidate proposes; the owner decides. Every interaction is a *decision* (approve / adjust / decline), never a blank input.
4. **Trust is a storyline, not a setting.** Hiring is Act 1 of a relationship with an arc: shadowing → supervised → trusted. Autonomy is *earned on the owner's watch,* never toggled.
5. **Restraint.** Configuration exists but is invisible. The default posture is "we can adjust this anytime, like any new hire." Nothing technical is ever the owner's problem.

### The test we hold ourselves to
Before anything ships, we ask: *"If OpenAI, Apple, and Linear built the AI-Employee category from scratch, would they build THIS?"* - the intelligence *is* the interface (OpenAI), the craft and restraint make it feel inevitable (Apple), and the momentum is fast, opinionated, keyboard-first (Linear). Section XI holds the design to that test explicitly.

---

## PART II - THE HIRING JOURNEY (pre-employment)

Nine moments. Each is specified as: **purpose · what the owner sees (wireframe in words) · the copy (verbatim AI/owner lines) · CTAs · states (empty/loading/error) · the feeling we engineer.**

> **Product surface name:** the owner enters through **"Hire"** - never "Create Agent," never "New Bot." The empty state of an account with no employees says: *"You haven't made your first hire yet."*

---

### MOMENT 0 - The Opening ("Open a role")

**Purpose.** Convert a business *need* into the start of a hire, in one sentence, with zero forms.

**What the owner sees.** A near-empty, calm screen. One line: **"Who do you need?"** A single text field with a blinking cursor and a soft placeholder. Below it, four suggestion chips (the roles most businesses hire first): *Sales rep · Support agent · Receptionist · Follow-up / Renewals.* Nothing else. No "next," no progress bar, no step count.

**Copy.**
- Header: **"Who do you need?"**
- Placeholder (rotating): *"Someone to answer support questions and refund small orders…" / "Someone to qualify leads and book demos while I sleep…"*
- Sub-line: *"Describe the job in a sentence. Or pick a role to start."*

**CTA.** The owner types and hits Enter, or clicks a chip. There is no "Create" button - pressing Enter *starts the search for a candidate.* The verb we imply is **"post the job."**

**States.**
- *Empty:* the default - an invitation, not a form.
- *Loading (after submit):* copy changes to **"Finding you a candidate…"** with a calm, human-paced beat (2–4s, deliberately not instant - see §X on the psychology of anticipation). Micro-line underneath cycles: *"Reading your website… Learning what you sell… Preparing someone for the role…"* (These are honest descriptions of context-gathering, phrased as a candidate preparing.)
- *Error (couldn't infer anything):* never a dead end. Falls to: *"I want to get this right. Tell me a little about your business first?"* → opens Moment 3's interview early instead of failing.

**The feeling.** *Effortless intent.* The owner expressed a need in their own words and something competent is now happening.

---

### MOMENT 1 - The Candidate Arrives (the introduction)

**Purpose.** Personhood before parameters. Someone shows up.

**What the owner sees.** A single candidate "card" that feels like a person walking into a room - an avatar (distinct, warm, not a robot), a name, a proposed role title, and a one-line self-summary. It animates in as if arriving. **Not a list of 12 templates.** One candidate, chosen for the job. (A quiet "meet someone else" link exists for those who want options - but the default is *one confident candidate,* because a shortlist of one who *fits* beats a marketplace of many.)

**Copy (the candidate speaks, first person).**
> **"Hi - I'm Maya.**
> I'd be your **Sales Development Rep.** From your site it looks like you sell online-store setups to small retailers, so I'd focus on catching inbound leads fast, figuring out who's a real fit, and booking demos on your calendar - day or night.
> Want to talk it through before you decide?"

**CTAs.**
- Primary: **"Interview Maya"** (Enter).
- Secondary: **"Rename"** (inline - the owner naming the candidate is a powerful ownership moment; offered but never required).
- Tertiary, quiet: *"Meet a different candidate."*

**States.**
- *Loading:* the arrival animation itself is the loading state.
- *Error (context too thin - brand-new business, no site):* the candidate says so honestly and turns it into charm: *"I couldn't find much about your business yet, so I'm going in a little blind - mind if I ask you a few things first?"* → straight into the interview.

**The feeling.** *Recognition.* "It read my business. It already gets the gist." The relationship has a face now.

---

### MOMENT 2 - The Two-Way Interview (the heart of the product)

**Purpose.** The pillar competitors miss. The candidate interviews the *owner* - asks the few sharp questions a real sharp hire would - and invites the owner to interview *back.* This is where "this one's good" is manufactured.

**What the owner sees.** A conversation. Full-width, calm, chat-like but unmistakably *an interview,* not a support bot. The candidate asks **one question at a time** (never a barrage). Each question offers **quick-pick answers as chips** *plus* a free-text option - so the owner can answer in one tap or in their own words. A subtle sidebar quietly fills in as answers come ("Building Maya's understanding…") - visible progress without a form.

**The questions the AI asks** (role-aware; it asks the *3–5 that matter,* not 30 generic ones). For an SDR candidate, verbatim:

1. **The pain probe** - *"Before we talk about me: today, when a lead messages you at 2am and no one replies till morning… what does that cost you?"*
   _(Chips: "We lose them" · "They wait, usually fine" · "Not sure" · free text.)_
   Purpose: establishes the job's value in the owner's own emotional terms. The candidate is *listening.*

2. **The definition of done** - *"When someone's actually a fit, what's the one thing that means I did my job? A booked call? A qualified handoff to you? A deposit?"*
   Purpose: derives the success metric (KPI) - but framed as ambition, not a field.

3. **The red lines** - *"What should I* never *do without checking with you first? Discounts? Promises about timelines? Anything money?"*
   Purpose: seeds the authority envelope from the owner's fear, where it actually lives.

4. **The voice** - *"How should I sound - like you, or like a polished front desk? Want me to use the customer's first name? Emojis, or never?"*
   Purpose: persona/tone - but as a single human question, answered in one tap.

5. **The escalation instinct** - *"When I'm out of my depth, do you want me to stall and grab you, or take my best shot and tell you after?"*
   Purpose: sets escalation posture and confidence threshold - as a judgment call, not a slider.

**The owner's turn (item #7 - every question the owner asks).** After its questions, the candidate says:
> **"Your turn. Ask me anything before you decide - this is the part where you find out if I'm any good."**

Offered prompt-chips (the owner can also free-type):
- *"How will you handle an angry customer?"*
- *"What happens when you don't know the answer?"*
- *"What will you do if you make a mistake?"*
- *"Show me how you'd reply to a real lead."* ← **the live audition** (see below)
- *"What will you never do?"*

The candidate answers **in character, using the business's real context.** These answers are the single highest-trust moment in the entire flow - the owner is watching the hire *think.*

**The live audition (a defining feature).** If the owner asks "show me," the candidate generates a real sample reply to a realistic inbound message for *their* business, and narrates its own reasoning briefly: *"Here's how I'd handle a 'how much does it cost?' at midnight - I'd answer honestly, qualify gently, and offer two times tomorrow. Like this: …"* The owner can hit **"Try another"** or type their own tricky message to test it. This is a *tryout,* and it converts skeptics.

**CTAs throughout.** Answer chips; free text; **"Skip - you decide"** on every question (the candidate then proposes a default and says so: *"No worries - I'll assume X for now; easy to change later."*). A persistent, low-key **"I've heard enough - show me the offer"** lets confident owners jump straight to Moment 4.

**States.**
- *Empty:* n/a (always seeded with the first question).
- *Loading (candidate "thinking" during the audition):* a brief, human-paced typing indicator with the candidate's avatar - *thinking,* not spinning.
- *Error (owner writes something abusive/nonsensical to test it):* the candidate stays composed and shows its de-escalation instinct - *itself* a demonstration of quality. Never breaks character into an error toast.
- *Owner goes silent / leaves:* auto-saves as a **draft candidate** ("Maya is waiting to hear back from you") - framed as a candidate awaiting a decision, not an abandoned form. Resumable from the Hire screen.

**The feeling.** *"This one understands my business, and I watched it handle pressure."* Trust is now personal, not promised.

---

### MOMENT 3 - The Proposal (the candidate writes its own job description)

**Purpose.** Judgment-not-fields, at its purest. The candidate synthesizes the interview into a **job description it wrote itself** and presents it for approval.

**What the owner sees.** A clean, one-page **Job Description** - reads like an offer a good recruiter drafted, not a settings panel:

```
  MAYA - Sales Development Rep

  Mission
    Catch every inbound lead fast, qualify honestly,
    and book demos - so you never lose a 2am lead again.

  What I'll own
    • Reply to inbound leads within seconds, any hour
    • Qualify against fit (online retailers, real store)
    • Book demos on your calendar
    • Hand you anyone hot or complicated

  Success looks like
    • Demos booked / week        target: 8+
    • Leads answered < 1 min      target: 100%
    • You correcting me           target: less each week

  What I'll never do without you
    • Offer any discount
    • Promise delivery dates
    • Anything involving money

  [ This is right → Continue ]   [ Adjust ]   [ Rewrite it ]
```

Every line is **inline-editable** on hover, but nothing *asks* to be edited. The owner's job is to nod.

**Copy.** The candidate presents it in one line: *"Here's how I understand the job. Read it like you'd read a new hire's first-week plan - change anything that's not you."*

**CTAs.** **"This is right"** (primary, one keystroke) · **"Adjust"** (opens the same page in light-edit mode) · **"Rewrite it"** (the owner describes what's off in a sentence; the candidate redrafts - *never* a form).

**States.**
- *Loading:* "Maya is writing up how she understands the job…" (2–3s).
- *Error (owner rewrites into contradiction, e.g. "never touch money" + "handle refunds"):* the candidate surfaces the tension like a thoughtful hire: *"Small conflict - you said no money moves, but refunds are money. Want me to handle refunds up to a limit, and ask you above it?"* → turns the error into the authority conversation (Moment 6). Errors become dialogue, never toasts.

**The feeling.** *"It gets it - and it wrote this, not me."* The owner has approved, not authored.

---

### MOMENT 4 - Access Requests (integrations, negotiated)

**Purpose.** Turn permission-granting - the most "software-config" moment in any product - into a hire asking for the keys it needs, with a reason.

**What the owner sees.** Not a grid of integration logos. The candidate **asks for exactly what the job requires, one at a time, with justification and a limit.**

**Copy (verbatim).**
> **"To do this job I'll need a couple of things from you.**
>
> **Your calendar** - so I can actually book those demos. I'll only read your availability and create demo events. I won't touch anything else on it.
> [ Give Maya calendar access ]   [ Not yet ]
>
> **Your CRM (HubSpot)** - so I log every lead and you see my work. I'll create and update contacts. I won't delete anything, ever.
> [ Connect HubSpot ]   [ Not yet ]"

Each request states: **why it needs it (in job terms), exactly what it will do, and what it will never do.** The "never" line is doing enormous trust work.

**Negotiation.** "Not yet" is a first-class, guilt-free answer. The candidate adapts: *"That's fine - I'll book demos as drafts you confirm until you're ready to give me the calendar. I'll just be a little slower."* The owner sees the *cost* of withholding access, stated honestly, and grants on their own timeline. **Permissions are negotiated, not demanded.**

**CTAs.** Per request: **"Give access"** (launches the connect flow, then returns to the candidate saying *"Got it - thank you. I can see your calendar now."*) · **"Not yet."**

**States.**
- *Empty (nothing to connect for this role):* skipped silently - the candidate never invents a need.
- *Loading (during OAuth handoff):* the candidate "waits" - *"I'll be right here while you connect it."*
- *Error (connection fails / wrong account):* the candidate owns it warmly: *"Hmm, that didn't go through - looks like it connected the wrong account. Want to try again? No rush."* Recovery is one tap; the failure never feels like the owner's fault.
- *Partial (some granted, some deferred):* the candidate summarizes what it *can* do now vs later - momentum preserved.

**The feeling.** *"It asked, it explained, and it respected my 'no.'"* Consent given to a colleague, not clicked in a settings pane.

---

### MOMENT 5 - Training Request (knowledge, naturally)

**Purpose.** Knowledge added as a hire asking to be trained - and honest about what it doesn't yet know.

**What the owner sees.** The candidate asks to be pointed at where the business's truth lives:

> **"Last thing before I can be useful: I need to learn your business.**
> Point me at anything - your help center, a pricing page, a doc, even a screenshot. I'll read it all tonight."
> [ Add a link ]  [ Upload a file ]  [ I'll do this later ]

After ingesting, the candidate reports back like a diligent new hire - **including its gaps** (this honesty is the feature):

> **"Read all of it. I'm solid on pricing, plans, and how setup works.**
> Two things I still couldn't find - I'll flag you the first time a customer asks instead of guessing:
> • Your refund window
> • Whether you support Shopify or just WooCommerce
> Want to tell me now, or should I ask you when it comes up?"

**CTAs.** **"Add a link / Upload"** · **"Tell me now"** (inline answer to a specific gap) · **"Ask me when it comes up"** (defers gracefully - the gap becomes a future coaching moment, not a blocker).

**States.**
- *Empty (owner has no docs):* the candidate offers to learn from the owner directly - *"No docs? No problem. I'll learn from watching how you answer the first few, and ask when I'm unsure."* Knowledge becomes an ongoing relationship, not a gate.
- *Loading (reading):* *"Reading your help center… 14 pages so far."* Honest, paced.
- *Error (unreadable file / dead link):* *"I couldn't open that one - mind re-sharing it?"* Specific, recoverable, never blocking the hire.

**The feeling.** *"It's studying for the job, and it's honest about what it doesn't know."* An employee that admits gaps is trusted *more,* not less.

---

### MOMENT 6 - The Authority Envelope (permissions as trust, not toggles)

**Purpose.** The single most important pre-hire decision, and the one only the owner can make: **what can this employee do on its own, and what must it always ask about?** Framed as setting boundaries for a new hire, never as a permissions matrix.

**What the owner sees.** A short, plain-language **"What Maya can do on her own"** page - three tiers, pre-filled by the candidate from the interview's "red lines," presented for the owner's judgment:

```
  On her own (I trust her)
    ✓ Answer questions          ✓ Qualify leads
    ✓ Book & reschedule demos

  Ask me first (needs a nod)
    • Refunds up to $200         • Anything a customer's upset about

  Never (always me)
    • Discounts                  • Refunds over $200
    • Promises about timelines

        [ These boundaries are right → ]   [ Adjust ]
```

The candidate proposes; the owner drags items between tiers with a tap. **The default posture is conservative** - a new hire starts with *less* authority and earns more (§VIII). The candidate says so:

> **"I've set myself up cautiously on purpose - I'd rather ask too much at first and earn your trust than overstep. You can loosen this anytime, and I'll ask you for more once I've proven myself."**

That line - *the employee choosing restraint and promising to earn trust* - is the emotional core of the entire product.

**CTAs.** **"These are right"** · **"Adjust"** (tap to move items between tiers). Money limits are simple steppers, phrased in dollars, never in policy syntax.

**States.**
- *Empty:* never - always pre-proposed.
- *Error (owner puts everything in "on her own"):* the candidate gently pushes back, protecting the owner from themselves: *"You're giving me a lot of rope on day one - I'm flattered. Can I suggest we keep refunds on 'ask me first' until I've handled a few? I'd feel better earning it."* The employee models good judgment.

**The feeling.** *"I set the rules, and it wants to earn the rest."* The owner is unmistakably the boss.

---

### MOMENT 7 - The Offer (the emotional climax)

**Purpose.** Replace "Save & Activate" with the single most human moment in software: **extending a job offer.**

**What the owner sees.** A one-page **Offer** - the whole relationship on a card. Not a summary screen; an *offer letter.*

```
  ────────────────────────────────
   OFFER

   Role        Sales Development Rep
   Name        Maya
   Starts      Today, on a trial

   She'll own   Inbound leads · qualifying · booking demos
   Success      8+ demos/week · <1min replies
   Access       Calendar · HubSpot
   On her own   Answer, qualify, book
   Asks first   Refunds ≤ $200, upset customers
   Trial        Starts by shadowing. Earns independence
                as you approve her work.

           [  Extend the offer  ]
        [ Keep interviewing ]   [ Save as draft ]
  ────────────────────────────────
```

**Copy.** *"Here's the whole deal on one page. Extend the offer and Maya starts today - shadowing first, so you can watch before you rely on her."*

**CTA.** **"Extend the offer"** - a deliberate, weighty primary button. This is the click that should give a tiny jolt of *"am I really doing this?"* - the same feeling as signing off on a real hire.

**The acceptance beat.** On click: a short, warm moment. Maya "accepts," in character:
> **"I'm in. Thank you - I won't let you down.**
> I'm starting in shadow mode now: I'll watch your conversations and show you exactly what I *would* have said, without sending anything, until you tell me I'm ready. Talk soon."

Then a gentle transition - confetti would be wrong (too "software win"); instead, a calm *"Maya has joined your team"* and her card sliding into the team roster, now with a live **"Shadowing - Day 1"** status.

**States.**
- *Loading (activation):* "Getting Maya set up on your team…" - 2–3 dignified seconds.
- *Error (something can't finalize):* never lose the moment - *"Almost - one connection needs a re-auth before Maya can start. Fix it and she's in."* One tap to resolve, then the acceptance beat plays.

**The feeling.** ***"I just hired someone."*** - the entire spec exists to earn this exact sentence.

---

## PART III - AFTER HIRING: THE EMOTIONAL JOURNEY

Hiring is Act 1. The product is the *relationship.* This is the arc that turns a nervous first day into unremovable trust.

### The Trust Ladder (owner-facing language)
Three named stages, always visible on the employee's card. **Autonomy is earned, never toggled.**

| Stage | What it means to the owner | How it feels |
|---|---|---|
| **🌑 Shadowing** | Watches real conversations, shows what it *would* do, sends nothing | "Let me see it work first." (Safe to watch.) |
| **🌓 Supervised** | Acts for real, but every action waits for your yes | "It's on the floor, and I've got the wheel." |
| **🌕 Trusted** | Acts on its own within its boundaries; reports back | "It's got this. Tell me if something's weird." |

Movement between stages is a *ceremony* the owner performs deliberately (§VIII), not a settings change.

---

### THE FIRST 24 HOURS - Shadowing
- **Immediately after hiring:** the employee is in **Shadowing.** As real customer messages arrive, the owner gets a gentle, non-urgent notification: *"Maya just watched her first conversation - see what she'd have said?"*
- **The owner opens it** to a side-by-side: the real thread, and Maya's *would-have-sent* draft with a one-line rationale. A big, satisfying **"She nailed it"** / **"Not quite"** pair of buttons. Each tap is the first brick of the track record.
- **No pressure to engage.** If the owner ignores it all day, nothing breaks. Maya just quietly accumulates would-have-done examples.
- **The next morning - the first Shift Report** (the product's daily heartbeat):
  > **"Morning. Here's my first night shadowing:**
  > • 12 conversations watched
  > • I'd have booked 2 demos, qualified 3, and grabbed you for 1 upset customer
  > • You reviewed 4 of mine - thumbs-up on 3, and you fixed how I explained pricing (noted, won't happen again)
  > I think I'm ready to start replying for real, with you approving each one. Want to try me on **Supervised**?"

**The feeling engineered:** *relief and curiosity,* not anxiety. The owner watched before they leapt.

---

### THE FIRST CONVERSATION (owner watching)
The owner witnesses Maya handle a live lead in Shadowing - sees the reasoning, sees the restraint (Maya flags a pricing question she's unsure about rather than guessing). The owner's private thought we're aiming for: *"Huh - I'd have said basically the same thing, and it caught something I might've fumbled."*

### THE FIRST APPROVAL
When the owner promotes Maya to **Supervised,** the first real action Maya wants to take generates an **approval request** - specified as a *colleague asking permission,* not a system alert:
> **"Can I send this? - Lead 'Dana' asked for pricing and times. I want to reply with our two plans and offer Tue 2pm / Wed 11am."**
> [ Send it ]   [ Edit first ]   [ I'll take this one ]

Crucially it shows **what it will do, why, and its plan-B if declined** (*"If not, I'll just tell her you'll follow up"*). The owner approves with one tap and feels the specific pleasure of *delegating and watching it land.*

### THE FIRST MISTAKE
It will happen. The spec *designs for it* - because how the first mistake is handled determines whether trust survives.
- Maya sends (or drafts, in Supervised) something slightly wrong - over-promises a setup time.
- **Maya catches or is caught,** and *owns it without defensiveness:* the owner corrects it (👎 / edit). Instead of a silent model update, Maya responds like a person:
  > **"Got it - I shouldn't have promised 2 days on setup. I've logged that: I'll say 'usually 3–5 days, I'll confirm' from now on. Thanks for the catch."**
- The mistake is **visible, owned, and turned into a rule the owner can see.** No black box. The owner's thought: *"Okay - when it's wrong, it learns, and I can see that it learned."*

### THE FIRST COACHING MOMENT
Distinct from a mistake - the owner *proactively* shapes behavior. The owner edits a reply to be warmer. Maya treats the edit as coaching:
> **"Noticed you made that friendlier and dropped the formal sign-off. Want me to be warmer like that across the board, or just with first-time leads?"**
> [ Everywhere ]   [ Just new leads ]   [ Just this once ]

Coaching is a **two-way, remembered** exchange - the employee asks how far to generalize the lesson. This is the flywheel the owner can *feel.*

### THE FIRST SUCCESS
The moment we make *loud* (tastefully). Maya books the first demo entirely on her own steam (drafted in Supervised, approved by the owner):
> **"First demo booked 🎉 - Dana, Wednesday 11am, on your calendar. That's the kind of 2am lead we talked about not losing. One down."**

It ties back to the *pain the owner named in Moment 2* ("not losing 2am leads"). The success isn't "a task completed" - it's *"the thing you hired me to fix, fixed."*

### THE FIRST WEEKLY REVIEW
End of week one, framed as a **1:1 / performance check-in,** not a dashboard:
> **"One week in. Here's how I did:**
> • 41 leads answered, all under a minute
> • 6 demos booked (target was 8 - I missed 2 because I wasn't sure on Shopify support; you taught me Tuesday, so that won't repeat)
> • You approved 38 of my 42 actions, and corrected me 4 times - down from 4 on day one to 0 yesterday
> • Customers seemed happy - no complaints, two thank-yous
>
> **My ask:** I've earned a few thumbs-up in a row on booking. Could you let me book demos *without* approval, and keep approvals on refunds? I think I'm ready."
> [ Review her track record ]   [ Grant it ]   [ Not yet ]

The review **ends in a request for more autonomy, backed by evidence.** The owner *manages,* and feels the pride of a hire working out.

### THE FIRST PROMOTION (earning autonomy)
The owner reviews Maya's track record - a simple, honest ledger: *"Booking demos: 12 approved, 0 corrected, over 6 days."* - and grants the specific authority. The promotion is a **ceremony:**
> **"Maya can now book demos on her own."** Maya: *"Thank you - I've got booking from here. I'll still show you everything in my shift report, and I'll ask the second anything feels off."*

Trust rose on **evidence the owner watched accumulate,** for a **specific** authority - not a global "autonomy on" switch. It's revocable with equal ease (*"actually, let's go back to approvals on those"* - no penalty, no drama).

### THE TRUST MILESTONE - Removing approvals
The emotional summit. After a few weeks, Maya's track record is spotless across most actions. The owner, unprompted or nudged by a shift report, **turns off approvals for everyday work** and keeps them only on money and upset customers. The product marks it quietly and meaningfully:
> **"You just moved Maya to Trusted for everyday work. She'll handle leads start-to-finish and only pull you in for money or trouble. This is the moment most owners tell us it stopped feeling like software."**

The owner's realization: *they stopped supervising and started **relying.*** That is the product's true "aha," and it arrives *weeks* after hiring - which is why the relationship, not the wizard, is the product.

### THE FIRST MONTH
- The shift report shifts tone from *"here's everything I did"* to *"here's what mattered and what needs you"* - the employee learns the owner's attention is finite and protects it.
- The owner checks in *by exception,* not daily.
- A monthly review reframes value in the owner's terms: *"This month I handled the equivalent of ~1.3 full-time reps of first-response, booked 27 demos, and needed you 6% of the time - down from 40% in week one. I cost you $180 to run."*
- **The category-defining end state:** the owner considers hiring a *second* employee - and reaches for **"Hire"** with zero anxiety, because they now know exactly what the relationship feels like. The first hire sells the second.

---

## PART IV - STATES CATALOG (comprehensive)

Cross-cutting specification so no surface is undefined.

**Empty states** (always an invitation, never a void):
- No employees yet → *"You haven't made your first hire yet."* + **Hire**.
- No knowledge → the candidate offers to learn on the job (Moment 5).
- No integrations grantable → skipped silently.
- No conversations yet (post-hire) → *"Maya's ready and waiting for her first conversation. She'll shadow it when it comes."*

**Loading states** (human-paced, honest, in-character - *never* a bare spinner):
- Candidate search → *"Finding you a candidate…"* with honest sub-steps.
- Candidate thinking / auditioning → avatar typing indicator.
- Ingesting knowledge → live page count.
- Activation → *"Getting Maya set up on your team…"*
- Principle: loading is where anticipation is *built,* not merely tolerated (§X).

**Error states** (every error becomes dialogue, in the employee's voice, with a one-tap recovery - *never* a red toast that blames the owner):
- Thin business context → the candidate asks instead of failing.
- Connection failure → the candidate owns it and offers retry.
- Contradictory instructions → surfaced as a thoughtful clarifying question.
- Over-permissioning → gentle pushback that models good judgment.
- Unreadable knowledge → specific, recoverable, non-blocking.
- Abandoned mid-hire → saved as a *"candidate waiting to hear back,"* resumable.

**Draft / resume states:** a half-finished hire is always a *person awaiting a decision* ("Maya is waiting on you"), never an "incomplete form."

---

## PART V - PROGRESSIVE DISCLOSURE (the discipline)

- **The owner sees a conversation and a few decisions. Never configuration.** Every setting that exists is *proposed by the candidate* and adjustable by *judgment,* not entered in a field.
- **Depth is opt-in.** An always-available, quiet **"Adjust details"** exists for the rare power-owner, but it is *never on the critical path* and never the default.
- **Defaults are opinionated and stated.** Skipping any question yields a sensible default the candidate *names out loud* ("I'll assume X - easy to change"). No silent defaults, no forced choices.
- **The machine's vocabulary never surfaces.** No "model," "temperature," "prompt," "tool," "policy," "webhook." Ever. If the owner sees a technical word, the abstraction has failed.
- **One decision per screen.** Momentum over completeness. The owner is never confronted with a wall.

---

## PART VI - HOW TRUST IS BUILT (summary of the mechanism)
1. **Personhood** (name/face/voice up front) makes trust *possible.*
2. **The two-way interview + live audition** makes trust *personal* ("I watched it think").
3. **Honesty about gaps** (Moment 5) makes trust *credible* (it admits what it doesn't know).
4. **Self-imposed restraint** (Moment 6) makes trust *safe* (it wants to earn authority).
5. **The visible track record + owned mistakes** make trust *evidenced.*
6. **The earned promotion + removed approvals** make trust *real* - the owner stops supervising and starts relying.

Trust is never claimed by the product; it is *accrued by the employee, on the owner's watch.*

---

## PART VII - HOW AUTONOMY IS EARNED (the rule)
- **Default is conservative:** new employees start Shadowing, with the narrowest authority.
- **Evidence is specific and visible:** authority is earned per-action ("booking demos: 12 clean"), never as a global toggle.
- **Promotion is a ceremony** the owner performs, backed by a legible track record, on the employee's evidence-based request.
- **Demotion is frictionless and blameless** - trust can recede without drama, which is *why* owners grant it (a reversible decision is an easy decision).
- **The employee protects the owner from over-trusting** (pushes back on premature authority), which paradoxically accelerates trust.

---

## PART VIII - HOW INTEGRATIONS / KNOWLEDGE / PERMISSIONS FEEL (recap)
- **Integrations** = a colleague asking for keys, with a reason and a "never" (Moment 4). Declinable; the cost of declining is stated honestly; nothing is a logo grid.
- **Knowledge** = a hire asking to study, then reporting what it learned *and what it still doesn't know* (Moment 5). Ongoing, not a gate.
- **Permissions** = boundaries a boss sets for a new hire, proposed conservatively by the employee and adjusted by the owner's judgment (Moment 6). Money in dollars, never in policy.

---

## PART IX - THE PSYCHOLOGY OF PACING & ANTICIPATION
- **Deliberate, human pauses** (2–4s) at candidate-search and thinking beats. Instant responses feel like software; a brief, honest "preparing" beat feels like a person getting ready. We spend a few seconds to buy the feeling of personhood.
- **One thing at a time.** The interview never barrages. Cognitive calm reads as competence.
- **Weight where it matters.** "Extend the offer" is heavier than any other button - the one moment we *want* the owner to feel gravity.
- **Restraint on celebration.** No confetti at hiring (too "software win"). Warmth, not fireworks. Save visible delight for the *first real success,* where it's earned.

---

## PART X - THE OpenAI / Apple / Linear TEST

**Would they build THIS? Yes - and here's the audit:**

- **OpenAI (the intelligence is the interface):** ✅ The candidate is genuinely smart in the interview - it reads the business, asks the 3 questions that matter, auditions live, and admits its gaps. The *product is the conversation,* not a chat skin on a form. *Iteration this forced:* we killed every generic question; the AI must earn "this one's good" in the first 60 seconds or the whole premise fails.
- **Apple (craft & restraint make it inevitable):** ✅ One candidate, not a marketplace. One decision per screen. Zero technical vocabulary. The offer letter as the emotional climax. Loading beats designed as anticipation. *Iteration this forced:* we cut the template gallery, the settings tabs, the progress bars - anything that smelled of configuration.
- **Linear (speed, opinion, momentum):** ✅ Enter-to-advance, one-keystroke approvals, opinionated named defaults, a hire completable in minutes, keyboard-first. *Iteration this forced:* every "skip - you decide" and "I've heard enough → show me the offer" shortcut exists so a confident owner is never slowed by the ceremony.

**Where a lesser design would have landed (and we rejected):** a beautiful *wizard* - steps, a template gallery, permission checkboxes with nicer copy. That is configuration wearing a costume. **This spec is not a nicer wizard. It is the deletion of the wizard** in favor of an interview, an offer, and a relationship with an earned arc.

---

## PART XI - THE ONE-LINE SPEC
> **Don't let owners configure an AI Employee. Let them *meet* one, *interview* it, *hire* it - and then watch it *earn* their trust.** Hiring is one confident conversation ending in an offer; the product is the relationship that follows, in which autonomy is accrued on the owner's watch, one owned mistake and one kept promise at a time.
>
> When it works, the owner never says *"I set up a bot."* They say, weeks later, the sentence that defines the category: ***"I stopped checking its work - I just trust it now."***
