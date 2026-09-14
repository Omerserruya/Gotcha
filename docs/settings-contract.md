# Settings — what to build, and what not to

Screens 11–18. Read from the full design export on 2026-09-14 (the first time
the whole document was readable: `DesignSync` caps at 256 KiB and the file is
781 KB, so a third of it had been invisible).

Every claim below was checked against `packages/shared/prisma/schema.prisma`
and the live routes, not assumed.

This is not a list of everything the design mentions. It is split three ways,
because those need different decisions from different people:

- **Blocking** — the screen cannot be built honestly without it.
- **Deferrable** — the screen works without it and is better with it later.
- **Don't build** — the design asks for something that should change instead.

---

## The shape of it

| # | Screen | Blocking | Deferrable | Don't build |
|---|---|---|---|---|
| 11 | Workspace | 2 | 1 | — |
| 12 | People & teams | 2 | 1 | — |
| 13 | Channels | — | 2 | — |
| 14 | Business systems | 2 | 1 | — |
| 15 | Notifications | 1 | 1 | — |
| 16 | Security | 1 | 1 | 1 |
| 17 | Usage & billing | 1 | 2 | — |
| 18 | Developer | 3 | — | 1 |

**Three of the eight are nearly free.** 13 and 15 are served today; 16 needs one
endpoint. Those are what I build first, while the rest is being made.

---

## 11 · Workspace

*"The facts every AI employee quotes to a customer, plus how the business
sounds."*

**Served.** `BusinessProfile` holds name, description, website, industry,
country, language, primary system. `/api/onboarding/business-profile` reads and
writes it.

### Blocking

1. **Hours, address, currency and timezone are not on the profile.** The screen
   is built around six facts and four of them have nowhere to live. These are
   the facts an AI employee quotes to a customer — an opening hour it invents
   is worse than one it refuses to give.

   ```
   PATCH /api/workspace/profile
   { address, openingHours, currency, languages[], timezone }
   ```

   `openingHours` as a week of ranges plus exceptions, not a string: the AI has
   to answer "are you open now", which is a computation.

2. **Tone traits and the generated sample reply.** The whole point of the
   control is that a choice is judged by its output — *"tone is a small set of
   traits with a live sample reply, so the choice is judged by output"*. Traits
   stored without a sample makes it a set of checkboxes nobody can evaluate.

   ```
   GET  /api/workspace/tone          → { traits[], sample }
   PATCH /api/workspace/tone         → regenerates `sample`
   ```

   The sample is the server's, from the same model that will write the real
   replies. A client-side approximation would be a promise the product does not
   keep.

### Deferrable

3. **Propagation status** — *"change one here and every channel is consistent
   within a minute"*. The claim is the reassurance, and the screen states it as
   a fact. Until something reports it, the sentence is a promise rather than a
   status. Ship the sentence; add the status when there is a propagation
   pipeline to report on.

### Already there, unused

`BusinessPolicy.data` carries `blockedTopics`. That is the **"Never say"** list
— it already exists and needs exposing, not building.

---

## 12 · People & teams

*"Humans and AI employees in one list, because operationally they are the same
resource."*

### Blocking

