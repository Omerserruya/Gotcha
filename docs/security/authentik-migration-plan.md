# Authentication Review + Authentik Migration Plan

Status: **SUPERSEDED - migration complete.**
See `authentik-architecture.md` for the as-built architecture, configuration,
security posture, and remaining manual infrastructure steps.

This document is kept as the record of the pre-migration review: what the
custom auth system looked like, and the three blockers (dependency ban, no
Authentik instance, destructive migration) that were resolved before work
began. It does not describe the current system.

Date: 2026-07-16
Branch: feat/customer-intelligence-phase1

---

## 1. Current authentication architecture (as-built)

The good news: auth is far more centralized than the service count suggests. There
are exactly **two** modules that own authentication, and everything else consumes them.

| Concern | Location | Lines |
|---|---|---|
| Token sign/verify/refresh | `packages/shared/src/lib/jwt.ts` | 63 |
| Request gate (the chokepoint) | `packages/shared/src/middleware/auth.ts` | ~50 |
| Auth HTTP surface | `services/auth/src/routes/auth.ts` | 304 |
| Password/identity logic | `services/auth/src/services/auth.service.ts` | 124 |

`authenticate()` in `packages/shared/src/middleware/auth.ts` is imported by **92 route
files** across every service. It is the single place a request becomes a `req.user`.
This is the seam the whole migration turns on: swapping HS256-local-verify for
JWKS-remote-verify is a change to *one function*, not to 92 files.

### Endpoints to be removed (all in `services/auth/src/routes/auth.ts`)

| Endpoint | Replaced by |
|---|---|
| `POST /register` | Authentik + invitation flow (registration closes) |
| `POST /login` | Authentik OIDC authorization code + PKCE |
| `POST /verify-magic-link` | Authentik |
| `POST /refresh` | Authentik refresh tokens |
| `POST /change-password` | Authentik account portal |
| `POST /forgot-password` | Authentik recovery flow |
| `POST /reset-password` | Authentik recovery flow |
| `GET /me` | **Stays** - becomes profile/tenant/RBAC lookup by `sub` |

### Data model impact

`User` (`packages/shared/prisma/schema.prisma:253`) carries `password String` (non-null).
`RefreshToken` (line 1076) exists as its own table. Target model adds
`authentikSubject` (unique), drops `password`, drops `RefreshToken`.

### Two things the review surfaced that are worth fixing regardless

1. **`authenticate()` fails open.** If the `isActive` DB check throws, the code calls
   `next()` and the request proceeds - a deactivated user is admitted whenever the DB
   hiccups. The comment says this is deliberate ("fail-open for availability"), but it
   means DB availability is a security control. This should fail closed.
2. **Internal service auth is a bearer shared secret** accepted by the same middleware,
   and it trusts a caller-supplied `x-tenant-id` header to set the tenant scope. Anything
   holding `INTERNAL_SERVICE_KEY` can act as any tenant. Authentik does not address this
   - it needs its own decision (mTLS, or per-service scoped keys).

---

## 2. Target architecture

```
app.gotcha.co.il → unauthenticated → auth.gotcha.co.il (Authentik)
  → OIDC authorization code + PKCE → JWT
  → backend verifies via JWKS → lookup User by authentik_subject
  → load Tenant → load RBAC → continue
```

Division of responsibility is correct as specified and matches the existing code's
grain: Authentik owns identity/credentials/sessions/MFA; GOTCHA keeps tenants, roles,
permissions, billing, and all business logic. Local RBAC (`UserRoleAssignment`,
`UserFeatureGrant`) stays exactly as-is - no Authentik groups.

---

## 3. Phased plan

- **P0** Deploy Authentik (compose service, DB, DNS, TLS, branding, SMTP), create the
  OAuth2/OIDC provider + application, obtain client ID/secret. *Infrastructure.*
- **P1** Add `authentikSubject` to `User` (nullable, unique). Non-destructive.
- **P2** Provision the 9 existing users into Authentik; backfill `authentikSubject`.
- **P3** Teach `authenticate()` to verify JWKS-signed RS256 tokens and resolve by `sub`.
  Dual-accept legacy HS256 behind a flag during cutover.
- **P4** Frontend: OIDC code+PKCE redirect flow replaces the login form.
- **P5** Invitation flow: backend creates the Authentik identity, links to tenant.
- **P6** Remove legacy: endpoints, `auth.service.ts`, bcrypt, refresh tokens, HS256 path.
- **P7** Destructive migration: drop `User.password`, drop `RefreshToken`.

Registration closes at P4. Billing stays independent of authentication throughout
(login always succeeds; subscription state gates *routes*, never *authentication*).

---

## 4. Blockers (why P0–P7 cannot proceed autonomously)

### B1 - JWKS verification requires a new dependency, which is a hard project rule

`CLAUDE.md` build rule #3: *"No new dependencies. `npm install` / `pip install` /
`yarn add` are blocked for agents."*

Verified absent from the tree: `jose`, `jwks-rsa`, `openid-client`, `passport`. The repo
has only `jsonwebtoken` (HS256, local secret) and `bcryptjs`.

RS256 + JWKS + key rotation cannot be hand-rolled responsibly. Writing bespoke RSA
signature verification and JWKS caching would be *new custom auth crypto* - the precise
thing this migration exists to delete, and a far worse footgun than what it replaces.
This needs an explicit exemption to add `jose` (the frontend needs an OIDC client too).

### B2 - Authentik does not exist yet

No `authentik` container, no `auth.gotcha.co.il`, no provider/application, no client
credentials. I can author the compose service and configuration, but I cannot provision
the host, DNS, or TLS, complete the Authentik admin bootstrap, or mint credentials.

Without a live issuer there is **no JWKS endpoint**, so no phase can satisfy the
mission's own gate ("Authentication works" / "verify before continuing"). Every phase
after P0 would be unverifiable - I'd be writing code I cannot run.

### B3 - Irreversible, and locks out real users

The dev DB has **9 users across 3 tenants**. Dropping `User.password` is unrecoverable,
and every user not provisioned into Authentik first is permanently locked out. The
mission specifies the target model but no identity-migration path for existing users
(do they keep passwords? get reset emails? are they pre-seeded?). That decision is
yours, not mine to guess.

---

## 5. What I recommend

Unblock in this order:

1. **Decide B1** - grant the `jose` exemption (and an OIDC client for the frontend), or
   name an approved alternative.
2. **Stand up Authentik** (B2) - or authorize me to add it to `docker-compose.yml` and
   drive the bootstrap locally against `auth.localhost`, deferring real DNS/TLS.
3. **Choose the identity-migration path for the 9 existing users** (B3).

Then P1→P7 can run autonomously and verifiably, since the code seam is a single
function and the endpoint surface is one 304-line file.

Independently of Authentik, the two findings in §1 (fail-open `authenticate()`, and
tenant-spoofable internal service key) are worth fixing now - they are live issues in
the current system and survive the migration untouched.
