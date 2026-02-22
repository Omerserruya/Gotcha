# Meta Channel Dynamic Integration - Architecture Document

**Product**: GOTCHA (ChatCenter)
**Date**: 2026-02-19
**Scope**: Self-service WhatsApp, Messenger & Instagram channel connection per tenant

---

## Current State

| Aspect | Today |
|---|---|
| Channel setup | Manual: admin enters externalId + accessToken in `/channels` UI |
| Supported platforms | WHATSAPP, MESSENGER (enum `ChannelType`) |
| Data model | `ChannelAccount` (channel, externalId, credentials JSON, tenantId) |
| Webhook routing | `ChannelAccount.externalId` lookup in `webhook.ts` -> resolves `tenantId` |
| Token management | Static tokens pasted by admin, no refresh |
| Instagram | Not supported |

---

## Target State

Tenants self-connect channels via OAuth/Embedded Signup flows. No Meta Developer Console access needed after initial app setup.

---

## 1. WhatsApp Business Platform - Embedded Signup Flow

### Prerequisites (one-time, platform-level)

- Meta Business App configured with **Embedded Signup** enabled
- `WHATSAPP_EMBEDDED_SIGNUP_APP_ID` and `META_APP_SECRET` in env
- Your Meta app must have `whatsapp_business_management` and `whatsapp_business_messaging` permissions approved

### Flow

```
                         FRONTEND                          BACKEND (auth service)                META
                         ────────                          ────────────────────                  ────
  1. Admin clicks       ┌──────────────┐
     "Connect WhatsApp" │ Load Meta    │
                        │ Facebook SDK │
                        │ (FB.init)    │
                        └──────┬───────┘
                               │
  2. Launch Embedded    ┌──────▼───────┐
     Signup dialog      │ FB.login()   │
                        │ config_id    │──────────────────────────────────────────►  Meta Embedded
                        │ extras:      │                                             Signup Dialog
                        │  setup: {}   │◄─────────────────────────────────────────  (user onboards
                        └──────┬───────┘  Returns: code (exchange token)             their WABA)
                               │
  3. Send auth code     ┌──────▼───────┐     POST /api/channels/connect/whatsapp
     to backend         │ POST code +  │────►┌──────────────────────────────┐
                        │ tenantId     │     │ Exchange code for token:     │
                        └──────────────┘     │ GET oauth/access_token       │──────► Meta Graph API
                                             │   ?code={code}              │◄────── { access_token }
                                             │   &client_id={APP_ID}       │
                                             │   &client_secret={SECRET}   │
                                             │                             │
                                             │ Subscribe to webhooks:      │
                                             │ POST /{waba_id}/            │──────► Meta Graph API
                                             │   subscribed_apps           │◄────── 200 OK
                                             │                             │
                                             │ Get phone numbers:          │
                                             │ GET /{waba_id}/phone_numbers│──────► Meta Graph API
                                             │                             │◄────── [{id, display_phone_number, ...}]
                                             │                             │
                                             │ Register phone number:      │
                                             │ POST /{phone_id}/register   │──────► Meta Graph API
                                             │                             │◄────── 200 OK
                                             │                             │
                                             │ Create ChannelAccount:      │
                                             │   channel: WHATSAPP         │
                                             │   externalId: phone_id      │
                                             │   credentials: {            │
                                             │     accessToken,            │
                                             │     wabaId,                 │
                                             │     phoneNumber             │
                                             │   }                         │
                                             └──────────────────────────────┘
```

### Key Details

- **Embedded Signup config_id**: Created once in Meta Business settings. Defines which permissions and features are requested during signup.
- **Token type**: The exchanged token is a **System User Access Token** scoped to the WABA. It does not expire unless manually revoked.
- **Phone registration**: After retrieving the phone number ID, call `POST /{phone_number_id}/register` with `messaging_product: "whatsapp"` to complete setup.
- **Webhook subscription**: `POST /{waba_id}/subscribed_apps` subscribes your app to receive webhooks for that WABA. The existing global webhook endpoint receives events.

### Frontend SDK Integration