1. **There is no `Team` model.** Not a missing endpoint — a missing concept.
   The design has teams receive channels and hold an escalation target
   (*"Support · gets WhatsApp, Instagram, web · escalations go to Tomer
   first"*), and the day-one handover rules depend on the same idea. Two
   screens and the onboarding flow all want it.

   ```
   Team { id, name, channels[], escalationUserId, members[] }
   GET/POST/PATCH/DELETE /api/teams
   ```

2. **Per-user action limits.** The table's second column is *"Answers, refunds
   up to ₪500"* — the role is described by what the person may do, in money.
   `BusinessPolicy` holds a tenant-wide `maxDiscountPercent`; there is nothing
   per user.

### Deferrable

3. **AI employees in the same collection.** `AIAgent` exists with live counts
   available through analytics. Merging the two lists is frontend work over two
   existing sources — real, but not blocked.

---

## 13 · Channels — build now

Served. `GET /api/channels/state` was built for day one and returns exactly what
this screen lists: channel, display name, identifier, connection status,
verification, last error. Volume per channel comes from
`/api/analytics/channel-performance`.

### Deferrable

1. **Per-channel settings** — greeting, hours, auto-assignment. The design's
   "Settings" link beside each channel. The list itself works without it.
2. **Default owner on connect** — step 2 of the connect flow. The flow can ship
   with the channel connected and unassigned, which is the state it is in today.

---

## 14 · Business systems

*"What GOTCHA can see and change on your behalf."*

### Blocking

1. **Health and last successful sync.** `TenantIntegration` has `status`, which
   is a connection flag, not health. The screen leads with *"Your returns
   platform stopped responding two days ago — 11 exchange requests are waiting.
   GOTCHA is holding them rather than guessing."* That sentence is the reason
   this screen exists, and every number in it is missing.

   ```
   GET /api/integrations/health
   → [{ integrationId, state, lastSuccessfulSyncAt, blockedWork: { kind, count } }]
   ```

   `blockedWork` is the important half. "Not responding" is a status; "11
   exchange requests are waiting" is a consequence, and only the second tells
   someone whether to care today.

2. **Capability list per integration, with three states.** The design's grid is
   `Allowed / Ask first / Never` per action — not a boolean. `CommerceCapabilities`
   is the nearest thing and it is booleans on a conversation-scoped endpoint.

### Deferrable

3. **Synced record counts** (*"4,180 customers synced"*). Reassurance, not a
   decision.

---

## 15 · Notifications — build now

Served. `/api/notification-preferences/me` returns the matrix and quiet hours,
and `NOTIFICATION_CATEGORIES` covers the event types the screen lists.

### Blocking

1. **Per-channel preference, not per-user-flag.** Today's shape is
   `{ inApp, email, whatsapp, approvals }` — four booleans. The design is a
   **matrix**: event type × channel. "Approval needed" by WhatsApp but "action
   failed" by email is the normal configuration, and flat booleans cannot say
   it.

   ```
   { channels: ["in_app","email","whatsapp"],
     events: { APPROVAL_REQUIRED: ["in_app","whatsapp"], ACTION_FAILED: ["email"], … } }
   ```

### Deferrable

2. **Volume and projection** — *"You get about 6 a day. Raising the automatic
   refund limit would cut it to roughly 2."* The best line on the page, and a
   counterfactual nothing can compute yet. Not worth blocking on.

---

## 16 · Security — nearly free

Much better served than it looks. `/api/account/sessions` lists, revokes one,
revokes all; `UserSession` carries `device`, `userAgentHash`, `ipHash`;
`/api/account/security` has MFA state; `/api/account/login-history` exists.
`AuditLog` exists with actor type (`user` / `ai` / `system`), action, target and
timestamp.

### Blocking

1. **The audit log has no tenant-facing endpoint**, and no filters. The model is
   there and the data is being written; nothing reads it back.

   ```
   GET /api/audit?category=money|ai|settings|failure&from&to&cursor
   ```

   Filters server-side. *"Money"* means "actions with an amount", and the client
   deciding what counts as money would disagree with the log the moment either
   changed.

### Deferrable

2. **Amounts as structured data.** `AuditLog.metadata` is free-form JSON, so
   *"approved a ₪179 refund"* can be written but not filtered or summed.
   Promoting `amount` and `currency` to columns is what makes the Money filter
   real rather than a keyword search.

### Don't build

3. **Location.** The design shows *"MacBook · Tel Aviv"* and *"Windows · Haifa ·
   Unfamiliar"*. `ipHash` is a **hash, deliberately** — the backend chose not to
   keep the address, and I would not undo that for a line of UI.

   The signal that matters is *unfamiliar*, and that is derivable from whether
   the device has been seen before. **Change the design to drop the city and
   keep the device and the recency.** A location we would have to start
   retaining is a new privacy liability for a label nobody acts on.

---

## 17 · Usage & billing

### Blocking

1. **Per-meter usage.** `/api/usage/allowance` answers conversations only. The
   screen breaks the month into four meters — AI-handled, team-handled, outbound
   messages, phone minutes — each against its own allowance.

   ```
   GET /api/usage/meters
   → [{ meter, used, limit, unit }]
   ```

### Deferrable

2. **Invoices.** The `Invoice` model exists with `providerPdfUrl`. It needs a
   tenant-facing list, which is small — but a customer who cannot reach an
   invoice has a support channel, and one who cannot see their usage does not.
3. **Value attribution** — *"184 hours your team didn't spend, and ₪84,200 of
   outreach revenue"*. `time-saved` already computes the hours with its basis.
   The revenue half needs outbound attribution, which belongs with Outreach
   (screens 05x) rather than here.

### Note

**Overage and the spending cap are a product decision before an endpoint.**
*"GOTCHA keeps answering and bills ₪0.40 per extra conversation. It never stops
replying to your customers mid-month."* That is a commercial commitment stated
on a settings screen. Confirm it is the actual policy before it ships as one.

---

## 18 · Developer

Nothing exists: no `ApiKey` model, no tenant-facing `Webhook` model. This is the
only screen that is entirely unbuilt on both sides.

### Blocking, if it ships at all

1. `ApiKey` — create, scope (read / read-write), last used, revoke. Hashed at
   rest, shown once on creation.
2. `Webhook` — endpoint, subscribed events, delivery health, retry policy. The
   design states the policy on screen (*"retry for 24 hours, then you get a
   notification"*), so it is a contract, not a detail.
3. **An API-only role.** *"They can build, but they can't read customer
   conversations."* That is a real permission set, and the sentence beside it —
   *"everything they do appears in the security log"* — depends on §16.1.

### Don't build — yet

The design says it itself: *"Hidden unless someone turns it on. Most businesses
never open this page."* It is the largest amount of new backend surface in the
whole of Settings, for the screen with the fewest users, and it needs the audit
log first.

**Ship Settings without it.** The sub-navigation already hides what a role
cannot reach, so the entry simply does not appear until there is something
behind it.

---

## What I would ask for, in order

1. **§16.1 audit endpoint** — the model and the data already exist; this is
   reading them back. Unblocks the screen with the best effort-to-value ratio.
2. **§15.1 notification matrix** — replaces four booleans with the shape the
   design needs, and the categories are already defined.
3. **§14.1 integration health + blocked work** — the sentence this screen exists
   for.
4. **§12.1 teams** — a missing concept rather than a missing route, and two
   other screens want it.
5. **§11.1 + §11.2 workspace facts and tone** — the facts an AI employee quotes.
6. **§17.1 per-meter usage.**
7. **§12.2 per-user limits.**

Everything else is deferrable, and §18 should wait.

## What I build while that happens

**13 Channels** and **15 Notifications** against what is served today, and
**11 Workspace** for the fields that exist — with the missing facts absent
rather than mocked, as on Home.
