# WhatsApp Integration

Zero-friction onboarding and multi-number architecture. Official Meta APIs
only: no browser automation, no headless automation, no reverse-engineered
endpoints, no WhatsApp Web.

## The documents

| | Document | What it answers |
|---|---|---|
| 01 | [Meta API inventory](./01-meta-api-inventory.md) | Every endpoint, permission, token type, prerequisite, limitation and doc URL. What is impossible, and why. |
| 02 | [Permission review](./02-permissions-review.md) | Which Facebook Login permissions we request and the endpoint each one buys. |
| 03 | [Architecture](./03-architecture.md) | Layering, data model, sequence diagram, state machine, flow-selection diagram, isolation guarantees. |
| 04 | [Manual limitations](./04-manual-limitations.md) | Every step that stays manual because Meta requires a human, with citations. |

Research was read from Meta's documentation on **2026-08-05**. Source URLs are
carried on every claim so a later reader can re-check rather than trust.

## Where the code lives

| Path | Role |
|---|---|
| `packages/shared/src/whatsapp/meta-types.ts` | Meta's shapes. Open string unions, never closed enums. |
| `packages/shared/src/whatsapp/meta-client.ts` | Official Graph endpoints, structured `MetaApiError`. |
| `packages/shared/src/whatsapp/inspector.ts` | Phase 3. Read-only sweep to a diagnostic model. |
| `packages/shared/src/whatsapp/flow-selector.ts` | Phase 4. Pure decision. No network, no database. |
| `services/auth/src/services/whatsapp/onboarding.service.ts` | Phase 9. Idempotent per-number step pipeline. |
| `services/auth/src/services/whatsapp/health.service.ts` | Phase 10. Per-number health, repair, disconnect. |
| `services/auth/src/routes/whatsapp-numbers.ts` | Phase 8. Management API at `/api/channels/whatsapp`. |
| `frontend/src/app/channels/whatsapp/` | Phases 5, 6, 8. Connect, manage, diagnose, repair. |
| `packages/shared/prisma/schema.prisma` | `WhatsAppNumber`, `WhatsAppNumberEvent`. |

Message sending is unchanged and still lives in
`packages/shared/src/channels/whatsapp.adapter.ts`.

## The one idea

**The unit of work is a phone number, not a WhatsApp account.** Everything in
[03-architecture.md](./03-architecture.md) follows from that. The five
onboarding scenarios, per-number health, one-click repair and safe disconnect
are all consequences of the granularity change, not separate features.

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `META_APP_ID`, `META_APP_SECRET` | auth service | Also used for `debug_token` app auth |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | auth service | Facebook Login for Business configuration |
| `NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | frontend | Same id, read by the signup launcher |
| `META_GRAPH_VERSION` | optional, all services | Defaults to `v24.0` via `packages/shared/src/lib/meta-graph-version.ts` |

## Two dated obligations

1. **Embedded Signup v2 is deprecated on 2026-10-15.** Migration to v4 is a
   change to the Login for Business configuration in the Meta App Dashboard,
   not a code change. See [02](./02-permissions-review.md) section 7.
2. **Graph API v24.0 is available until 2028-02-18**, review by 2027-10-01, per
   `meta-graph-version.ts`.