```
FB.login(callback, {
  config_id: '<EMBEDDED_SIGNUP_CONFIG_ID>',
  response_type: 'code',
  override_default_response_type: true,
  extras: {
    setup: {},           // triggers Embedded Signup flow
    featureType: '',
    sessionInfoVersion: 2
  }
});
```

The callback receives `{ authResponse: { code } }` which is sent to the backend.

---

## 2. Facebook Messenger & Instagram - OAuth Flow

Both Messenger and Instagram use **Facebook Login (OAuth 2.0)**. The difference is in the permissions requested and the post-connection API calls.

### Prerequisites (one-time, platform-level)

- Meta Business App with Facebook Login enabled
- Permissions approved: `pages_messaging`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_messages`
- Valid OAuth redirect URI registered: `https://{your-domain}/api/channels/oauth/callback`

### OAuth Flow

```
                         FRONTEND                          BACKEND (auth service)                META
                         ────────                          ────────────────────                  ────
  1. Admin clicks       ┌──────────────┐
     "Connect Messenger"│ Redirect to  │
     or "Connect IG"    │ backend OAuth│
                        │ init endpoint│
                        └──────┬───────┘
                               │
  2. Backend generates   ┌─────▼──────────────────────────────┐
     OAuth URL           │ GET /api/channels/oauth/init       │
                         │   ?platform=messenger|instagram    │
                         │                                    │
                         │ Generate state = JWT({             │
                         │   tenantId, platform, nonce        │
                         │ })                                 │
                         │                                    │
                         │ Build URL:                         │
                         │ https://www.facebook.com/          │
                         │   v21.0/dialog/oauth               │
                         │   ?client_id={APP_ID}              │
                         │   &redirect_uri={CALLBACK_URL}     │
                         │   &state={state_jwt}               │
                         │   &scope={platform_scopes}         │──────► Meta OAuth
                         │                                    │         Dialog
                         │ 302 Redirect to Meta               │
                         └────────────────────────────────────┘

  3. User authorizes     ┌────────────────────────────────────┐
     and Meta redirects  │ GET /api/channels/oauth/callback   │◄────── Meta redirects back
     back                │   ?code={code}&state={state_jwt}   │        with code
                         │                                    │
                         │ Verify state JWT (anti-CSRF)       │
                         │ Extract: tenantId, platform        │
                         │                                    │
                         │ Exchange code for short-lived token│──────► Meta Graph API
                         │ Exchange for long-lived token      │◄────── { access_token, expires_in }
                         │ (60-day page access token)         │
                         │                                    │
                         │ ── IF MESSENGER ──                 │
                         │ GET /me/accounts                   │──────► Meta Graph API
                         │ (list pages user manages)          │◄────── { data: [{ id, name, access_token }] }
                         │                                    │
                         │ For selected page:                 │
                         │ Subscribe to webhooks:             │
                         │ POST /{page_id}/subscribed_apps    │──────► Meta Graph API
                         │   ?subscribed_fields=messages,...  │◄────── 200 OK
                         │                                    │
                         │ Create ChannelAccount:             │
                         │   channel: MESSENGER               │
                         │   externalId: page_id              │
                         │   credentials: {                   │
                         │     accessToken: page_access_token,│
                         │     tokenExpiresAt, userId         │
                         │   }                                │
                         │                                    │
                         │ ── IF INSTAGRAM ──                 │
                         │ GET /me/accounts                   │──────► Meta Graph API
                         │ (list pages)                       │◄────── { data: [{ id, name, access_token }] }
                         │                                    │
                         │ GET /{page_id}                     │
                         │   ?fields=instagram_business_account│─────► Meta Graph API
                         │                                    │◄────── { instagram_business_account: { id } }
                         │                                    │
                         │ Subscribe page to IG webhooks:     │
                         │ POST /{page_id}/subscribed_apps    │──────► Meta Graph API
                         │   ?subscribed_fields=              │◄────── 200 OK
                         │     feed,messages (IG messages)    │
                         │                                    │
                         │ Create ChannelAccount:             │
                         │   channel: INSTAGRAM               │
                         │   externalId: ig_business_id       │
                         │   credentials: {                   │
                         │     accessToken: page_access_token,│
                         │     pageId, tokenExpiresAt         │
                         │   }                                │
                         │                                    │
                         │ Redirect to frontend /channels     │
                         │   ?connected={platform}&status=ok  │
                         └────────────────────────────────────┘
```

