# Onboarding Pass II - Wonder & Confidence (the craft layer)

> **Type:** Founder + CPO + Principal-UX pass. The *craft-and-trust* companion to `onboarding-experience-bible.md` (the philosophy) and `onboarding-product-review.md` (the diagnosis). The Bible defined *what the customer should feel*. This document defines *how the surface must behave to actually make them feel it* - after walking the built flow end-to-end and finding it still reads as a form.
> **Premise:** the seven movements, the discovery engine, and the AI Employee are built. Nothing here adds a feature or touches the architecture. This is entirely about **taste, pacing, hierarchy, honesty, and language** - turning a working funnel into an experience.
> **The bar:** after the first minute the customer says out loud -
>
> ## **"It actually researched my company."**
>
> - not *"I filled out a form."*

---

## PART 0 - The two things we are now optimizing for

We stopped optimizing for *forms*. We now optimize for exactly two feelings, in this order:

1. **Wonder** - *"something intelligent is happening… it actually knows my stack."*
2. **Confidence** - and this cuts both ways: the customer's confidence in the product, and the product's *calibrated honesty* about its own findings.

Everything below serves one or both. If a screen produces neither, it is a form, and it is wrong.

### The governing question (print it above every screen)

> **Every screen answers: "What did the AI just learn about my business?"**
> **Never: "What information do you want me to enter?"**

The AI does the work. The human only **validates or corrects**. The instant a screen makes the human do the machine's job, the illusion - and the category - collapses.

---

## PART I - The Confidence Doctrine (the most important change in this pass)

> *בעולם של AI, אמינות חשובה יותר מלהיראות "יודע הכול".* **In an AI product, credibility beats appearing omniscient.** A machine that admits what it isn't sure of is believed about everything else. A machine that confidently states one falsehood is believed about nothing - and it happens in the first ten seconds, exactly where we cannot afford it.

This is the spine of the entire pass. It is not a UI decoration; it is a law that governs the crawler, the model, and every pixel.

### 1 · Every finding is a claim with a confidence, never a bare fact

There are no naked assertions. Every discovered item - Shopify, WhatsApp, brand voice, a returns policy - carries a confidence level, surfaced quietly but always:

| Level | Meaning | Voice |
|---|---|---|
| **Confirmed** | Directly observed, unambiguous | *"You're on Shopify."* |
| **Likely** | Strong signal, minor ambiguity | *"Looks like your support runs on WhatsApp."* |
| **Low confidence** | Weak/indirect signal | *"I *think* I saw a returns policy - worth a look."* |
| **Needs verification** | Found something, can't trust it | *"I found shipping info in three places that disagree."* |
| **Couldn't determine** | Genuinely absent from what I could read | *"I couldn't confidently find your refund policy."* |

### 2 · The cardinal sin: the confident false negative

> **"It doesn't exist"** is forbidden unless we are certain. The honest form is **"I couldn't confidently determine…"**

On `strongful.co.il` the engine reported *missing* a returns policy, a customer-service email, a phone number, Terms & Conditions, and WhatsApp - **all of which exist.** Five false negatives in one briefing is not a bug; it is a **trust extinction event.** The customer's takeaway is not "it missed a few things" - it is *"it doesn't actually know my business, this is theater."* Everything downstream inherits that verdict.

The rule: **a false "missing" is far more expensive than an honest "unsure."** When in doubt, downgrade to *"couldn't confidently determine"* and invite the customer to point us at it - which converts our uncertainty into a *teach-me moment* (Part IV) instead of a lie.

### 3 · Confidence must reason about *time and role*, not just pattern-match

The `Magento` finding is the tell. It was surfaced because an old tag or artifact matched a regex - while **Shopify is plainly the live platform.** Detection must distinguish:

