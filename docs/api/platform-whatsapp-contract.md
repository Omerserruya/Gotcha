# Platform WhatsApp alerts number: console contract

For the SYSTEM_ADMIN page `/[locale]/system/whatsapp` (frontend-v2). Types:
`packages/shared/src/whatsapp/platform-contract.ts` (import from `@chatcenter/shared`).
Template definitions: `packages/shared/src/whatsapp/platform-templates.ts`.

All routes: auth service, `authenticate + requireSystemAdmin()`. A non-SYSTEM_ADMIN gets 403.
No response ever contains the access token or the PIN.

| Method | Path | Body | 2xx |
|---|---|---|---|
| GET | `/api/system/platform-whatsapp` | | `PlatformWhatsAppStatus` |
| POST | `/api/system/platform-whatsapp/connect` | `{ code, wabaId?, phoneNumberId? }` | 201 `PlatformWhatsAppStatus` |
| POST | `/api/system/platform-whatsapp/recheck` | | `PlatformWhatsAppStatus` |
| POST | `/api/system/platform-whatsapp/disconnect` | `{ deregister?: boolean }` | `PlatformWhatsAppStatus` |
| GET | `/api/system/platform-whatsapp/templates` | | `{ data: PlatformTemplateView[] }` (8, console order) |
| POST | `/api/system/platform-whatsapp/templates/sync` | | `{ data: PlatformTemplateView[] }` |
| PUT | `/api/system/platform-whatsapp/templates/:eventType/:lang` | `{ body }` | `{ data: PlatformTemplateView }` |
| POST | `/api/system/platform-whatsapp/templates/:eventType/:lang/submit` | | `{ data: PlatformTemplateView }` |
| PUT | `/api/system/platform-whatsapp/alerts/:eventType` | `{ enabled: boolean }` | `{ data: PlatformTemplateView }` |

`:eventType` is URL-encoded (it has dots): `tool.approval_required`,
`tool.approval_required.review`, `conversation.escalated`, `tool.action_failed`,
`credit.threshold`, `credit.exhausted`, `conversation.waiting`, `verification`.
`:lang` is `he` or `en`.

## Status

```json
{ "status": "CONNECTED|PENDING_WEBHOOK|TOKEN_INVALID|DISCONNECTED",
  "source": "db|env|none", "envPresent": false,
  "number": { "display": "+972 ...", "verifiedName": "GOTCHA", "phoneNumberId": "...",
              "wabaId": "...", "qualityRating": "GREEN", "messagingLimitTier": "TIER_1K" },
  "connectedAt": "...", "connectedBy": { "id": "...", "name": "..." },
  "disconnectedAt": null, "lastErrorCode": null, "lastError": null,
  "launch": { "...": "the same EmbeddedSignupLaunch the tenant flow gets" } }
```

- `number` is null when nothing was ever connected.
- PENDING_WEBHOOK: sends work, inbound (approval taps) may not arrive. Offer "Recheck".
- TOKEN_INVALID: sends stopped; offer "Connect again". Read `status` / `lastErrorCode`, never parse `lastError`.
- `source: "env"` with `envPresent: true`: the deployment's env pair is sending; connecting here overrides it.

## Template view

```json
{ "eventType": "conversation.waiting", "name": "gotcha_customer_waiting", "category": "UTILITY",
  "parameterCount": 2, "buttons": { "url": true, "quickReplies": 0, "copyCode": false },
  "alertEnabled": false, "toggleable": true, "editable": true, "canEnable": false,
  "languages": {
    "he": { "body": "...", "draftBody": null, "status": "NOT_SUBMITTED", "rejectedReason": null,
            "metaTemplateId": null, "submittedAt": null, "lastSyncedAt": null },
    "en": { "...": "same shape" } } }
```

- Status values: `NOT_SUBMITTED PENDING APPROVED REJECTED PAUSED DISABLED IN_APPEAL PENDING_DELETION`.
- `rejectedReason` is Meta's own (e.g. `INVALID_FORMAT`, `TAG_CONTENT_MISMATCH`).
- `toggleable: false` for `tool.approval_required.review` (follows `tool.approval_required`) and
  `verification` (follows the opt-in flow). Show their status, no switch.
- `editable: false` for `verification` (Meta writes AUTHENTICATION bodies): PUT answers 405, submit is allowed.
- `canEnable`: both languages APPROVED and a number connected. A switch-on without it is 409.
- Edit rules (422 `template_body_invalid` otherwise): the body holds exactly `{{1}}..{{parameterCount}}`,
  each once, and neither starts nor ends with a variable. The name and buttons never change.
- PUT saves `draftBody`; submit sends it to Meta (create, or edit by template id) and the status
  becomes Meta's answer (usually PENDING). Meta allows an approved template one edit per 24h and
  10 per 30 days: 409 `meta_edit_limit` with Meta's message.
- If Meta later pauses, disables or rejects a template, its alert switches itself off.

## Errors

`{ "error": "<code>", "message": "<sentence>", "meta"?: { "code": 100, "message": "Meta's words" } }`

| Code | HTTP | When |
|---|---|---|
| `choose_one_number` | 422 | the WABA has several numbers and the ES session named none |
| `number_belongs_to_workspace` | 409 | the number is a tenant's (e.g. the GOTCHA sales number) |
| `waba_belongs_to_workspace` | 409 | the WABA holds a tenant's number; use a separate "GOTCHA Alerts" WABA |
| `number_is_platform` | 409 | tenant side: a workspace tried to connect the platform number |
| `code_exchange_failed` | 400 | the popup code could not be exchanged |
| `no_waba` / `no_phone_numbers` | 400 | the ES session gave nothing to connect |
| `template_body_invalid` | 422 | see edit rules |
| `template_not_editable` | 405 | edit of `verification` |
| `unknown_template` | 404 | `:eventType` / `:lang` not in the list |
| `meta_edit_limit` | 409 | Meta's edit limit |
| `template_not_approved` | 409 | switch-on with a language not APPROVED |
| `no_platform_number` | 409 | switch-on or submit with no connected number |
| `platform_store_unavailable` | 503 | the platform tables are not migrated yet |
| `meta_error` | 502 | any other Meta failure, with `meta` |

## CSP / COOP

No change needed (PLAN section 9). The page is a signed-in path, so `metaSignupSurface` and
`Cross-Origin-Opener-Policy: same-origin-allow-popups` already apply. Please add the
`/he|en/system/whatsapp` cases to the opener-policy and CSP tests.

## Dev

Dev E2E uses fake Meta answers only; no real number is connected on dev.