### Scopes by Platform

| Platform | Scopes |
|---|---|
| Messenger | `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement` |
| Instagram | `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_read_engagement` |

### Page Selection

If the user manages multiple Facebook Pages, there are two strategies:

- **Option A (recommended for v1)**: Auto-connect all pages. Display them all in the UI. Admin can disconnect unwanted ones.
- **Option B (richer UX)**: After OAuth, redirect to an intermediate "Select Page" UI. Admin picks which page(s) to connect. Then backend completes the subscription per selected page.

Recommendation: Start with Option A. Iterate to Option B when tenants have many pages.

### Token Lifecycle

| Token Type | Lifetime | Refresh Strategy |
|---|---|---|
| WhatsApp (Embedded Signup) | Non-expiring system user token | No refresh needed. Only revoked if business is removed. |
| Messenger page access token | 60 days (long-lived) | Background cron: refresh tokens expiring within 7 days via `GET /oauth/access_token?grant_type=fb_exchange_token` |
| Instagram (via page token) | Same as Messenger | Same refresh mechanism |

---

## 3. Data Model Changes

### Schema Evolution

```prisma
// Extend ChannelType enum
enum ChannelType {
  WHATSAPP
  MESSENGER
  INSTAGRAM    // NEW
}

// Add connection status tracking
enum ChannelConnectionStatus {
  PENDING       // OAuth started, not yet completed
  CONNECTED     // Successfully connected and verified
  ERROR         // Connection failed or token expired
  DISCONNECTED  // Manually disconnected by admin
}

model ChannelAccount {
  id              String                  @id @default(cuid())
  tenantId        String                  @map("tenant_id")
  channel         ChannelType
  externalId      String                  @map("external_id")
  displayName     String                  @map("display_name")
  credentials     Json                    @default("{}")
  isActive        Boolean                 @default(true) @map("is_active")

  // NEW FIELDS
  connectionStatus ChannelConnectionStatus @default(CONNECTED) @map("connection_status")
  connectedAt      DateTime?              @map("connected_at")
  connectedBy      String?                @map("connected_by")   // userId who connected
  tokenExpiresAt   DateTime?              @map("token_expires_at")
  platformMeta     Json?                  @map("platform_meta")  // platform-specific metadata
  lastError        String?                @map("last_error")
  lastHealthCheck  DateTime?              @map("last_health_check")

  createdAt       DateTime                @default(now()) @map("created_at")
  updatedAt       DateTime                @updatedAt @map("updated_at")

  tenant        Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  conversations Conversation[]

  @@unique([channel, externalId])
  @@index([tenantId])
  @@index([connectionStatus])          // NEW: for health check queries
  @@index([tokenExpiresAt])            // NEW: for token refresh cron
  @@map("channel_accounts")
}
```

### Credentials JSON Structure by Platform

```typescript
// WhatsApp (Embedded Signup)
{
  accessToken: string;       // System user token (non-expiring)
  wabaId: string;            // WhatsApp Business Account ID
  phoneNumber: string;       // Display phone number
}

// Messenger
{
  accessToken: string;       // Long-lived page access token
  userId: string;            // Facebook user ID who authorized
  pageId: string;            // Same as externalId, kept for clarity
  pageName: string;          // Page display name
}

// Instagram
{
  accessToken: string;       // Long-lived page access token (same as Messenger)
  pageId: string;            // Facebook Page ID linked to IG account
  igBusinessId: string;      // Same as externalId
  igUsername: string;         // Instagram @username
}
```

### platformMeta JSON (optional enrichment)

```typescript
{
  webhookSubscribedFields: string[];  // What webhook events are subscribed
  subscribedAt: string;               // When webhook was subscribed
  businessVerified: boolean;          // For WhatsApp: is business verified
  qualityRating: string;              // For WhatsApp: GREEN/YELLOW/RED
}
```

---

