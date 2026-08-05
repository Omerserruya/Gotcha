# WhatsApp Multi-Number: Production Deployment and Rollback

Runbook for shipping `feature/whatsapp-zero-friction-onboarding` to production.
Written before deployment, from facts read off the production box on
**2026-08-05**, not from assumption.

---

## 1. Production state before deploy

Read via SSM against `i-0a7b2e0f8815f8c88`:

| Fact | Value |
|---|---|
| Tenants | 1 |
| Channel accounts (all types) | **0** |
| WhatsApp channel accounts | **0** |
| Applied migrations | 178 |
| Last migration | `20260805090000_conversation_grammatical_address` |
| `whatsapp%` tables | **0** (lifecycle tables absent) |
| `TAG` in `/opt/chatcenter/.env` | `latest` |

**Consequence that matters:** there are no WhatsApp connections in production,
so this deployment cannot disturb one. The "would this affect existing
WhatsApp connections" stop-condition is not merely satisfied, it is vacuous.

It also means production **cannot** verify the feature end to end today. The
only evidence that the messaging path works is on Dev. Say that rather than
presenting a green checklist that means less than it looks like.

---

## 2. Meta configuration: production is already correct

| | Meta App ID | Embedded Signup Config ID |
|---|---|---|
| Production | `1551544506613779` | `905441638869914` |
| Dev | `967741506053131` | `3045267809197489` |

Both are read from `/opt/chatcenter/.env`; neither is hardcoded anywhere in the
repository (verified by grep across `packages`, `services`, `frontend`,
`gateway`, `nginx`, `scripts`). `META_APP_SECRET` is present (32 chars) and was
never printed.

`WHATSAPP_ES_VERSION`, `WHATSAPP_ES_SESSION_INFO_VERSION` and
`WHATSAPP_ES_FEATURE_TYPE` are all unset in production, so
`buildEmbeddedSignupLaunch` yields the v4 payload:

```json
{ "esVersion": "v4", "responseType": "code",
  "overrideDefaultResponseType": true, "extras": {} }
```

**No Meta configuration change is required or performed by this deploy.**

> Note recorded deliberately: config `905441638869914` belongs to the
> PRODUCTION app. It was briefly set in dev's `.env` during investigation and
> has been reverted; dev is back on `3045267809197489`. Do not cross them.

---

## 3. Migration safety

`packages/shared/prisma/migrations/20260805120000_whatsapp_multi_number`

**Additive only.** The entire migration is:

- `CREATE TYPE` x3 (`WhatsAppOnboardingFlow`, `WhatsAppNumberState`,
  `WhatsAppPendingAction`)
- `CREATE TABLE whatsapp_numbers`
- `CREATE TABLE whatsapp_number_events`
- indexes and foreign keys on those two new tables only

There is **no** `ALTER`, `DROP`, `UPDATE`, `DELETE` or `RENAME` against any
existing table. The only touch to an existing table is an inbound foreign key
reference (`whatsapp_numbers.channel_account_id -> channel_accounts.id`), which
adds a constraint to the NEW table, not to `channel_accounts`.

**Legacy channels keep working.** A `ChannelAccount` with no `WhatsAppNumber`
row is a supported state, not an error. `GET /api/channels/whatsapp/numbers`
returns those separately under `unprofiled[]`, labelled "Connected the old
way", and the messaging path (send/receive) never reads the lifecycle table at
all. There are zero such rows in production today; this matters for Dev and for
any future restore from a Dev backup.

**Multi-number is supported by construction.** `whatsapp_numbers` has no unique
constraint on `tenant_id`. Uniqueness is on `phone_number_id` (one row per Meta
number, globally) and `channel_account_id` (one lifecycle row per channel).
A tenant may hold unlimited rows, across multiple WABAs and portfolios.

**Verified without a database:** `prisma validate` passes, and
`prisma migrate diff --from-migrations --to-schema-datamodel` against a shadow
database reports **no drift for any `whatsapp%` object**. (The diff does report
128 lines of pre-existing foreign-key ordering noise elsewhere in the schema;
that predates this branch and is unrelated.)

