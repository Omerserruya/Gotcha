# Contract S11-v1.1 · Settings · Workspace

> v1.1 supersedes v1 in ONE place: prohibited-claims limits are hard 422s, not
> silent trimming. Everything else in v1 was verified correct on DEV unchanged.

Screen 11. Source of truth: `services/auth/src/routes/workspace.ts` on
`feat/workspace-prohibited-claims` @ `ad136980`. Shapes below are read from that
source, not from the spec.

## Common

- Mount: `app.use("/api", workspaceRoutes)` in `services/auth`.
- Gate: `authenticate` → `resolveTenant` → `requireOnboardingOrActiveTenant()`.
  **Reachable during onboarding**, not only on a live tenant.
- Permissions: read routes `settings:workspace:read`; every write, including
  `POST /workspace/voice/sample`, `settings:workspace:update`.
- Success envelope is always `{ "data": ... }`.
- Error envelope is **bare, never wrapped in `data`**: `{ "error": string, "code"?: string, "details"?: [{ "field": string, "message": string }] }`.
- Timestamps are ISO-8601 strings or `null`.

## 1 · GET /api/workspace

```jsonc
{ "data": {
  "name":          "string | null",
  "description":   "string | null",
  "websiteDomain": "string | null",   // READ-ONLY, not patchable
  "industry":      "string | null",   // READ-ONLY, not patchable
  "country":       "string | null",   // READ-ONLY, not patchable
  "languages":     ["string"],        // ALWAYS an array, [] when none, never null
  "currency":      "string | null",   // 3 letters, upper-case
  "address":       "string | null",
  "timezone":      "string | null",
  "hours": null | {
    "enabled":                  false,        // boolean, strict === true
    "schedule":                 null,         // opaque, passed through verbatim
    "aiOutsideHours":           "active",     // default when unset
    "outsideHoursHandoffMessage": ""          // default "" , never null
  },
  "updatedAt": "string | null"        // LATER of BusinessProfile.updatedAt and the businessHours setting
} }
```

`hours` is `null` when the tenant has never saved hours. That is different from
saved-and-disabled, which is an object with `enabled: false`.

`updatedAt` is the concurrency token for §2.

## 2 · PATCH /api/workspace

Patchable fields, all optional: `name`, `description`, `address`, `currency`,
`languages`, `timezone`, `hours`. **Any other key is a 422**, including the
read-only fields returned by GET.

| Field | Rule |
|---|---|
| `name` | trimmed, 1..200 |
| `description` | trimmed, 1..2000 |
| `address` | trimmed 0..300, or explicit `null` |
| `currency` | `/^[A-Za-z]{3}$/`, stored upper-cased, or `null` |
| `languages` | array of strings, max 6, trimmed + lower-cased |
| `timezone` | non-empty string |
| `hours` | object, **replaced wholesale, never merged** |

Two behaviours the UI must plan around:

- **`languages` round-trip is lossy.** Only `languages[0]` is persisted
  (`BusinessProfile.primaryLanguage`). Send `["he","en"]`, read back `["he"]`.
  Per Omer's decision this screen is single-select, so route around it. The
  storage column is deliberately NOT being added as part of screen 11.
- **`hours` is replaced, not merged.** Always send the whole week. A partial
  week overwrites the stored one rather than patching into it.
- Sending `timezone` without `hours` preserves the stored week and swaps only
  the zone.

Success: `200` with the **full §1 workspace object** (re-read after write).

Errors:

| Status | Body |
|---|---|
| 422 | `{ "error": "Invalid workspace patch", "details": [{ "field", "message" }] }` - one entry per bad field, unknown keys reported as `unknown field "x"` |
| 409 | `{ "error": "The workspace changed since you loaded it", "code": "STALE_WRITE" }` |
| 409 | `{ "error": "This workspace has no business profile yet", "code": "NO_BUSINESS_PROFILE" }` |
| 500 | `{ "error": "Failed to update workspace" }` |

**Optimistic concurrency is OPT-IN.** Send `If-Match: <updatedAt from GET>`.
Omit the header and the write always wins. Send it and a `STALE_WRITE` means
re-GET and re-present; it is not retryable as-is.

## 3 · GET /api/workspace/voice

```jsonc
{ "data": {
  "guidance": "string | null",
  "source":   "none" | "learned" | "edited",
  "editedAt": "string | null",
  "basis":    { "messagesAnalysed": 0, "importedAt": null }
} }
```

- `source` is three states on purpose: `none` = nothing learned yet,
  `learned` = imported and untouched, `edited` = a human wrote it and the
  import pipeline must not overwrite it.
- **`basis` is a hardcoded stub.** `messagesAnalysed` is always `0` and
  `importedAt` always `null`. The field is shape-stable so the UI need not
  change later, but **do not render it as a real number today.**

## 4 · PUT /api/workspace/voice

Body: `{ "guidance": string }`.

| Case | Result |
|---|---|
| not a string | 422 `{ "error": "Invalid voice", "details": [{ "field": "guidance", "message": "guidance must be a string" }] }` |
| empty / whitespace | **200 REVERT** (see below) |
| length < 40 or > 1800 | 422 `… "guidance must be between 40 and 1800 characters"` |
| ok | 200 `{ guidance, source: "edited", editedAt, basis }` |
| no business profile | 409 `{ "error": "This workspace has no business profile yet", "code": "NO_BUSINESS_PROFILE" }` |
| other | 500 `{ "error": "Failed to save voice" }` |

