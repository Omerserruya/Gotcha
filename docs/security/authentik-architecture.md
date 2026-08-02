# Authentication Architecture (Authentik)

Status: **migrated**. Authentik is the only authentication provider.
Last updated: 2026-07-16

---

## 1. The division

| Authentik owns | GOTCHA owns |
|---|---|
| Identity, credentials, passwords | Tenants, organizations |
| Sessions, OAuth2/OIDC, tokens | User profiles, roles, permissions |
| MFA (TOTP, passkeys, recovery codes) | Departments, AI employees, channels |
| Password reset, email verification | Billing, subscription, credits, feature flags |
| Identity lifecycle | Audit events, all business logic |

The rule, in one line: **Authentik proves WHO you are; GOTCHA decides WHAT you
may do.** Authentik never carries authorization data, and no Authentik group is
ever consulted for a business permission. Authorization is local RBAC only
(`UserRoleAssignment`, `UserFeatureGrant`, the `Role` enum).

## 2. Request flow

```
app.gotcha.co.il  ──unauthenticated──▶  auth.gotcha.co.il (Authentik)
                                              │
                        Authorization Code + PKCE (S256)
                                              │
                                              ▼
                          /auth/callback  ──code+verifier──▶  token
                                              │
                                    Bearer token on every API call
                                              │
                                              ▼
   authenticate()  ──verify RS256 via JWKS──▶  sub  ──▶  User.authentikSubject
                                              │
                                    load Tenant + Role + Department
                                              │
                                              ▼
                                          continue
```

Everything funnels through two functions:

- `packages/shared/src/lib/jwt.ts` → `verifyAccessToken()` - verifies the token
  against Authentik's JWKS. There is deliberately **no `signToken`**: if GOTCHA
  could mint a token it would be an identity provider, which is the thing this
  migration removed.
- `packages/shared/src/lib/principal.ts` → `resolvePrincipal()` - turns a
  verified `sub` into a GOTCHA principal. HTTP (`middleware/auth.ts`), the
  conversation WebSocket, the notifications WebSocket, and voice-copilot all
  call it, so a socket is never an easier way in than a request.

## 3. The join key: `User.authentikSubject`

The **only** link between an identity and an account. It holds Authentik's
immutable user UUID (`sub_mode=user_uuid`), which matters:

- `user_uuid` is knowable when we create the identity, so an invited user is
  bound to their subject before they ever log in. No fragile email matching.
- **Not** `user_email` / `user_username`: both are mutable, so changing an email
  in Authentik would silently re-point a subject at a different GOTCHA account.