---

## 4. Deployment safety review

| Requirement | Finding |
|---|---|
| No automatic Meta subscriptions at startup | No `subscribeApp` / `subscribed_apps` call exists in any service `index.ts` or worker. |
| No automatic mutation of existing WhatsApp assets | `channel-health.worker` touches WhatsApp with a **read-only** `GET /debug_token` only. Its token-refresh path (`GET /oauth/access_token`) is scoped to `MESSENGER, INSTAGRAM`. |
| No reconnect of existing numbers during deploy | The onboarding pipeline is reachable only from `services/auth/src/routes/whatsapp-numbers.ts`, i.e. an authenticated HTTP request. |
| No background processing of dev onboarding sessions | Sessions live in Redis under `wa_signup:<tenantId>:<sessionId>`, 15-minute TTL, and nothing scans or enumerates them. Dev and production have separate Redis instances. |
| All onboarding mutations user-triggered | Confirmed: no cron, no BullMQ worker, no startup hook calls `onboardNumber` or `inspectDecideOnboard`. |

---

## 5. CSP change

One line, on the **app vhost only** (`nginx/nginx.conf.template`, server
`server_name _`). Exact diff:

```diff
-script-src 'self' 'unsafe-inline' 'unsafe-eval';
+script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net;

-frame-src 'self' https://*.gotcha.co.il;
+frame-src 'self' https://*.gotcha.co.il https://www.facebook.com https://web.facebook.com;
```

- Exact hosts, **no wildcards** on the Meta domains.
- `unsafe-inline` / `unsafe-eval` are **pre-existing** (required by the Next.js
  static export) and are neither added nor widened here.
- The `/widget/`, `/api/embedded-chat` and `help.gotcha.co.il` policies are
  deliberately **unchanged**: they serve untrusted storefronts and public pages
  and have no reason to reach Facebook.
- `connect-src` already permitted `https:`, so no change was needed for the
  Graph API calls.

Justification: Meta publishes no supported way to launch Embedded Signup
without their JavaScript SDK, which is served from `connect.facebook.net`.

---

## 6. Images to build

Changed: `packages/shared` (embedded in every service image), `services/auth`,
`frontend`, `nginx/nginx.conf.template`.

Functionally affected and therefore published:

| Image | Why |
|---|---|
| `auth` | New routes, services, session lifecycle, launch builder |
| `gateway` | Serves the Next.js static export AND the nginx template with the CSP change |
| `migrate` | Prisma migrations are **baked into the image**, not mounted |

Other services embed the changed `packages/shared` but call none of the new
code; they are left on their current images to keep the blast radius small.

**Build traps (from `project_prod_deploy_mechanics`):**

1. `PLATFORM=linux/arm64` is mandatory. The script defaults to `linux/amd64`
   and prod is a `t4g.large` (aarch64). Wrong arch = images that cannot start.
2. No npm-ci layer sharing between services; expect ~25 min per image under
   emulation.
3. `.env.prod` values for `NEXT_PUBLIC_*` are frozen into the static bundle at
   build time and cannot be fixed on the box afterwards.
4. Pushing `-latest` moves the rolling tag and destroys the rollback pointer.
   The digests in section 7 were captured **before** publishing.

---

## 7. Rollback

### 7.1 Pre-deploy image digests (captured 2026-08-05, before publish)

These stay pinnable on the box even after `-latest` moves.

