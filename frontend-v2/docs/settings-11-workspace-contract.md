# Settings · Workspace — technical contract

Screen 11. For the backend. Verified against all 663 routes in the OpenAPI
document and against the live source on 2026-09-14.

Four items. Nothing here is a new subsystem: one guard change, one editor for
data that is already enforced, one route for a column that already exists, and
one generation call.

---

## 0 · Conventions

- All paths are behind the gateway, tenant-scoped by `X-Tenant-Id` as usual.
- Success is the platform envelope, `{ "data": … }`.
- Failure is `{ "error": string, "code"?: string, "details"?: [{field, message}] }`.
- `409` is used where a write would silently discard someone else's, and never
  for validation.

---

## 1 · Permissions, not rank

### The problem

```
GET|POST /api/onboarding/business-profile      requireRole("ADMIN")
GET|PUT  /api/agents/settings/business-hours   requireRole("ADMIN")
PUT      /api/agents/settings/locale           requireRole("ADMIN")
```

These are *"the facts your AI employees quote to customers"*. An agent who
cannot read the opening hours cannot tell whether the AI answered a customer
correctly. This is the same guard problem already fixed in analytics, not
applied here.

### Asked for

`settings:workspace:update` **already exists** in `permission-catalog.ts:208`.
Add its read counterpart and split the two:

```ts
p("settings:workspace:read", "settings", "configuration", true,
  "View Workspace Settings",
  "View the business facts AI employees quote: name, description, hours, voice.")
```

| Route | Guard |
|---|---|
| `GET /api/workspace` | `settings:workspace:read` |
| `PATCH /api/workspace` | `settings:workspace:update` |
| `GET /api/workspace/voice` | `settings:workspace:read` |
| `PUT /api/workspace/voice` | `settings:workspace:update` |
| `POST /api/workspace/voice/sample` | `settings:workspace:update` |
| `GET /api/workspace/prohibited-claims` | `settings:workspace:read` |
| `PUT /api/workspace/prohibited-claims` | `settings:workspace:update` |

`read` marked runtime-true so it reaches the `agent` template; `update` stays
configuration and manager-and-up, as it is today.

**Role templates:** `agent` gains `settings:workspace:read` only.

---

## 2 · `GET /api/workspace` — one read for the screen

The screen makes three calls today for six facts across two services. One read.

```jsonc
{
  "data": {
    "name": "string",
    "description": "string",            // "what you sell"
    "websiteDomain": "string | null",
    "industry": "string | null",
    "country": "string | null",
    "languages": ["he", "en"],          // see note
    "currency": "ILS | null",           // null until §5
    "address": "string | null",         // null until §5
    "timezone": "Asia/Jerusalem",
    "hours": {
      "enabled": true,
      "schedule": {
        "sunday":    { "enabled": true,  "open": "09:00", "close": "18:00" },
        "monday":    { "enabled": true,  "open": "09:00", "close": "18:00" },
        "tuesday":   { "enabled": true,  "open": "09:00", "close": "18:00" },
        "wednesday": { "enabled": true,  "open": "09:00", "close": "18:00" },
        "thursday":  { "enabled": true,  "open": "09:00", "close": "18:00" },
        "friday":    { "enabled": true,  "open": "09:00", "close": "13:00" },
        "saturday":  { "enabled": false }
      },
      "aiOutsideHours": "active | silent",
      "outsideHoursHandoffMessage": "string"
    },
    "updatedAt": "2026-09-14T09:00:00.000Z"
  }
}
```

**Composed, not new storage.** `name`/`description`/`industry`/`country`/
`websiteDomain` from `BusinessProfile`; `timezone`/`hours` from the durable
setting `businessHours`, whose shape is unchanged and already validated by
`businessHoursSchema`.

**`languages` is a list, not `primaryLanguage`.** The screen reads *"Hebrew and
English, replies in the customer's language"*, and a single value cannot say
that. Return `[primaryLanguage]` until there is a second field; the client does
not need to know which it got.

**`updatedAt`** is the newest of the two sources, and is the `If-Match` value
for §3.

```
PATCH /api/workspace
{ name?, description?, address?, currency?, languages?, timezone?, hours? }
→ 200 { data: <same shape> }
→ 409 { error, code: "STALE_WRITE" }   when If-Match is stale
→ 422 { error, details: [{ field, message }] }
```