- **Not** `hashed_user_id` (Authentik's default): opaque and unknowable at
  creation time.

### Known constraint: one identity = one account

`authentikSubject` is globally unique, but `User` is `@@unique([tenantId, email])`
- the schema permits the same person to hold accounts in multiple tenants. Those
two facts conflict: a person with accounts in two tenants can only ever link one
of them, and the other becomes unreachable.

This surfaced during migration (a test user existed in two tenants; the extra
row was removed). It is **not** hypothetical for real customers - an agency user
working across tenants would hit it. Resolving it means either accepting the
constraint as product policy, or making `authentikSubject` non-unique and adding
tenant selection at login. **This needs a product decision.**

## 4. Registration is closed

There is no public signup, and no GOTCHA endpoint accepts a credential. Users
come into existence exactly one way:

```
Owner invites ──▶ ensureIdentity() creates the Authentik identity
              ──▶ local User row created with authentikSubject
              ──▶ createRecoveryLink() mints a one-time setup link
              ──▶ invitee sets their OWN password inside Authentik
              ──▶ logs in ──▶ linked to the existing tenant
```

`services/auth/src/services/invitation.service.ts` is that path. The identity is
created **before** the local row: a failure there aborts cleanly rather than
leaving an account nobody can authenticate as.

Admins can `POST /api/agents/:id/reset-password`, which does **not** set a
password - it returns a one-time Authentik recovery link. An admin can restore
access without ever choosing or seeing someone else's credential.

## 5. Configuration

### The issuer / JWKS split (read this before debugging a 401)

`OIDC_ISSUER` and `OIDC_JWKS_URI` are **not the same host**, and that is deliberate:

- `OIDC_ISSUER` must **exactly string-match** the `iss` claim inside the token,
  which is whatever public URL the browser used. It is compared, never fetched.
- `OIDC_JWKS_URI` must be **reachable from inside the container**, so in Docker
  it uses service DNS (`http://authentik-server:9000/...`).

Pointing `OIDC_JWKS_URI` at `localhost:9000` makes a service resolve localhost
to **itself**, the fetch is refused, and every valid token is rejected as
"Invalid or expired token". This cost real debugging time during the migration.
In production both become `https://auth.gotcha.co.il/...` and the split closes.

| Variable | Used by | Notes |
|---|---|---|
| `OIDC_ISSUER` | every service | Must match the `iss` claim |
| `OIDC_JWKS_URI` | every service | Must be container-reachable |
| `NEXT_PUBLIC_OIDC_ISSUER` | browser | Must be the PUBLIC url |
| `NEXT_PUBLIC_OIDC_CLIENT_ID` | browser | `gotcha-app` |
| `NEXT_PUBLIC_OIDC_REDIRECT_URI` | browser | Must be registered in Authentik |
| `AUTHENTIK_URL` + `AUTHENTIK_API_TOKEN` | **auth service only** | Admin API; can create identities. High-value secret. |
| `OAUTH_STATE_SECRET` | ai, auth | Third-party OAuth `state` signing. Not user auth. |

`JWT_SECRET`, `JWT_EXPIRES_IN`, and `REFRESH_TOKEN_DAYS` are **gone**. Remove
them from any deployment environment.

### Local setup

```bash
docker compose up -d authentik-db authentik-server authentik-worker
node scripts/authentik/bootstrap.mjs          # idempotent; prints the OIDC vars
node scripts/authentik/link-existing-users.mjs # binds pre-existing users
```

`scripts/authentik/e2e-oidc-check.mjs <email> <password>` drives a real
login end-to-end and verifies the token the way the backend does. With
`GOTCHA_API_URL` set it also asserts GOTCHA accepts the token.

## 6. Security posture

**Enforced**

- Authorization Code + PKCE (S256 only; `plain` is advertised by Authentik but
  never used - it would send the verifier in the clear).
- RS256 pinned at verification. Without an algorithm allow-list a token could
  assert `alg: none` and sidestep the JWKS entirely.
- `state` verified on the callback before the code is touched (CSRF).
- JWKS cached with rotation support: an unknown `kid` triggers a rate-limited
  re-fetch, so rotating Authentik's signing key needs no GOTCHA deploy.
- Public client: no client secret ships to the browser.
- Strict redirect URI allow-list in Authentik (the open-redirect gate).
- `authenticate()` **fails closed** - see §7.
- Deleting a user disables the Authentik identity, not just the local row.
  Local deactivation stops authorization; only IdP deactivation stops
  authentication.

**Accepted tradeoffs (deliberate, documented)**

- **Tokens live in `localStorage`.** This is the standard public-client SPA
  tradeoff and matches how every API call here already sends a Bearer header. It
  is XSS-exposed. The durable fix is a backend-for-frontend holding an HttpOnly
  cookie session - a real architecture change, out of scope for this migration,
  and the main reason the mission's "HttpOnly cookies" goal is only partly met.
- **The internal service key can act as any tenant.** It is one shared secret
  plus a caller-supplied `x-tenant-id`. Tightened here (constant-time compare,
  tenant must exist, production rejects weak/placeholder secrets, principal
  tagged `isInternal`), but narrowing it properly means per-service scoped keys
  or mTLS. That is an authorization change, tracked separately.

## 7. The two security fixes made during this migration

Both were pre-existing and would have survived the migration untouched. Both now
have regression tests in `packages/shared/src/middleware/__tests__/auth.test.ts`.

**Fail-open `authenticate()`.** The old middleware called `next()` when the
`isActive` lookup threw:

```ts
}).catch(() => {
  // If DB check fails, allow request to proceed (fail-open for availability)
  next();
});
```

A database hiccup admitted deactivated users and requests with no resolved
tenant. Availability is not a reason to skip an authorization decision. It now
returns 503.

**Trusted `x-tenant-id`.** The old gate did `tenantId: tenantId || ""`, so an
internal call with no header landed in an empty tenant scope that some queries
read as "unscoped". The header is now required and must name a tenant that
exists, and the secret is compared in constant time (`===` leaks length and
prefix through timing).

## 8. Production infrastructure

### 8.1 What is now in the repo (2026-07-17)

Production previously had **no Authentik at all** - `docker-compose.prod.yml`
predated the migration, still required a `JWT_SECRET` that nothing reads, and
set no OIDC vars. Since `jwt.ts` *throws* when `OIDC_ISSUER`/`OIDC_JWKS_URI` are
absent, prod would have rejected every token. That is now closed:

| Piece | Where |
|---|---|
| `authentik-db` / `authentik-server` / `authentik-worker` | `docker-compose.prod.yml` - own postgres, redis DB 1, healthchecks, no host port |
| Persistent state | volumes `authentik_pgdata`, `authentik_media`, `authentik_templates` |
| OIDC vars on the 8 authenticating services | `x-oidc-env` anchor in `docker-compose.prod.yml` |
| `auth.gotcha.co.il` vhost | `gateway/nginx.prod.conf.template` |
| `auth-dev.gotcha.co.il` vhost | `nginx/nginx.conf.template` |
| `AUTHENTIK_PORT` through envsubst | `gateway/Dockerfile.prod` + both compose files |
| Frozen browser OIDC config + build guards | `scripts/docker-publish.sh` |

**`JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_DAYS` are removed from prod
compose.** Nothing reads them; leaving them implied a signing path that no
longer exists. Delete them from every deployment environment.

Three things that will bite whoever touches this next:

- **`X-Forwarded-Proto` is load-bearing.** TLS terminates at Cloudflare, so
  `$scheme` inside the gateway is always `http`. Passing that through makes
  Authentik advertise `http://` URLs and sign tokens whose `iss` never matches
  `OIDC_ISSUER` - every token 401s. The vhosts send the real scheme via a
  `$public_proto` map, and `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` tells
  Authentik to trust it.
- **envsubst uses an allow-list.** A var absent from the list in
  `gateway/Dockerfile.prod` survives as a literal `${VAR}` and nginx refuses to
  start. `AUTHENTIK_PORT` is now listed.
- **The issuer/JWKS split persists in prod** (§5), contrary to what this doc
  previously said. `OIDC_JWKS_URI` stays on internal DNS
  (`http://authentik-server:9000/…`): it is fetched, never compared, so
  internal DNS needs no egress, survives a Cloudflare incident, and avoids a
  hairpin to the internet on every key rotation. Only `OIDC_ISSUER` is public.

### 8.2 Still requires infrastructure access (not code)

1. **DNS + Cloudflare Tunnel routes** for `auth.gotcha.co.il` and
   `auth-dev.gotcha.co.il` → the gateway. The AWS SG has no inbound 80/443, so
   the tunnel is the only path in; the vhosts are inert until it is configured.
2. **Production secrets**: `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_PG_PASS`,
   `AUTHENTIK_API_TOKEN` (a dedicated non-bootstrap token), `OAUTH_STATE_SECRET`.
   Prod compose hard-fails at boot on each - deliberately: a missing auth secret
   must stop a deploy, never silently weaken it.
3. **Redirect URIs** registered for the production origin (`bootstrap.mjs` takes
   `AUTHENTIK_REDIRECT_URIS`). This is the open-redirect gate; an unregistered
   URI is rejected at login, and it must match the baked
   `NEXT_PUBLIC_OIDC_REDIRECT_URI`.
4. **SMTP** on the Authentik container so it sends its own recovery and
   verification mail.
5. **Signing key**: dev uses Authentik's self-signed cert. Production should use
   a managed keypair.
6. **Branding**: point `AUTHENTIK_BRANDING_LOGO` / `AUTHENTIK_BRANDING_FAVICON`
   at real GOTCHA assets and apply the email templates.
7. **MFA enforcement**: TOTP, WebAuthn/passkeys, and recovery codes are enabled
   and enrollable. Enforcement is currently optional
   (`not_configured_action=skip`). Tenant-level enforcement needs a policy
   binding per tenant - Authentik enforces per-flow, not per-tenant, so this
   needs design.

### 8.3 Backups

`authentik_pgdata` holds every credential and MFA secret. It lives in its own
container and schema, so the GOTCHA `pg_dump` never contained it - losing that
volume would lock every user out permanently: the GOTCHA rows survive, but the
identities they join to via `authentikSubject` do not, and nobody can
authenticate to recreate them.

`terraform/user_data.sh` now dumps `authentik-db` nightly alongside the GOTCHA
database, to `s3://<bucket>/authentik/`. Note the S3 lifecycle expires backups
at 90 days and versioning is off (`terraform/s3.tf`), so a bad overwrite is not
recoverable.

**The restore has never been tested** - for either database. An untested backup
is a hypothesis, and this one is the difference between an outage and a company
-ending event. Do one timed restore drill and record the date.
