# Production domain model

**Status:** canonical. Everything below is enforced by
`packages/shared/src/lib/__tests__/production-urls.test.ts`, which fails the
build when an artefact drifts.

| Host | Serves | nginx block |
|---|---|---|
| `gotcha.co.il` | Marketing only: landing pages, pricing, legal, sitemap, robots, canonical metadata | falls through to the app block (default server) |
| `app.gotcha.co.il` | Authenticated frontend, public application API, every OAuth callback except Authentik's own endpoints, every provider webhook except Twilio's | `server_name app.gotcha.co.il _` |
| `auth.gotcha.co.il` | Authentik: issuer, authorize, token, JWKS, logout, userinfo, MFA, passkeys, password reset, email verification | `server_name auth.gotcha.co.il` |
| `help.gotcha.co.il` | Help Center | `server_name help.gotcha.co.il` |
| `voice.gotcha.co.il` | Twilio HTTP callbacks and the media-stream WebSocket | `server_name voice.gotcha.co.il` |

## Why Voice is a separate hostname

It is an architectural boundary, not a convenience.

The Cloudflare Tunnel can route `voice.gotcha.co.il` straight at
`voice-copilot:4007`, skipping the gateway entirely (`DEPLOY.md` Step 7).
Twilio Media Streams are a long-lived, latency-sensitive WebSocket, and every
proxy hop in front of one is audible on a live call.

Until this change, every Twilio URL was built from `PUBLIC_BASE_URL` - the
same variable the application uses. The two could not diverge, so pointing the
app at `app.gotcha.co.il` silently moved the entire call path there too. That
failure is invisible: a Twilio webhook aimed at the wrong host does not raise
an error, the call just goes quiet.

So Voice now reads its own variable:

```
PUBLIC_BASE_URL=https://app.gotcha.co.il     # the application
VOICE_PUBLIC_URL=https://voice.gotcha.co.il  # everything Twilio is told
```

`VOICE_PUBLIC_URL` is `:?required` in `docker-compose.prod.yml` for the two
services that talk to Twilio - `voice-copilot`, which builds the TwiML, and
`conversation`, which writes the webhook URLs onto the merchant's number. Both
refuse to boot without it rather than answer a call they cannot complete.

### The Voice surface

Generated from `VOICE_PUBLIC_URL`, resolved from the routes actually mounted in
`services/voice-copilot/src/app.ts`:

- `https://voice.gotcha.co.il/api/voice/incoming/voice`
- `https://voice.gotcha.co.il/api/voice/incoming/status`
- `https://voice.gotcha.co.il/api/voice/incoming/recording`
- `https://voice.gotcha.co.il/api/voice/incoming/forward-complete`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/outbound`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/outbound-status`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/callback-bridge`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/callback-agent-status`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/conference-status`
- `https://voice.gotcha.co.il/api/voice-copilot/twiml/customer-status`
- `https://voice.gotcha.co.il/api/voice-copilot/callbacks/click/<token>`
- `wss://voice.gotcha.co.il/twilio/media-stream/<tenantId>`

The same paths remain mounted on `app.gotcha.co.il` as **compatibility routes**
for numbers configured before the split. They are not the canonical URLs and
nothing generates them any more.

## Where a public URL comes from

Two resolvers in `packages/shared/src/lib/app-origins.ts`, and nothing else:

| Function | Variable | Production behaviour when unset |
|---|---|---|
| `resolveAppPublicUrl()` | `FRONTEND_URL` (then `DASHBOARD_URL`) | **throws** |
| `resolveVoicePublicUrl()` | `VOICE_PUBLIC_URL` | **throws** |

Both refuse `http://` in production and neither falls back to `localhost` or to
the marketing apex. Nineteen call sites previously inlined their own fallback
and the fallbacks disagreed - most produced `http://localhost:3000`, one
produced `https://gotcha.co.il`, which serves no authenticated route. An invite
email built from either sends fine and lands nowhere useful, so the failure has
to happen at boot instead.

## Build-time vs runtime

`NEXT_PUBLIC_*` is frozen into the frontend bundle by
`scripts/docker-publish.sh` and never read at runtime. Changing one requires a
frontend **and gateway** image rebuild, because the gateway image bakes the
static export.

Build-time: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`,
`NEXT_PUBLIC_OIDC_ISSUER`, `NEXT_PUBLIC_OIDC_REDIRECT_URI`,
`NEXT_PUBLIC_OIDC_CLIENT_ID`, `NEXT_PUBLIC_META_APP_ID`,
`NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `NEXT_PUBLIC_VOICE_URL`.

Everything else is runtime and needs only a restart.

## Shopify Chat

The production Chat surface is `app.gotcha.co.il` - manifest, OAuth callback,
four webhooks, app proxy, and the theme extension's widget origin. The
extension's liquid defaults are always the **production** origin; a development
store overrides them per-theme with the `asset_base` block setting rather than
having its own copy of the extension.

`scripts/shopify/verify-chat-app-identity.mjs` is the gate. It refuses a
production manifest on `gotcha.co.il` (marketing) or `dev.gotcha.co.il`, and it
now also refuses one whose theme-extension widget origin disagrees with the
manifest host - the extension ships in the same app version, so the two
drifting apart loads the widget from a host the API no longer answers on.

Run it before every `shopify app deploy`.
