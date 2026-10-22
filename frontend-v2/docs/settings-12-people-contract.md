# Screen 12 · Settings · People & teams — contract and gaps

Design: `GOTCHA Directions.dc.html`, lines 3747–3852.
Everything below is read from route source and the Prisma schema, not from the
OpenAPI document — its generator cannot extract response schemas, and an absent
schema there means "not extractable", never "returns nothing".

## What the screen reads

| Purpose | Route | Envelope | Guard |
| --- | --- | --- | --- |
| Members | `GET /api/permissions/users` | `{ data }` | ADMIN only |
| AI employees | `GET /api/ai-agents` | `{ data }` | `ai:employees:read` or ADMIN |
| Teams | `GET /api/departments` | `{ data }` | any tenant member |
| Presence | `GET /api/agents/presence` | `{ data }` | any tenant member |

### The route that is NOT used, and why it matters

`GET /api/agents` filters `where: { role: "AGENT" }`. On a tenant whose members
are all admins it returns `[]`, which is indistinguishable from a tenant with
nobody in it. The demo tenant has **zero** `AGENT` users, so building this screen
on that route would have produced an empty table that looked exactly like a
seeding problem.

`GET /api/permissions/users` is the unified list — its own source comment says
so. `GET /api/agents/login-status` is AGENT-filtered for the same reason and is
equally unusable here; see "Invite state" below.

## Classification

### SUPPORTED

- **Members with role and teams.** `roleName` / `roleBuiltinKey` from the
  assigned built-in role, `departments[]` for full multi-team membership.
  Four built-in keys exist: `owner`, `admin`, `agent`, `department_manager` —
  translated in the UI, with a tenant's custom role name shown in their own
  words.
- **Open conversation counts, both kinds.** Added by Backend for this screen.
  `openConversations` on both `GET /api/permissions/users` and
  `GET /api/ai-agents`. Parity confirmed: `User.conversations` is
  `@relation("AssignedAgent")` and `assignedAiAgentId` is also assignment, so
  the two columns measure the same thing and may sit side by side.
- **Teams.** `Department` is the concept and is richer than the design asks:
  own member list, `_count.members`, `_count.conversations` (not CLOSED),
  `queueMode`, `slaTarget`, `workingHours`, plus full CRUD.
- **Presence, including "away till 11:00".** `AgentPresence.awayUntil` is a
  real stored field. The roster route is driven from the USER list rather than
  the presence table, so a member who never sent a heartbeat appears as
  OFFLINE — which is true — instead of vanishing.
- **Team at invite time.** `POST /api/agents` accepts `departmentIds`, each
  validated against the active tenant rather than trusted from client state.

### SUPPORTED-BUT-UNDOCUMENTED

- `GET /api/permissions/users/login-status` — built for this screen. Returns
  `{ data: { "<userId>": { status, lastLogin } } }`. Note the `data` envelope:
  it differs from the older `/api/agents/login-status`, which returns the map
  bare.

### BLOCKED-BY-PRODUCT-DECISION

- **Per-person money limits.** *"Tomer: refunds up to ₪500"*, *"the AI: ₪100"*.
  `BusinessPolicyConfig` carries `maxAmount`, `maxPercentOfOrder` and
  `managerApprovalAboveAmount` — all **per action kind, tenant-wide**. There is
  no `userId`, `agentId`, `actorId` or `subject` anywhere in the policy engine,
  so two rows showing different figures is precisely what the model cannot
  express. **Ruled: dropped.** "Can do" renders the role.
  Guarded by an assertion in `e2e/settings-people.spec.ts` — a currency symbol
  or digit in a role cell fails the capture.

- **Channel → team routing.** *"gets WhatsApp, Instagram, web"*.
  `ChannelAccount` has no department link; nothing routes a channel to a team.
  **Ruled: the line is omitted entirely.**

### MISSING

- **Escalation target.** *"Escalations go to Tomer first."*
  `Department.escalationPolicy` is untyped JSON with exactly one writer
  (`onboarding.ts`), no client that populates it, and no path through the
  departments CRUD route to set it. It is **unreachable, not unpopulated** —
  empty for every tenant, permanently.
  **Ruled: render the target only when it resolves to a real user; otherwise
  render nothing.** Deliberately no "Not set": that implies settable, and the
  test is whether the product offers a path to fill it. Address has an Edit
  control; this has none on any screen.

- **Invite provenance.** Two invite paths of different fidelity:

  | Path | Writes `TenantInvite`? |
  | --- | --- |
  | Onboarding `POST /invite-team`, `POST /invite-link` | yes — `email`, `invitedBy`, `expiresAt`, `acceptedAt` |
  | Settings `POST /api/agents` (the one this screen drives) | **no** |

  So "invited" is **derived**, not recorded: `!isActive → disabled`, else
  `lastLogin ? active : invited`. "Invited yesterday" and "invited in March and
  never logged in" render identically and always will. An `INVITE_CREATED`
  audit entry is written but no route reads it.
  **Ruled: show the row, never the story.** No "invited on <date>", no
  "invited by <person>", nothing implying a record is kept.
  Not a broken flow — setup links are minted at click time, so nothing expires
  underneath a user. It is an auditability gap.

## Recorded above this screen's scope

- **`GET /api/ai-agents` returns the whole `AIAgent` row**, including
  `systemPrompt`, `sharedPrompt`, `autonomousPrompt` and `salesContext`. Today
  it leaks nothing: only `owner` and `admin` hold `ai:employees:read`, and they
  can edit those prompts anyway. But "see the roster" and "read every prompt"
  are currently the same permission, and this screen is what will make someone
  want to separate them. **Constraint: screen 12 may not be used to justify
  widening that permission.** The frontend contract strips the fields and the
  table is a server component, so nothing reaches the browser either way.

## What the demo tenant can and cannot show

Measured scoped to `urban` (Urban Supply — GOTCHA Demo):

```
members (unified list)   1      ai employees   1      presence rows   0
agents (role=AGENT)      0      departments    1      invites         0
role assignments         1      dept members   0
```

One member (ADMIN, role Owner, 1 open), one AI employee (Maya, ACTIVE,
14 open of 82 assigned), one team (Customer Support, CLAIM, SLA 30, **0
members**, 6 open). The design draws four people, three AI employees, two teams.

**So the sparse states are the screen here, not an edge case.** A capture can
prove the table renders, the columns are right, the merge works and the empty
states read as deliberate. It cannot show a multi-team layout, a populated team
card, or a meaningful human/AI mix. `awayUntil` is supported by the schema and
**unobservable** in this environment — do not manufacture a presence row to
photograph it.

## Wording constraint

`ConversationStatus` is `OPEN | WAITING | CLOSED`. `not CLOSED` therefore
includes WAITING, which usually means awaiting the **customer**. The integer
means "not finished", not "being handled right now", so it may not be captioned
as live activity. The design's "88 live" is not used; the screen says "88 open".