## 4. Webhook Routing - Dynamic Tenant Resolution

### Current Flow (already works for WA + Messenger)

```
Webhook POST → detectInboundAdapter(body) → adapter.resolveChannelAccountExternalId(body)
             → prisma.channelAccount.findFirst({ externalId, channel })
             → tenantId resolved
```

### Changes Needed for Instagram

1. **Add `INSTAGRAM` to `ChannelType` enum** in Prisma schema.

2. **Create Instagram inbound adapter** (`packages/shared/src/channels/instagram.adapter.ts`):
   - `canHandle(body)`: `body.object === "instagram"`
   - `resolveChannelAccountExternalId(body)`: Extract `entry[].id` (this is the IG Business Account ID, stored as `externalId`)
   - `extractMessages(body)`: Parse `entry[].messaging[]` (very similar to Messenger format)
   - `getSignatureHeader()`: `"x-hub-signature-256"` (same as Messenger)
   - `verifySignature()`: HMAC-SHA256 with `META_APP_SECRET`

3. **Create Instagram outbound adapter**:
   - Sends via `POST https://graph.facebook.com/v21.0/me/messages` (same as Messenger API, with IG page token)

4. **Register in `registry.ts`**:
   ```typescript
   const inboundAdapters: InboundAdapter[] = [
     whatsAppInboundAdapter,
     messengerInboundAdapter,
     instagramInboundAdapter,  // NEW
   ];
   ```

### Routing Lookup (Redis Cache for Performance)

For high-throughput webhook processing, add a Redis cache layer:

```
Key:    channel_account:{channel}:{externalId}
Value:  { tenantId, channelAccountId, credentials }
TTL:    1 hour (refresh on miss)
```

**Invalidation**: On ChannelAccount create/update/delete, delete the cache key.

This avoids a DB query per webhook hit. The current `prisma.channelAccount.findFirst()` call in `webhook.ts` becomes:

```
1. Check Redis cache
2. If miss → query DB → populate cache
3. If hit → use cached tenantId + channelAccountId
```

---

## 5. New API Endpoints

All under the **auth service** (port 4001), behind `authenticate + resolveTenant + requireRole("ADMIN")`:

### WhatsApp Embedded Signup

```
POST /api/channels/connect/whatsapp
  Body: { code: string }

  Steps:
    1. Exchange code for access token via Meta Graph API
    2. Fetch WABA ID and phone numbers
    3. Register phone number
    4. Subscribe app to WABA webhooks
    5. Create ChannelAccount
    6. Return { channelAccount }
```

### OAuth Init (Messenger & Instagram)

```
GET /api/channels/oauth/init?platform=messenger|instagram

  Steps:
    1. Generate signed state JWT (tenantId, platform, nonce, exp: 10min)
    2. Build Facebook OAuth URL with appropriate scopes
    3. 302 Redirect to Facebook
```

### OAuth Callback

```
GET /api/channels/oauth/callback?code={code}&state={state}

  Steps:
    1. Verify and decode state JWT
    2. Exchange code for short-lived token
    3. Exchange for long-lived token
    4. Fetch pages (/me/accounts)
    5. Platform-specific: subscribe page, fetch IG business account
    6. Create ChannelAccount(s)
    7. 302 Redirect to frontend /channels?connected={platform}
```

### Disconnect

```
POST /api/channels/{id}/disconnect

  Steps:
    1. Verify ChannelAccount belongs to tenant
    2. Unsubscribe from webhooks (POST /{page_or_waba_id}/subscribed_apps DELETE)
    3. Revoke token if applicable
    4. Update ChannelAccount: connectionStatus = DISCONNECTED, isActive = false
    5. Return { success: true }
```

### Health Check / Status

```
GET /api/channels/{id}/status

  Steps:
    1. Verify ownership
    2. Call Meta debug_token API to check token validity
    3. Update connectionStatus + lastHealthCheck
    4. Return { status, tokenValid, expiresAt }
```

---

## 6. Error Handling Strategy

### Connection Errors