**Empty string is a REVERT, not a delete.** It clears both the text and the
edit stamp so the next import may learn the voice again. The response carries
an extra key so the UI can say so:

```jsonc
{ "data": { "guidance": null, "source": "none", "editedAt": null,
            "basis": { "messagesAnalysed": 0, "importedAt": null },
            "reverted": true } }
```

`reverted` is **present only on that path**; it is absent, not `false`, on a
normal save. Length bounds are checked *after* the empty-revert branch, so ""
never trips the 40-character minimum.

## 5 · POST /api/workspace/voice/sample

Body: `{ "guidance": string }` - the **draft** being previewed, not the stored
voice. Requires `settings:workspace:update` even though it writes nothing.

- 200 `{ "data": { "reply": "string" } }`
- 422 `{ "error": "Invalid sample request", "details": [{ "field": "guidance", "message": "guidance is required" }] }` for missing or blank.
- 503 `{ "error": "Could not generate a sample right now", "code": "SAMPLE_UNAVAILABLE" }`

**The 503 is deliberately uniform and carries no reason** (decision D7).
Upstream non-2xx, a reply-less body, a network error and the 20-second timeout
all collapse to the same code. The client cannot distinguish them and should
not try. There is **no canned fallback text**: a sample the model never produced
would be worse than no preview.

Budget the UI for up to ~20s before the 503 arrives.

## 6 · GET/PUT /api/workspace/prohibited-claims

GET → `{ "data": { "claims": ["string"] } }`
PUT ← `{ "claims": ["string"] }` → `{ "data": { "claims": ["string"] } }`

- Missing key → 422 `{ "error": "Invalid claims", "details": [{ "field": "claims", "message": "claims is required" }] }`
- Validation failure → 422 `{ "error": "Invalid claims", "details": [{ "field", "message" }] }`
- 500 `{ "error": "Failed to read|save prohibited claims" }`

**Two different behaviours, and conflating them is the trap.** Verified on DEV:

*Silent normalisation, 200 with a SHORTER array* - blanks and whitespace-only
entries are dropped; duplicates are removed case-insensitively, keeping the
FIRST occurrence's original casing (`["Cheapest in Israel","cheapest in israel"]`
→ `["Cheapest in Israel"]`).

*Hard limits, 422, nothing written* - the list is REJECTED, never trimmed:

| Condition | `details[0].message` |
|---|---|
| more than 50 items | `claims accepts at most 50 items` |
| any entry over 200 chars (200 exactly is fine) | `every claims entry must be 200 characters or fewer` |
| any non-string entry | `every claims entry must be a string` |
| `claims` not an array | `claims must be an array of strings` |

**Render the returned array, never the submitted one** - because of the first
group. But do not expect the second group to be silently fixed for you: an
over-long entry fails the whole save, so the UI must enforce 200/50 itself.

This route patches only `blockedTopics`. The discount ceiling and refund rule
share the same policy blob and are untouched by this screen.

## Recorded, not fixed

- **D14** - `settings:workspace:read` / `:update` do not appear in the original
  spec. They were added to the permission catalog to make these routes
  enforceable. Recorded for Omer, deliberately not "fixed".
- **GAP-S11-1 CLOSED** - tone is a single editable `guidance` text; the five
  chips are dropped.
- **GAP-S11-3 CLOSED** - currency and language are single-select.

## Verified on DEV · 2026-09-16 · auth @ ad136980

Every shape and error above was exercised against the running DEV stack, not
read from source alone. Confirmed live:

- GET shape, field-for-field, including `hours: null` for a never-saved tenant.
- All six PATCH 422s, `STALE_WRITE` via `If-Match`, `currency: "ils"` → `"ILS"`.
- `languages: ["he","en"]` → reads back `["he"]`. The loss is real, not theoretical.
- Voice save → `source: "edited"`; `"   "` → `reverted: true`, `source: "none"`.
- Claims normalisation and all four hard limits, exactly as tabulated.
- **Hours replace-not-merge, with teeth:** after saving a week with
  `aiOutsideHours: "handoff"` and a handoff message, a partial `{"hours":{"enabled":false}}`
  reset them to `"active"` and `""`. A screen that does not carry those two
  fields through will silently switch the AI's out-of-hours behaviour back on.
- `timezone` alone preserves the stored week and swaps only the zone.

Not verified, and why:

- **Permission enforcement.** The probe authenticated as the internal service
  principal, which satisfies `requirePermission` without consulting the RBAC
  tables. `settings:workspace:read` / `:update` are therefore **unproven at
  runtime**; they are correct in source and in the catalog.
- **The sample happy path.** `POST /voice/sample` returned its contracted 503
  `SAMPLE_UNAVAILABLE` in 0.2s. The cause was upstream and real:
  `ai_units:units_exhausted` on the DEV tenant. The delegation to `services/ai`
  works and is metered as designed; the tenant is simply out of credit. A
  successful sample body has not been observed on DEV.
