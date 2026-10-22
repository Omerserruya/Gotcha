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

Re-checked 2026-09-14 against all 663 routes in the OpenAPI document and the
live source. **Three of the four things I first called blocking already exist.**
The section below replaces that earlier version.

### Already served — I was wrong

- **Opening hours.** `GET|PUT /api/agents/settings/business-hours` carries a
  full week (`sunday`…`saturday`), a `timezone`, and more than the screen
  draws: an outside-hours AI policy (`active` / `silent`) and a handoff
  message. Stored as a durable setting.
- **Time zone.** Inside the same payload.
- **A workspace-level voice.** `BusinessProfile.observedVoice`, and it is
  better than what the screen asks for — see below.

### 11.1 · Everything here is ADMIN-only

```
GET|POST /api/onboarding/business-profile     requireRole("ADMIN")
GET|PUT  /api/agents/settings/business-hours  requireRole("ADMIN")
PUT      /api/agents/settings/locale          requireRole("ADMIN")
```

The same guard problem Home had. These are *"the facts your AI employees quote
to customers"* — an agent who cannot read the opening hours cannot tell whether
the AI answered correctly.

**Asked for:** a permission rather than a rank. Reading the workspace facts and
writing them are reasonably different permissions; the rank is the wrong axis
for both.

### 11.2 · "Never say" is enforced but cannot be authored

`BusinessPolicy.data.blockedTopics` is already **consumed** — the prompt builder
reads it and the AI obeys it (`system-core-builder.ts:89`). There is no route
that writes it. The rule exists, works, and the owner cannot add one.

```
GET|PUT /api/workspace/prohibited-claims   → { claims: string[] }
```

The cheapest item in the whole of Settings: the data, the consumer and the
enforcement all exist. Only the editor is missing.

### 11.3 · The voice has no route, and the design should change

`observedVoice` is derived by counting the business's own past messages, goes
into every agent's system prompt, and is never overwritten once a human has
edited it. Nothing reads or writes it outside the import pipeline.

```
GET|PUT /api/workspace/voice   → { guidance, source: "learned"|"edited", editedAt }
```

**But the design's control is the weaker idea**, and the backend already says
why. Screen 11 offers five adjective chips — Warm, Brief, Formal, Playful,
Detailed. `brand-voice.stage.ts` on what it deliberately does not produce:

> *"Instructions to a writer, not a description of a brand — 'open with היי and
> the customer's name' is usable; 'warm and approachable' is a horoscope."*

Five adjectives are exactly that horoscope, and they would have to be
translated back into guidance by something, badly. **Change the screen to show
the learned voice as editable guidance** — which is the design's own stated
intent, *"judged by output"*, reached by a better road.

### 11.4 · The sample reply

Whichever shape the voice takes, the sample has to come from the same model that
will write the real replies. A client-side approximation is a promise the
product does not keep.

```
POST /api/workspace/voice/sample   → { reply }
```

### 11.5 · Address and currency — not blocking

No field for either. Neither breaks anything: the address appears in no AI
answer today, and currency is already decided per plan in billing. Add them
with the voice work or leave them out; the screen shows five of its six facts
either way.

### Deferrable

**Propagation status** — *"change one here and every channel is consistent
within a minute"*. The screen states it as fact and nothing reports it. Ship the
sentence; add a status when there is a pipeline to report on.

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