| Error | Handling |
|---|---|
| OAuth cancelled by user | Frontend detects `?error=access_denied` in redirect, shows message |
| Code exchange fails | Backend returns 400, frontend shows "Connection failed, try again" |
| Page not found / no pages | Backend returns 404 with details, frontend shows "No pages found" |
| IG business account not linked | Backend returns 400, frontend shows "Link Instagram to a Facebook Page first" |
| Duplicate channel (already connected) | Backend returns 409 (existing logic), frontend shows "Already connected" |
| WABA already owned by another app | Backend catches Meta error 100/368, shows "This number is registered with another app" |

### Runtime Errors

| Error | Handling |
|---|---|
| Token expired (Messenger/IG) | Token refresh cron catches it. If refresh fails: set `connectionStatus = ERROR`, `lastError = "Token expired"`. Show alert in UI. |
| Webhook delivery failures | Meta retries automatically. If repeated failures: Meta disables the subscription. Health check detects this. |
| API rate limiting | Outgoing worker already has exponential backoff. Add rate-limit-aware retry headers. |
| Account disconnected externally | Health check cron detects via `debug_token`. Updates status to ERROR. |

### Health Check Cron

A background job (BullMQ repeatable job or separate cron) runs every 6 hours:

```
For each ChannelAccount where connectionStatus = CONNECTED:
  1. Call GET /debug_token?input_token={accessToken}
  2. If invalid: set connectionStatus = ERROR, lastError = reason
  3. If expiring within 7 days: attempt token refresh
  4. Update lastHealthCheck timestamp
```

---

## 7. Security Considerations

### Token Storage

| Concern | Approach |
|---|---|
| Tokens at rest | Store in `credentials` JSON field. **Encrypt at application level** before writing to DB. Use AES-256-GCM with a `CHANNEL_ENCRYPTION_KEY` env var. Decrypt on read. |
| Tokens in transit | All Meta API calls over HTTPS. Internal service-to-service via Docker network. |
| Token exposure in API | Never return `credentials` field in list/GET endpoints. Only return `connectionStatus`, `displayName`, `externalId`. |
| State parameter (OAuth) | Signed JWT with short expiry (10 min) and nonce. Prevents CSRF and replay attacks. |
| Webhook signature | Already verified via HMAC-SHA256 in `webhook.ts`. Continue using `META_APP_SECRET`. |

### Access Control

- Only `ADMIN` role can connect/disconnect channels (enforced by `requireRole("ADMIN")` middleware)
- OAuth state JWT is tied to a specific `tenantId` - prevents cross-tenant attacks
- All channel operations are tenant-scoped (existing pattern)

### Secrets Management

```
# New env vars needed:
META_APP_ID=                    # Facebook App ID (for OAuth + Embedded Signup)
META_APP_SECRET=                # Facebook App Secret (already partially exists)
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=  # Embedded Signup configuration ID
CHANNEL_ENCRYPTION_KEY=         # AES-256 key for encrypting stored tokens
OAUTH_REDIRECT_URI=             # https://{domain}/api/channels/oauth/callback
```

### Token Refresh Safety

- Refresh attempts are idempotent (re-exchanging an already-refreshed token returns the same new token)
- Failed refresh: mark channel as ERROR, do not delete the old token (it may still work)
- Log all refresh attempts for audit trail

---

## 8. Disconnect / Revoke Logic

### Disconnect Flow

```
Admin clicks "Disconnect" on a channel
          │
          ▼
  POST /api/channels/{id}/disconnect
          │
          ▼
  ┌───────────────────────────────┐
  │ 1. Verify channel belongs to  │
  │    tenant (existing pattern)  │
  │                               │
  │ 2. Platform-specific cleanup: │
  │                               │
  │    WhatsApp:                  │
  │    - DELETE /{waba_id}/       │
  │      subscribed_apps          │
  │    - Deregister phone:        │
  │      POST /{phone_id}/       │
  │        deregister             │
  │                               │
  │    Messenger:                 │
  │    - DELETE /{page_id}/       │
  │      subscribed_apps          │
  │    - Revoke page permissions  │
  │                               │
  │    Instagram:                 │
  │    - DELETE /{page_id}/       │
  │      subscribed_apps          │
  │    - Revoke page permissions  │
  │                               │
  │ 3. Update ChannelAccount:     │
  │    connectionStatus =         │
  │      DISCONNECTED             │
  │    isActive = false           │
  │    credentials = {}           │
  │    (clear stored tokens)      │
  │                               │
  │ 4. Invalidate Redis cache:    │
  │    DEL channel_account:       │
  │      {channel}:{externalId}   │
  │                               │
  │ 5. Note: Do NOT delete        │
  │    ChannelAccount record.     │
  │    Keep for conversation      │
  │    history foreign keys.      │
  └───────────────────────────────┘
```