| Service | Rollback digest |
|---|---|
| auth | `sha256:a758fb6161dcf25d0800e822117f0e2836e62f2d144d1178e43852cf86ab3894` |
| gateway | `sha256:74eeb1655e7e7f37a0c6d595e1d70937898ff006b97738e401c783ccd40cd26a` |
| ai | `sha256:65d33175d93bd3f1f06851583d85799d5e69d7cdd003a5e08f703f49c24ec91e` |
| conversation | `sha256:5142396fff9898d62e49ed03ee564dc42cbb59f1f801a691e0d5265f04fb6ed7` |
| incoming-worker | `sha256:45bee647b54c7c137cc63bf06baa98dd31c1e49494d868f3c1e72fc50cbd93fa` |
| outgoing-worker | `sha256:85f1cf6493d55c3da4bfab21bcc9d6e43c1b2ab27485802c90ffd311b122bc32` |
| webhook | `sha256:6fa6e292d20f3e329b52ff93fd91498845668a8e3c899fb68de76c527adfe41e` |
| analytics | `sha256:f6d99810f19f1bf885a4097c75c86d3591b45402ee3ddbaf45ef9d47dd928d75` |
| billing | `sha256:e40013cdbc5d3cdbebc77ca387a1c47ce84a965634879db1f2f0928d10e5887b` |
| chatbot | `sha256:5d4c3810a0a5dfcb19b85a7735ef37dd15e584d7d21db051a8a6085c7620d1da` |
| notifications | `sha256:a09f4bb796c5dd138abda5044c5e776b67adba1800cfc37550318ce426242fba` |
| voice-copilot | `sha256:be3c381efc4407cf9df0edfe446647698926115dbdc9d813f3aeb071cfab7f92` |

### 7.2 Service rollback

On the box, pin the digest directly rather than trusting a tag:

```bash
cd /opt/chatcenter
# One service, by digest:
docker run -d --name auth-rollback ... sha256:a758fb61...   # not normal practice

# Preferred: override the image in a compose override file
cat > docker-compose.rollback.yml <<'YAML'
services:
  auth:
    image: sha256:a758fb6161dcf25d0800e822117f0e2836e62f2d144d1178e43852cf86ab3894
  gateway:
    image: sha256:74eeb1655e7e7f37a0c6d595e1d70937898ff006b97738e401c783ccd40cd26a
YAML
docker compose -f docker-compose.prod.yml -f docker-compose.rollback.yml up -d auth gateway
docker compose -f docker-compose.prod.yml ps
```

### 7.3 Database rollback

**The migration does not need to be rolled back**, and rolling the code back
does **not** require it.

Reasoning: the new code is the only thing that reads or writes
`whatsapp_numbers` / `whatsapp_number_events`. Reverting to the previous images
leaves two unused tables behind, which is inert. The previous code never queried
them and never will.

If the tables must genuinely be removed (they should not be, casually):

```sql
-- DESTRUCTIVE. Deletes every connected-number lifecycle record.
-- Only safe while whatsapp_numbers is empty, which is true today (0 rows).
BEGIN;
DROP TABLE IF EXISTS whatsapp_number_events;
DROP TABLE IF EXISTS whatsapp_numbers;
DROP TYPE IF EXISTS "WhatsAppPendingAction";
DROP TYPE IF EXISTS "WhatsAppNumberState";
DROP TYPE IF EXISTS "WhatsAppOnboardingFlow";
DELETE FROM _prisma_migrations WHERE migration_name = '20260805120000_whatsapp_multi_number';
COMMIT;
```

**Confirmation requested in the deploy brief:** rolling back the CODE does not
delete newly connected number records. The rows survive in `whatsapp_numbers`,
and the underlying `channel_accounts` rows - which carry the credentials and
are what the messaging path actually uses - are untouched by a code rollback.
A number connected after this deploy keeps sending and receiving on the old
images; it simply loses the health and repair UI until the new images return.

### 7.4 CSP rollback

The nginx template is baked into the `gateway` image, so rolling the gateway
image back reverts the CSP with it. No separate action.

---

## 8. Post-deploy verification

Structured diagnostics are enabled and safe to leave on. Grep `[wa-verify]`:

```bash
docker compose -f docker-compose.prod.yml logs auth | grep wa-verify
```

Logged: launch path, granted scope NAMES, candidate count, selected scenario,
WABA id, phone number id, lifecycle state, webhook subscription result.
Never logged: access tokens, authorization codes, app secrets, PINs, message
content, customer personal data. `MetaApiError.redactedBody()` strips any key
matching `token|secret|pin|password|credential` before anything is persisted to
`whatsapp_number_events.detail`.

Manual test path (requires a real Meta login, performed by a human):

```
https://app.gotcha.co.il/settings/channels/whatsapp
```