- **Current platform** (what the store actually runs on now) - high confidence, shown proudly.
- **Legacy remnants** (an old migration's leftover tag) - demoted or hidden.
- **Tracking / analytics scripts** (GA, Meta Pixel) - categorized as *tracking*, never as *the platform*.
- **Third-party embeds** (a chat widget, a review app) - categorized as *tools*, not *stack*.

Confidence is how this reasoning becomes visible. A low-confidence, single-artifact signal never gets to sit next to a confirmed one as an equal. **Presence of a string ≠ presence of a fact.**

### 4 · The engineering mandate this implies (product requirement, not a code task here)

The briefing can only be as honest as the crawl is thorough. Today it reads too little and concludes too much. The requirement:

- **Read past the homepage** - follow the footer nav, `/policies`, `/pages/*`, the contact page, help center. Most of the "missing" items on Strongful live in the footer.
- **Detect the obvious channels** - `mailto:`, `tel:`, `wa.me`/`api.whatsapp.com`, social links - before ever concluding they're absent.
- **Tie every conclusion to evidence** - a finding without a source it can point to is downgraded, not asserted.
- **Prefer recall of *uncertainty* over precision of *claims*** - it is better to say "unsure about 4 things" than to be wrong about 1.

> **This is the single highest-leverage fix in the entire pass.** The most beautiful briefing in the world is worthless if its facts are wrong. Depth-and-honesty of discovery is the foundation everything visual sits on.

---

## PART II - Movement 1 becomes a Ceremony (the discovery moment)

The current scan looks like *"the form is loading."* It must become *"a mind is coming online."*

### The prescription

- **Freeze the onboarding.** During discovery there are **no editable fields, no card to poke at.** The customer's only job is to watch. Editing anything now breaks the spell and invites them to do work before the AI has done its.
- **Full-screen.** Not a spinner in a narrow card. The scan owns the whole surface - this is the most important ten seconds in the product; give it the room it deserves.
- **Narrate comprehension, not bytes.** A vertical sequence of steps that *resolve one by one*, each landing with a satisfying check as the AI genuinely completes that domain:

  > ✓ Reading your website
  > ✓ Understanding your products
  > ✓ Learning your brand voice
  > ✓ Finding your communication channels
  > ✓ Detecting your technology
  > ✓ Looking for your policies
  > ✓ Preparing your first AI Employee

- **Make it real, not a loop.** Where a fact is already resolved, surface it live inside the ceremony - *"Found 126 products," "Detected Shopify," "Two languages: Hebrew & English."* A real fact appearing mid-scan is the difference between a progress theatre and a demonstration. It is the first "how did it know that?"
- **Deliberate, premium pacing.** Instant reads as a database lookup; a paced, narrated reveal reads as thought. We spend a few honest seconds *on purpose* to buy the feeling of intelligence at work. (Never fake-slow beyond what feels alive.)
- **Land into the briefing.** The ceremony doesn't end in a blank form - it *becomes* the executive briefing (Part III), as if the analyst finished researching and turned to face you.

**The feeling to engineer:** *"Something intelligent is happening."* If the customer's eyes are on a spinner, we failed. Their eyes should be on an intelligence **reading their business in front of them.**

---

## PART III - Screen 1 is an Executive Briefing, not a database record

This is the most important screen in the product, and today it is the most form-like. The reframe is total.

### Reading comes first. Editing comes second.

> The first screen should feel like **reading a briefing an analyst prepared after spending an hour on your company** - not reviewing a CRM record with every field pre-focused for editing.

- It **opens as prose + structured cards the customer reads.** First-person, confident where earned, honest where not. No blinking cursors, no grid of inputs, no "required" asterisks greeting them.
- **Editing is a deliberate, secondary gesture** - revealed on intent (a quiet "Correct" affordance / hover pencil), never the default posture. You *read*, you *nod*, and only if something's off do you touch it. Correcting must feel like *notes in a margin*, not *filling a form*.

### The layout language: Notion / Linear / Granola / Cursor / Apple

Kill the narrow, static, admin feeling. Adopt:

- **Wide canvas, generous whitespace, real breathing room.** The content is a document to be read, not a panel to be processed.
- **Strong visual hierarchy** - an executive summary at the top, then sections that descend in importance. The eye is *guided*, not confronted with a wall of equal fields.
- **Progressive disclosure & expandable sections.** Show the headline understanding; let the customer *expand* into detail (all 126 products, the full brand-voice profile) only if they want it. Calm surface, depth on demand.
- **Confidence rendered as a quiet signal** - a subtle chip/tint per finding, present everywhere but never noisy. Confidence is ambient, not an alarm.

### The sections of the briefing

**1 · Executive summary (first person).** *"Here's what I learned about {company}."* Two or three sentences of genuine synthesis - specific, non-obvious, honest about the edges. This is the paragraph that earns the whole screen.

**2 · Communication channels - visual, not raw text.** Never a comma-separated string. Present each detected channel as a **card with its official icon**, the **detected handle/URL**, its **probable purpose**, and a **confidence**:

  > 🟢 **WhatsApp** - `wa.me/…` - *probably Customer Support* · Likely
  > 📸 **Instagram** - `@brand` - *probably Sales / brand* · Confirmed
  > ✉️ **Email** - `hello@…` - *General inquiries* · Confirmed
  > 💬 **Website chat** - *Lead generation* · Low confidence

  These same cards become the natural home of **"Connect this channel"** later - discovery and activation are the same object, seen twice.

**3 · Technology - shown with pride.** When Shopify is the platform, show **the Shopify logo, a badge, and a confidence** - *"You're on Shopify · Confirmed."* The customer should think *"wow, it knows my stack."* Legacy/tracking/embeds are **demoted** into a quiet "also detected" area with their honest (low) confidence, never paraded next to the real platform. Proud about what's certain; humble about what isn't.

**4 · Brand voice - the missing asset, now load-bearing.** This is one of the strongest inputs an AI Employee has, and it's absent today. The briefing must present the brand as a *personality it can adopt*:

  > **Personality · Tone · Writing style · Audience · Forbidden words · Preferred terminology · Call-to-action style · Languages**

  Framed as *"this is how I'll sound as your business"* - the difference between an employee who trained here and a bot bolted on. Each attribute carries a confidence; low-confidence traits invite a one-tap confirm.

**5 · Products & knowledge.** Counts and categories, expandable - *"126 products across 8 categories," "a help center with 34 articles."* Specific numbers are what trigger *"how did it know that?"*

**Every card, everywhere, carries its confidence.** That single discipline is what turns a "database record" into "a briefing by someone who did the homework and is honest about it."

---

## PART IV - Screen 2 is an AI briefing that *teaches*, not a checklist

Business Health today lists what's missing. That's still a form wearing a health costume. The reframe: a colleague taking stock of their own first day and **asking to be taught**, with the value made tangible.

### Every gap is actionable *in place*

A missing item is never a dead red mark. It is an invitation with the tools to resolve it inline:

  > **Refund policy** - *I couldn't confidently find this.*
  >   → **Provide a URL** · **Upload a document** · **Paste the text**
  >   *"Give me any one and I'll learn it immediately."*

Teaching a colleague, not filling a form. Note the honest framing - *"couldn't confidently find"* (Part I), never *"you don't have one."*

### Make the value tangible - show what it unlocks

Each gap states, concretely, what closing it *enables*:

  > *"Once I know your refund policy, I'll be able to answer questions like:*
  >   *- 'Can I return this after 30 days?'*
  >   *- 'How long until I get my money back?'"*

Now the customer isn't doing a chore - they're watching a capability switch on. The gap is a *promise of value*, not a nag.

**The feeling:** *served by a colleague taking honest stock of their own readiness* - not audited by a config wizard.

---

## PART V - Screen 3: Recommendations that *evolve* as the AI learns

Recommendations must feel like a consultant whose advice deepens as they see more - not a static list printed once.

### Act on what you already know, first

If Shopify is **already detected**, the first recommendation is not "consider a CRM." It is **"Connect Shopify"** - act on the strongest thing we already know, before proposing anything new. Recommending systems we *haven't* detected while ignoring the one we *have* reads as not paying attention.

### Then inspect, then deepen

The moment Shopify connects, the AI **inspects the store** and returns a *second wave* of recommendations grounded in what it now sees - *ReturnGO, Orion, YDM, a CRM, a reviews platform, shipping providers,* each tied to an actual observation about their store. Recommendations are a **living conversation that gets smarter with every connection**, not a menu. Each carries a reason and a confidence, like everything else.

---

## PART VI - Respect the UI language, absolutely

If the application is in **Hebrew, 100% of what the customer sees is Hebrew** - RTL layout, correct typography, no English leaking into a label, a chip, a confidence level, or a channel purpose. We may store everything in English internally; we **present in the user's language, always.**

This is not a translation chore - it is part of the wonder. An intelligence that briefs you *in your own language* reinforces *"it understands me."* A mixed-language screen does the opposite: it exposes the machinery and breaks the spell. **No mixed-language surfaces, ever.**

---

## PART VII - The onboarding emails become an extension of the product

The emails today feel transactional. They must feel like the product reached out.

- **Premium SaaS craft:** full-width, modern layout, beautiful typography, an illustration where it earns its place, friendly and young in voice.
- **An extension of the experience,** not a system notice - the same calm confidence, the same "here's what I learned / here's what I'm ready to do."
- **Every email answers the governing question:** *"Your AI already learned X about your business - come see,"* or *"Your AI employee is prepared and waiting."* Never *"Action required: complete step 2."*

The email is often the *second* impression (and, for a stalled customer, the one that revives them). It deserves the same taste as Screen 1.

---

## PART VIII - Anti-patterns (the things this pass forbids)

- **A confident false negative.** Never *"doesn't exist"* unless certain. *"Couldn't confidently determine"* instead.
- **A finding without a confidence.** Every claim is levelled.
- **A field grid before a read.** Reading first; editing is a deliberate, secondary gesture.
- **A legacy artifact shown as the live stack.** Current vs. remnant vs. tracking, disambiguated by confidence.
- **Raw text where a visual belongs.** Channels and tech are cards with icons/logos, not comma lists.
- **A mixed-language screen.** The whole surface matches the UI language.
- **A byte-progress spinner** in place of the narrated discovery ceremony.
- **A missing-items checklist** that only takes; every gap must also *teach* and *promise value*.
- **A transactional email.** It's the product, reaching out.
- **A narrow admin panel.** Wide, calm, hierarchical, progressive.

---

## PART IX - The measure of this pass

One test, applied to the first minute:

> **Does the customer feel they just read a briefing prepared by someone who spent an hour researching their company - and trusts it *because* it was honest about what it wasn't sure of?**

If yes - wonder and confidence, in that first minute - the category is won before they've done a single minute of work. If the screen still feels like a database record, or if one confident falsehood slipped through, we are back to forms, and no amount of polish downstream recovers it.

**Reading first. Editing second. Confidence always. The AI does the work; the human only nods or corrects.**

---

## Appendix - Where this sits among the docs

- **`onboarding-experience-bible.md`** - the philosophy and the seven movements (the *what to feel*).
- **`onboarding-product-review.md`** - the original diagnosis of the funnel.
- **`onboarding-wonder-and-confidence.md`** (this) - the *craft-and-trust* pass after walking the built flow: the Confidence Doctrine, the discovery ceremony, the executive-briefing reframe of Screen 1, the teach-me Health screen, evolving recommendations, absolute localization, and premium email - all in service of two feelings, **wonder and confidence.**

> **The next build decision is not "what does it look like." It is the one non-negotiable this pass adds to the Bible's: every finding the AI shows carries a confidence, and it would rather admit uncertainty than state one thing that is false. Get that right, and the briefing is believed. Get it wrong, and nothing else matters.**