### Important: Soft Delete, Not Hard Delete

The current `DELETE /settings/channels/:id` endpoint performs a hard delete. This should be changed:

- **Disconnect** = soft delete (set `connectionStatus = DISCONNECTED`, clear credentials, keep record)
- Conversations linked to this `channelAccountId` remain intact
- Admin can see "Previously connected" channels in the UI
- Re-connecting the same account creates a new `ChannelAccount` record (different ID, same `externalId`)

### Webhook Behavior After Disconnect

- The global webhook endpoint still receives events for disconnected numbers/pages
- `webhook.ts` already checks `isActive: true` in the `findFirst` query
- Events for disconnected channels are silently dropped (existing behavior)

---

## 9. Frontend UI Changes

### Channels Page Redesign

Replace the current manual form with platform-specific connect buttons:

```
┌──────────────────────────────────────────────────────────────┐
│  Channels                                                     │
│  Connect your communication channels                          │
│                                                               │
│  ┌──────────────────────┐ ┌──────────────────────┐           │
│  │  WhatsApp Business   │ │  Messenger            │           │
│  │                      │ │                       │           │
│  │  [Connect WhatsApp]  │ │  [Connect Messenger]  │           │
│  │  Embedded Signup     │ │  Facebook Login        │           │
│  └──────────────────────┘ └──────────────────────┘           │
│                                                               │
│  ┌──────────────────────┐                                    │
│  │  Instagram           │                                    │
│  │                      │                                    │
│  │  [Connect Instagram] │                                    │
│  │  Facebook Login       │                                    │
│  └──────────────────────┘                                    │
│                                                               │
│  ─── Connected Channels ─────────────────────────────────    │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ WA │ +1 555-0123          │ Connected │ Disconnect │    │  │
│  │    │ Phone: 1234567890    │ WABA: 9876│            │    │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ FB │ My Business Page     │ Connected │ Disconnect │    │  │
│  │    │ Page ID: 1098765432  │           │            │    │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ IG │ @mybusiness          │ Error     │ Reconnect  │    │  │
│  │    │ IG ID: 17841405822  │ Token exp │            │    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ─── Bot Flow Mode ──────────────────────────────────────    │
│  [Unified] [Per Channel]                                      │
└──────────────────────────────────────────────────────────────┘
```

### Frontend Flow for Each Platform

**WhatsApp**:
1. Load Facebook JS SDK (`connect.facebook.net/en_US/sdk.js`)
2. On "Connect" click: `FB.login()` with Embedded Signup config
3. On success: POST `code` to `/api/channels/connect/whatsapp`
4. On response: refresh channel list

**Messenger / Instagram**:
1. On "Connect" click: `window.location.href = /api/channels/oauth/init?platform=messenger`
2. User completes OAuth on Facebook
3. Backend redirects back to `/channels?connected=messenger&status=ok`
4. Frontend detects query params, shows success toast, refreshes list

### Status Display

| `connectionStatus` | UI Display | Action |
|---|---|---|
| `CONNECTED` | Green badge "Connected" | "Disconnect" button |
| `ERROR` | Red badge "Error" + `lastError` | "Reconnect" button (re-triggers connect flow) |
| `DISCONNECTED` | Gray badge "Disconnected" | "Connect" button |
| `PENDING` | Yellow badge "Connecting..." | Spinner / "Cancel" |

---

## 10. Implementation Phases

### Phase 1: Foundation (Pre-requisite)