Partial. Any subset; absent keys are untouched. `hours` replaces wholesale —
it is one setting, and merging a partial week would produce a schedule nobody
wrote.

---

## 3 · `/api/workspace/voice` — the column exists, the route does not

`BusinessProfile.observedVoice` and `observedVoiceEditedAt` are written by
`brand-voice.stage.ts` and read by `prompt-builder.service.ts:505`. Nothing
else touches them.

```
GET /api/workspace/voice
{
  "data": {
    "guidance": "string | null",
    "source": "learned | edited | none",
    "editedAt": "ISO-8601 | null",
    "basis": { "messagesAnalysed": 0, "importedAt": "ISO-8601 | null" }
  }
}
```

**`source` is not decoration.** The screen must be able to say whether this was
learned from the business's own messages or typed by a person — they carry
different authority, and an owner editing a learned voice should know they are
overriding evidence.

**`basis` for the same reason** `time-saved` ships its basis: a figure with no
provenance is a figure nobody trusts twice. Omit if the counts are not
retrievable; do not fabricate them.

```
PUT /api/workspace/voice
{ "guidance": "string" }          // 40..1800 chars, matching VoiceSchema
→ 200 { data: <same shape, source: "edited"> }
```

**MUST set `observedVoiceEditedAt`.** The pipeline already refuses to overwrite
an edited voice; a write that skips the timestamp silently re-arms the
overwrite, which is the one behaviour `brand-voice.stage.ts` exists to prevent:

> *"Silently reverting a customer's correction is the fastest way to make them
> stop correcting things."*

An empty `guidance` clears it and returns to `source: "learned"` on the next
import — that is a revert, not a delete, and should be stated in the response.

### Design note, for whoever implements this

Screen 11 draws five adjective chips (Warm / Brief / Formal / Playful /
Detailed). `brand-voice.stage.ts` argues against exactly that:

> *"Instructions to a writer, not a description of a brand — 'open with היי and
> the customer's name' is usable; 'warm and approachable' is a horoscope."*

The frontend will show `guidance` as editable text. **No `traits[]` field is
being asked for.** If product later wants the chips, the server composes
`guidance` from them — the client will not.

---

## 4 · `POST /api/workspace/voice/sample`

```
POST /api/workspace/voice/sample
{ "guidance": "string" }          // the unsaved draft, so it previews before committing
→ 200 { data: { "reply": "string" } }
→ 503 { error, code: "SAMPLE_UNAVAILABLE" }
```

**From the same model that writes real replies**, with the same company-context
block. The whole point of the control is that a choice is judged by its output;
a sample produced by anything else is a demonstration of something the customer
will never receive.

Takes the draft rather than reading the stored value, so the preview answers
"what would this do" before anyone commits to it.

`503` rather than a silent fallback: no sample is honest, a canned one is not.

---

## 5 · `/api/workspace/prohibited-claims` — enforced, unauthorable

`BusinessPolicy.data.blockedTopics` is consumed by `system-core-builder.ts:89`
and obeyed. No route writes it.

```
GET /api/workspace/prohibited-claims
{ "data": { "claims": ["Promise a delivery date the carrier hasn't given", …] } }

PUT /api/workspace/prohibited-claims
{ "claims": string[] }            // 0..50 items, each 1..200 chars
→ 200 { data: { claims } }
```

Whole-list replace. These are few and short; an add/remove API would need ids
for strings that have none.

**Writes into the existing `BusinessPolicy.data.blockedTopics`** — no new
storage, and the AI obeys the new list on its next prompt build with no further
work.

---

## 6 · Address and currency — the only genuinely new fields

`BusinessProfile` has neither. Neither blocks anything: the address appears in
no AI answer today, and currency is decided per plan in billing.

Included in §2's shapes so they can be filled later without a second contract.
**Ship §1–5 without them if that is faster.** The screen shows five of its six
facts either way, with the missing ones absent rather than mocked.

---

## Order

1. **§5 prohibited claims** — data, consumer and enforcement all exist; only an
   editor is missing. Smallest change, highest value: an owner can finally add
   a rule the AI already knows how to obey.
2. **§1 permissions** — unblocks the screen for anyone who is not an owner.
3. **§2 `GET|PATCH /api/workspace`** — composition over two existing sources.
4. **§3 voice** — one column, two routes.
5. **§4 sample** — the only item needing a model call.
6. **§6 address and currency** — optional.