- [ ] Add `INSTAGRAM` to `ChannelType` enum
- [ ] Add `ChannelConnectionStatus` enum and new fields to `ChannelAccount`
- [ ] Create migration `0005_add_channel_connection_management`
- [ ] Implement credential encryption/decryption utility
- [ ] Add new env vars to docker-compose and `.env.example`

### Phase 2: WhatsApp Embedded Signup

- [ ] Backend: `POST /api/channels/connect/whatsapp` endpoint
- [ ] Frontend: Load Facebook SDK, Embedded Signup flow
- [ ] Test: End-to-end WhatsApp connection with test WABA

### Phase 3: Messenger OAuth

- [ ] Backend: `GET /api/channels/oauth/init` + `GET /api/channels/oauth/callback`
- [ ] Backend: Page subscription logic
- [ ] Frontend: Connect button triggering OAuth redirect
- [ ] Test: End-to-end Messenger connection

### Phase 4: Instagram

- [ ] Backend: Instagram-specific logic in OAuth callback (IG business account lookup)
- [ ] Backend: Instagram inbound + outbound adapters
- [ ] Register Instagram adapter in registry
- [ ] Frontend: Connect button for Instagram
- [ ] Test: End-to-end Instagram connection

### Phase 5: Lifecycle Management

- [ ] Disconnect endpoint with platform-specific cleanup
- [ ] Token refresh cron job
- [ ] Health check cron job
- [ ] Soft-delete migration (change existing delete to soft-delete)
- [ ] Frontend: status badges, reconnect flow, disconnect confirmation

### Phase 6: Production Hardening

- [ ] Redis caching for webhook routing lookups
- [ ] Rate limiting on OAuth endpoints
- [ ] Audit logging for connect/disconnect events
- [ ] Monitoring/alerting on channel health status changes

---

## 11. File Impact Summary

| File / Area | Change Type |
|---|---|
| `packages/shared/prisma/schema.prisma` | Modify: add INSTAGRAM enum, new fields, new enum |
| `packages/shared/src/channels/instagram.adapter.ts` | **New**: Instagram inbound + outbound adapter |
| `packages/shared/src/channels/registry.ts` | Modify: register Instagram adapter |
| `packages/shared/src/channels/types.ts` | Modify: add INSTAGRAM to ChannelType |
| `packages/shared/src/lib/encryption.ts` | **New**: AES-256-GCM encrypt/decrypt for credentials |
| `services/auth/src/routes/channels.ts` | **New**: OAuth init, callback, connect/whatsapp, disconnect, status |
| `services/auth/src/index.ts` | Modify: mount new channels router |
| `services/webhook/src/routes/webhook.ts` | Minor: no changes needed (adapter pattern handles it) |
| `services/incoming-worker/src/workers/incoming.worker.ts` | Minor: handle INSTAGRAM channel type |
| `frontend/src/app/channels/page.tsx` | Major rewrite: connect buttons, status display, OAuth redirect handling |
| `frontend/src/lib/api.ts` | Modify: add channel connect/disconnect API calls |
| `frontend/src/i18n/en.json` + `he.json` | Modify: add Instagram and connection status translations |
| `nginx/nginx.conf.template` | Modify: add route for `/api/channels/oauth/callback` |
| `docker-compose.yml` | Modify: add new env vars |

---

## 12. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| OAuth callback on backend, not frontend | Prevents token exposure in browser. Backend-to-backend token exchange is more secure. |
| State param as signed JWT | Combines CSRF protection + tenant context in one value. No need for server-side session store. |
| Credential encryption at app level | Defense-in-depth. Even if DB is compromised, tokens are encrypted. |
| Soft-delete channels | Preserves conversation history integrity. FK references remain valid. |
| Redis cache for webhook routing | Webhook volume can be high. Avoids DB query per webhook. Cache invalidation is simple (on CRUD). |
| Separate Embedded Signup endpoint | WhatsApp flow is fundamentally different from OAuth (SDK-initiated vs redirect). Separate endpoint is cleaner. |
| Cron-based token refresh | Proactive refresh prevents service disruption. Better than reactive refresh on 401 errors. |
| Instagram as separate ChannelType | Different message format, different routing, different capabilities. Clean separation. |
