# GOTCHA Security & Compliance Master Plan v2 (post-Authentik)

Audit date: 2026-07-17. Branch: `feat/customer-intelligence-phase1` (uncommitted working tree).
Method: fresh, evidence-first audit of the CURRENT codebase. Every prior conclusion was re-verified
against current code or discarded. Findings cite `file:line`. Six parallel specialist passes
(auth/authz/tenancy, integrations/AI, infra/supply-chain, GDPR/billing/DR, web-app vulns,
previous-findings regression), with the most severe items independently re-verified by the lead.

This document supersedes `security-compliance-master-plan.md`, `SECURITY_FINDINGS.md`,
`SECURITY_SCORECARD.md`, `THREAT_MODEL.md`, and `enterprise-readiness-audit.md`. Those remain as
historical records only.

---

## 1. Executive Summary

The Authentik migration materially improved the platform's identity posture and closed the two
worst findings of the previous audit (forgeable `SYSTEM_ADMIN` JWT from a `change-me` secret, and
unauthenticated role escalation via `POST /api/auth/register`). Authentication is now standards-based
(OIDC + PKCE + JWKS/RS256), fails closed, and stores no credentials in GOTCHA.

However, this is NOT yet a production-ready posture for a multi-tenant platform handling EU personal
data. Two unauthenticated, internet-reachable webhook paths allow cross-tenant message forgery, a
cluster of server-side request forgery (SSRF) sinks remains open, the app-layer input-validation
middleware does not actually sanitize request bodies (mass-assignment risk on identity fields), and
the entire GDPR data-lifecycle machinery (erasure, export, consent, retention) is still absent.

Overall security posture: **6.0 / 10** (up from the prior 4.5-6.0 range). Strong identity core,
solid secrets/backup/infra hygiene, but real exploitable application and integration gaps plus
significant GDPR gaps.

Production readiness: **Conditional**. Acceptable for a controlled, non-EU, low-sensitivity pilot
after the two Critical webhook fixes. NOT ready for general availability or EU launch until the P0/P1
items below are closed.

---

## 2. Architecture Overview (as-built, verified)

- Monorepo, npm workspaces: 11 services (`ai`, `auth`, `conversation`, `chatbot`, `analytics`,
  `notifications`, `webhook`, `incoming-worker`, `outgoing-worker`, `voice-copilot`, `billing`),
  plus `gateway/` (nginx), `frontend/` (Next.js), `packages/shared`.
- Identity: Authentik (self-hosted) is the sole IdP. Browser does OIDC Auth Code + PKCE
  (`frontend/src/lib/oidc.ts`); services verify RS256 access tokens via JWKS
  (`packages/shared/src/lib/jwt.ts`) and resolve `sub` to `User.authentikSubject`
  (`packages/shared/src/lib/principal.ts`). No local passwords, sessions, refresh store, or MFA.
- Authorization: 100% local RBAC (`Role` enum + feature-permission system), enforced by
  `authenticate()` / `requireRole()` / `requireSystemAdmin()` in `packages/shared/src/middleware`.
- Multi-tenancy: JWT tenant is authoritative for non-admins (`middleware/tenant.ts`); a Prisma client
  extension (`packages/shared/src/lib/prisma.ts`) blocks tenant-scoped bulk/data ops missing a
  `tenantId`.
- Service-to-service: shared `INTERNAL_SERVICE_KEY` + caller-supplied `x-tenant-id`.
- Edge: Cloudflare tunnel (`cloudflared`, outbound-only) -> gateway nginx -> service DNS on the
  Docker network. TLS terminates at Cloudflare; inter-service traffic is plain HTTP on the internal
  network.
- Data stores: Postgres (app), separate Postgres (Authentik), Redis (BullMQ + cache), Qdrant
  (vectors). Billing via iCount (no Stripe for platform billing). Integration credentials encrypted
  at rest with AES-256-GCM.
- Infra: single EC2 behind Cloudflare, Terraform-managed, nightly `pg_dump` of BOTH databases to S3.

---

## 3. Security Score

| Domain | Score /10 | Basis |
|---|---|---|
| Authentication (Authentik) | 8.5 | OIDC/PKCE/JWKS correct, fails closed, no local creds. Gaps: MFA not enforced, no bound password policy, tokens in localStorage. |
| Authorization / RBAC | 7.0 | Central gate solid; one cross-tenant read bug (F-HIGH-1), single-row Prisma ops rely on hand-written scoping. |
| Multi-tenancy isolation | 6.5 | Strong backstop, but guard exempts single-row ops and covers 27 of ~82 tenant models. |
| Integrations / webhooks | 4.0 | Two unauthenticated inbound forgery paths (Critical), SSRF cluster. |
| AI security | 6.5 | Tool gate + HITL + context sanitization strong; chat-history channel still unsanitized. |
| Web app (XSS/SQLi/injection) | 7.5 | No raw SQL with input, no XSS sink, no command injection; mass-assignment middleware flaw. |
| Infrastructure / Docker / Nginx | 6.0 | Good Terraform/secrets/backup hygiene; no HTTP security headers, root containers, unpinned images. |
| Secrets management | 7.5 | Prod gates every secret; nothing sensitive committed; dev defaults + code fallbacks weaken it. |
| Supply chain | 4.5 | 1 critical + 11 high npm advisories; devDeps shipped in prod images; no CI security gates. |
| GDPR / data protection | 3.5 | No DSR/export/erasure/consent/retention; privacy policy over-promises. |
| Audit logging / monitoring | 4.5 | AuditLog model exists, ~3 call sites, no retention, no alerting. |
| Backup / DR | 7.5 | Paired DB backup, one successful drill; key-material backup + versioning gaps. |
| **Overall** | **6.0** | Strong identity core, real application/integration/GDPR gaps. |

---

## 4. ISO 27001 (Annex A) Readiness

| Control area | Status | Evidence / gap |
|---|---|---|
| A.5 Access control | Partial | RBAC enforced (`middleware/rbac.ts`); cross-tenant read bug (HIGH-1); internal-key = any-tenant. |
| A.5.16 Identity management | Compliant | Authentik OIDC, immutable `authentikSubject` join, fail-closed. |
| A.5.17 Authentication info | Partial | Passwords/MFA in Authentik; MFA not enforced, no bound password policy (`bootstrap.mjs`). |
| A.8.2 / 8.3 Privileged/Info access | Partial | `requireSystemAdmin` on all system routes; mass-assignment can set `role`/`authentikSubject`. |
| A.8.9 Secure configuration | Partial | Prod compose gates secrets; no HTTP security headers; root containers; unpinned images. |
| A.8.12 Data leakage / DLP | Partial | Egress SSRF sinks open; token prefixes/scopes logged. |
| A.8.15 Logging | Partial | AuditLog model present, coverage far below mandate; no retention. |
| A.8.16 Monitoring | Missing | No alerting on auth failures, signature rejections, or anomalies. |
| A.8.24 Cryptography | Compliant (data-plane) | AES-256-GCM creds, TLS at edge, RS256 tokens. Caveat: single static key, no rotation. |
| A.8.25-28 Secure development / change mgmt | Missing | No `.github/` CI, no SAST/dependency/secret scanning gates. |
| A.8.8 Vulnerability management | Missing | Known advisories unpatched, no `npm audit` gate. |
| A.5.7 Threat intelligence / A.5.24-26 Incident mgmt | Missing | No incident-response runbook, no breach process. |
| A.8.13 Backup | Compliant | Nightly paired DB backup to S3, SSE-AES256, one drill PASS. |
| A.5.29 / 5.30 Continuity | Partial | DR drilled once; key-material backup + restore cadence gaps. |
| A.5.19-23 Supplier security | Missing | No sub-processor register, no DPA inventory. |
| A.7 Physical / cloud | N/A / Compliant | AWS/Cloudflare shared-responsibility; EBS encrypted, IMDSv2 required, SG closed. |

ISO 27001 readiness: **early / not certifiable yet**. The technical controls for access, crypto, and
backup are largely in place; the management-system controls (logging coverage, monitoring, incident
response, vulnerability management, supplier register, secure-development pipeline) are the main gaps.

---

## 5. GDPR Readiness

| Requirement | Status | Evidence |
|---|---|---|
| Lawful basis / RoPA | Missing | No records of processing; no documented basis per purpose. |
| Consent + cookie handling | Missing | No consent surface or record model; `localStorage` written unconditionally (`frontend/src/lib/journey-cache.ts:26` and others). Functional-only, but no cookie notice. |
| Marketing opt-in (WhatsApp) | Missing | Opt-out enforced (`broadcast.worker.ts:120`), but no opt-in capture / proof-of-consent record. |
| Right of access / portability | Missing | No export endpoint (searched `gdpr|dsr|data-subject|export`). |
| Right to erasure | Partial/Missing | No end-customer erasure (`contacts.ts` has no DELETE); tenant delete (`system.ts:311`) leaves Qdrant vectors, `UsageLog`/`AuditLog`, and Authentik identities orphaned. |
| Right to rectification | Implemented | `PATCH /contacts/:id` (`contacts.ts:387`), user edits. |
| Data minimization / purpose limitation | Mostly OK | `Contact` proportionate; `WaitlistEntry` free-text kept unbounded. |
| Data retention | Missing | No TTL/purge job anywhere; all stores grow unbounded. |
| Encryption / security of processing | Partial | Creds AES-GCM; Message/Qdrant plaintext at rest; internal HTTP plaintext (by design). |
| Cross-border / sub-processors | Missing | OpenAI, Meta, AWS, Cloudflare, iCount, CRMs are processors; no list, no DPAs, no SCC note. |
| Breach handling (Art. 33/34) | Missing | No detection or 72-hour notification process. |
| Privacy notice accuracy | Non-compliant | `privacy-policy/page.tsx:170` ships literal `[Contact Email]` placeholder; promises 30-day deletion (backups are 90d) and access/erasure rights that have no implementation. |

GDPR readiness: **not compliant**. The platform can technically process and secure data, but the
data-subject-rights and accountability machinery required by Arts. 5, 6, 7, 13, 15, 17, 20, 28, 30,
33 does not exist. The live privacy policy makes commitments the system cannot fulfil, which is an
independent exposure.

---

## 6. Findings

Severity reflects impact x reachability x authentication required. Each item is verified; lead
re-verifications are marked (RE-VERIFIED).

### CRITICAL

**C-1. Email inbound webhook has no signature verification (unauthenticated cross-tenant message injection).** (RE-VERIFIED)
`services/webhook/src/routes/webhook.ts:388-425` returns `200` then resolves the tenant from the
attacker-controlled recipient email in the body and enqueues the message, with the whole `/api/webhook`
router under `crossTenantMiddleware` (tenant guard disabled). `emailInboundAdapter.verifySignature`
exists but is never called. Anyone on the internet can inject a forged customer message into any
tenant, driving the AI employee to reply and act. Fix: verify a provider signature / shared secret
before resolving tenant or enqueuing; fail closed.

**C-2. Meta (WhatsApp / Messenger / Instagram) webhook skips signature verification when the header is absent or the app secret is unset.** (RE-VERIFIED)
`webhook.ts:88` gates verification behind `if (signature)` and `if (appSecret && rawBody && ...)`.
A request that simply omits `x-hub-signature-256` bypasses verification entirely and is processed.
Same impact as C-1 (forged inbound messages / delivery-status flips for any tenant). Fix: reject when
the signature header is missing or no app secret is configured; make verification mandatory.

### HIGH

**H-1. Cross-tenant customer-intelligence read via client-supplied `tenantId`.** (RE-VERIFIED)
`services/ai/src/routes/customer-summary.ts:36` sets `tenantId = body.tenantId || req.tenantId`,
then `:53` validates the conversation against that client value, not the JWT tenant. An authenticated
user in tenant A who knows a tenant B `conversationId` reads tenant B's customer brief. Fix: use
`req.tenantId` only; assert `conv.tenantId === req.tenantId`.

**H-2. Input-validation middleware does not sanitize the body -> mass assignment on identity fields.** (RE-VERIFIED)
`packages/shared/src/middleware/validate.ts:7` calls `schema.parse(req.body)` but discards the result
and never reassigns `req.body`, and schemas are not `.strict()`. Sinks then spread the raw body into
Prisma writes: `services/auth/src/routes/agents.ts:91` (`data: req.body` into `prisma.user.update`),
`departments.ts:122`, `permissions.ts:326`, `system.ts:474`, `conversation/.../templates.ts:367`.
`User` has settable `role`, `tenantId`, and `authentikSubject` (the auth join key). A tenant ADMIN can
`PATCH /agents/:id` with `{"role":"ADMIN"}` or `{"authentikSubject":"<victim-sub>"}` to escalate or
hijack identity linkage. Fix: `req.body = schema.parse(req.body)` + `.strict()`, and pass explicit
allowlisted `data` objects; never allow `role`/`tenantId`/`authentikSubject` from the client.

**H-3. SSRF cluster: three server-side fetch sinks reach internal hosts / cloud metadata.**
(a) KB URL ingestion `services/ai/src/routes/knowledge.ts:115` fetches a user-supplied `sourceUrl`
with no scheme/host/private-IP guard and stores the body. (b) Onboarding crawler
`services/auth/src/routes/onboarding.ts:1402,1583` fetches a user origin with `redirect:"follow"` and
no guard. (c) Flow-executor `services/incoming-worker/src/services/flow-executor.service.ts:1516` has
an `isPrivateHost` string check but follows redirects and does not resolve DNS (bypassable via 302 or
DNS rebinding). Fix: a shared `safeFetch` (scheme allowlist, resolve DNS and block private/link-local/
metadata ranges, `redirect:"manual"` with per-hop re-validation) applied to all three. Mitigation
already present: IMDSv2 is required (`terraform/ec2.tf`), which blocks the easiest metadata theft.

**H-4. Internal service-key check is re-implemented insecurely in ~19 files, bypassing the hardened primitive.** (RE-VERIFIED: 27 occurrences)
Routes compare `key !== (process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026")` (committed
default) with a non-constant-time `!==`, instead of the fail-closed constant-time
`verifyInternalServiceKey` (`packages/shared/src/lib/internal-key.ts`). Affected files include
`services/ai/src/routes/crm-auto-link.ts:37` (mounted at `/api/crm`, which IS gateway-exposed,
`gateway/nginx.prod.conf.template:585`), `ai-bot.ts`, `ai-assist.ts`, `agent-loop-resume.ts`,
`conversation/.../approvals.ts`, `voice-sessions.ts`, and more. Nuance: the prod compose gates
`INTERNAL_SERVICE_KEY` with `:?required` (`docker-compose.prod.yml:317,487`), so the stack refuses to
boot without a real key, which prevents the committed default from silently applying in the documented
deploy. This keeps it High, not Critical, but it is a real defense-in-depth failure (timing side
channel, and full compromise if any AI-service container is ever run outside that compose gate). Fix:
route every check through `verifyInternalServiceKey`; delete the literal fallback.

**H-5. No HTTP security headers at the edge (no CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy).**
Neither `gateway/nginx.prod.conf.template` nor `nginx/nginx.conf.template` emits any security header;
`helmet()` covers the backend services but not the nginx-served SPA. Enables clickjacking, removes the
XSS blast-radius cap a CSP provides, and allows TLS downgrade on first hit. Fix: add HSTS,
`X-Content-Type-Options nosniff`, `X-Frame-Options DENY` / CSP `frame-ancestors 'none'`,
`Referrer-Policy`, and a real CSP at the server scope (repeated into nested `location` blocks).

**H-6. Supply chain: 1 critical + 11 high npm advisories, and dev toolchain shipped in prod images.**
`npm audit` (2026-07-17) on the tracked `package-lock.json`: axios SSRF/prototype-pollution, undici
smuggling, `ws` memory disclosure, form-data CRLF, nodemailer SMTP injection, multer DoS,
path-to-regexp ReDoS, plus critical vitest (dev). Service Dockerfiles run `npm install` (not
`npm ci --omit=dev`) and execute via `tsx`, so devDeps ship in the running container
(`services/*/Dockerfile`). Fix: `npm audit fix` + pin patched minors (upgrades of existing deps,
allowed by policy); build in a builder stage and ship `npm ci --omit=dev`; add a CI `npm audit
--omit=dev --audit-level=high` gate.

**H-7. GDPR data-subject-rights and lifecycle machinery absent.**
No export/portability endpoint; no end-customer erasure; tenant deletion (`system.ts:311`) orphans
Qdrant vectors, `UsageLog`/`AuditLog`, and Authentik identities; no retention/purge job anywhere; no
consent record model. Fix: build export + erasure workflows (DB + Qdrant + Authentik), a tenant
off-boarding purge, retention jobs, and a consent record. (Detailed in section 5.)

**H-8. Live privacy policy over-promises and contains a placeholder.**
`frontend/src/app/privacy-policy/page.tsx:170` ships literal `[Contact Email]`; `:119-121` promises
30-day deletion and "encrypted backups up to 30 days" while backups live 90 days
(`terraform/s3.tf`); `:147-149` promises access/erasure rights with no implementation. Fix: correct
the placeholder immediately, align retention numbers, and only publish rights that have an execution
path.

**H-9. AI chat history from WhatsApp/Instagram/email is not sanitized before prompt assembly (prompt injection).**
`services/incoming-worker/src/services/ai-bot.service.ts:228,734` maps `m.body?.trim()` raw into
history; no `sanitize*` call on this path (the webchat/CRM/KB paths ARE wrapped). Blast radius is
bounded by the tool gate (see P-5), so impact is content-level manipulation, not cross-tenant tool
execution. Fix: wrap customer/history content in delimited untrusted-data blocks on this path too.

**H-10. No breach detection or notification process.**
No incident-response runbook, severity model, or Art. 33 72-hour procedure. Compounded by thin audit
coverage (H-11) and no retention, which make scoping a breach hard. Fix: a one-page IR runbook + the
tooling to determine affected tenants/contacts from AuditLog.

**H-11. Audit-logging coverage is a fraction of the CLAUDE.md mandate.**
`AuditLog` model is well-shaped (`schema.prisma:2558`) but has ~3 call sites; tenant/user deletion,
role/permission changes, and credential changes write nothing. Rows are mutable, fire-and-forget
(`audit.service.ts:51`), with no retention or alerting. Fix: audit all admin mutations; decide the
prompt-logging policy (it is itself a retention liability) and implement or amend the mandate.

### MEDIUM

- **M-1.** Internal-key model grants ADMIN on any caller-supplied `x-tenant-id` (one shared secret,
  documented tradeoff, `middleware/auth.ts:46-74`); nginx does not strip inbound `x-internal-key` /
  `x-tenant-id` from external requests (`gateway/nginx.prod.conf.template`, RE-VERIFIED). Internal
  routes are not gateway-routed today, so this is latent, but header stripping should be explicit.
- **M-2.** Single-row Prisma ops (`findUnique`/`update`/`delete`) are exempt from the tenant guard
  (`prisma.ts:102-107`); isolation relies on hand-written load-then-scope discipline (sampled routes
  were correct). Add a lint/CI invariant.
- **M-3.** iCount webhook verification is default-permissive: unset `ICOUNT_WEBHOOK_SECRET` +
  `ICOUNT_MODE` default "mock" accepts unsigned billing webhooks (`icount.provider.ts:120`,
  `webhooks.ts:62`). Fail closed in production.
- **M-4.** `buyCredits` idempotency key uses `Date.now()` (`purchase.service.ts:31`), so a retried
  purchase mints a second real charge. Derive from a stable client request id.
- **M-5.** Gmail Pub/Sub push (`webhook.ts:451`) and Outlook Graph notifications (`webhook.ts:555`)
  are unauthenticated triggers (no Google OIDC JWT / no `clientState` check); attacker can force a
  mailbox sync for a connected tenant (cannot inject arbitrary content).
- **M-6.** Webhook signature failures are silent (200 already sent, no metric, no health flip),
  so probing is invisible and a misconfigured secret silently drops real traffic while the UI shows
  green (`webhook.ts:44,92`).
- **M-7.** Dev docker-compose mounts the host Docker socket into `authentik-worker` as root
  (`docker-compose.yml:107`); prod does not. Remove from dev.
- **M-8.** Containers run as root, no resource limits, no `cap_drop`/`no-new-privileges`
  (all service Dockerfiles + compose). Add `USER node`, caps, and limits.
- **M-9.** Floating base images (`qdrant:latest`, `node:20-alpine`, `nginx:alpine`, etc.). Pin by
  version/digest.
- **M-10.** Origin trusts client `X-Forwarded-Proto` with no Cloudflare-origin validation
  (`gateway/nginx.prod.conf.template:67`); safety rests entirely on the closed security group +
  outbound-only tunnel. Use `set_real_ip_from` scoped to CF/cloudflared and/or authenticated origin
  pulls.
- **M-11.** No retention policy on any store (Message, UsageLog, AuditLog, BillingWebhookEvent raw
  payloads, ReasonerShadowEval). Storage-limitation gap + growing breach blast radius.
- **M-12.** Authentik identity survives GOTCHA user/tenant deletion (no Authentik API call in
  `system.ts:571` / `agents.ts:141`); personal data persists in the IdP.
- **M-13.** No sub-processor register / DPA inventory; OpenAI + AWS are cross-border transfers
  needing SCCs.
- **M-14.** No consent record model; no cookie notice (`localStorage` written unconditionally).
- **M-15.** DR residuals: `AUTHENTIK_SECRET_KEY` and `CHANNEL_ENCRYPTION_KEY` must be in the backup
  set (losing either makes the restore or all stored credentials undecryptable); S3 versioning off;
  drill run once (`disaster-recovery-drill.md`).
- **M-16.** Prod images built with `npm install` including devDeps (see H-6).
- **M-17.** Verbose OAuth/channel logging includes token prefixes + full granted scopes
  (`channels.ts:811`); no full token/password logged, but redaction helper (`log-redact.ts`) is
  unwired.
- **M-18.** Everything except integration credentials is plaintext at rest (Message content, Qdrant
  payloads, `BusinessDiscovery` PII `schema.prisma:778`, `WebhookTrigger.secret` `schema.prisma:635`).

### LOW

- **L-1.** Public embedded-chat exposes transcript by `sessionId` (cuid) alone
  (`embedded-chat.ts:238`); rate-limited but unsigned. Bind a per-session token.
- **L-2.** `SYSTEM_ADMIN_SETUP_SECRET` ships as `change-me-in-production` (`.env.example:196`);
  compared with non-constant-time `!==` (`system.ts:688`); closed after first seed. Hard-fail on
  placeholder in prod.
- **L-3.** Client error responses echo raw `err.message` in several handlers (no stack traces).
  Return generic messages in prod.
- **L-4.** `server_tokens off` not set; nginx version leaked.
- **L-5.** No `limit_req` on webhook/websocket locations (cheap DoS on webhook workers).
- **L-6.** OAuth `state` is a signed JWT not bound to a browser-session nonce (forgery-resistant,
  not login-CSRF-proof).
- **L-7.** `outlook.adapter.ts:69` `verifySignature` returns true on missing inputs (fail-open latent
  trap, currently unused).
- **L-8.** AES key management: single static key, no versioning/rotation; non-hex key silently
  sha256'd; legacy plaintext credential rows tolerated (`channels.ts:173`).

### POSITIVE (verified controls)

- Authentication fails CLOSED on DB/identity error (503, never `next()`), `middleware/auth.ts:107`.
- JWT verify pins RS256, blocks `alg:none`/confusion, enforces issuer string-match, throws on missing
  `sub` (`jwt.ts:88-101`); no signing path exists.
- Immutable identity join (`sub` -> `authentikSubject`, `sub_mode=user_uuid`); role/tenant come from
  the DB, never token claims (`principal.ts`).
- PKCE S256, state verified before code use, strict redirect-URI allowlist (`oidc.ts`,
  `bootstrap.mjs:236`).
- Prisma tenant-guard backstop on bulk/data ops (`prisma.ts:160-215`).
- Tool execution gated by tenant permission + HITL approval, tenant-scoped `x-tenant-id`
  (`agent-tools.ts:1054-1160`).
- Context/CRM/KB/knowledge prompt blocks wrapped with `sanitizeUntrusted`.
- Integration credentials AES-256-GCM with per-record IV + auth tag (`encryption.ts`).
- Slack webhook + generic trigger secrets: constant-time, replay-windowed, fail-closed.
- Billing: no Stripe/PAN exposure (iCount PayPage tokenization), server-side pricing, webhook
  idempotency spine (`billing/.../webhooks.ts`).
- Secrets: nothing sensitive committed; `.env`, tfstate, tfvars gitignored; prod compose gates every
  secret with `:?required`.
- Infra: EBS encrypted, IMDSv2 required, S3 public-access blocked + SSE, least-privilege IAM, SG
  closed, no public db/redis/qdrant ports.
- Backup: nightly paired dump of BOTH app and Authentik DBs to S3; one successful DR drill with real
  PKCE login against the restore.

---

## 7. Previous Findings: verified disposition

Full table in the evidence appendix (F). Roll-up:

- **Fixed (16):** embedded-chat rate limit (F-001), CRM prompt-injection wrap (F-003), output
  validator (F-005), cost ceiling (F-006), visitorName sanitize (F-008), `.env` not committed
  (F-010), auth fail-closed (F-011, P0-12), custom-DB SQLi (F-015), ai-debug gate (F-017), widget
  body cap (F-018), runaway-loop cap, Qdrant tenant filter, and related threat-model entries.
- **Superseded by Authentik (5):** register role escalation (C-1/P0-1), `JWT_SECRET=change-me`
  forgeable admin (F-004/E.1), refresh-token revocation (P0-13). The mechanisms (local JWT signing,
  bcrypt, register, refresh store) no longer exist; verified via `jwt.ts` (verify-only) and the
  `auth.test.ts` 404 regression guard.
- **Partially fixed (8):** internal key (gate hardened, ~19 files still fall back to the committed
  default -> now H-4), Prisma tenant guard (backstop added, 27 of ~82 models, single-row exempt),
  compose defaults (prod gated, dev not), security headers (services yes, nginx no -> H-5), cost
  budget (fail-open half remains).
- **Still exists (11):** chat-history sanitize (H-9), redact unwired (M-17), audit fire-and-forget
  (H-11), webhook fail-open (C-1/C-2), SSRF crawler (H-3), GDPR machinery (H-7), no CI (H-6),
  `BusinessDiscovery` plaintext PII (M-18), unsigned sessionId (L-1), guard single-row exemption
  (M-2), console recon (L-3/L-4).
- **No longer applies (5):** CRM prefetch cache (consistency, not security), `/init` tenantId
  (accepted), Hebrew skill global, "no backups" (false; backups exist), SYSTEM_ADMIN `x-tenant-id`
  impersonation (by design, only SYSTEM_ADMIN, non-admin JWT tenant authoritative).
- **Unknown / not re-verified this pass (6):** F-012 tag bounds, F-014 custom-tool descriptions,
  P0-4 nginx internal deny (partly covered by M-1: internal routes not gateway-routed today),
  P0-8 `npm audit` (now H-6), P0-9 push-deploy fallback, P0-11 privacy backup claim (now H-8).

---

## 8. Remaining Risks (top standing exposures)

1. Unauthenticated inbound message forgery (C-1, C-2) until webhook verification is mandatory.
2. Cross-tenant read (H-1) and identity-field mass assignment (H-2) reachable by authenticated users.
3. SSRF cluster (H-3) can pivot outbound clients into the internal network / metadata.
4. No GDPR execution path (H-7) and an over-promising privacy notice (H-8): legal + trust exposure.
5. Supply-chain advisories in the running image (H-6); no CI to catch regressions.
6. Single shared internal key = any tenant (M-1); blast radius of one secret leak is the whole fleet.
7. No monitoring / breach process (H-10, H-11): the platform cannot currently detect or scope a
   compromise.

---

## 9. Prioritized Roadmap

**P0 (before any wider exposure, days):**
- Make webhook signature verification mandatory and fail-closed for email + all Meta channels
  (C-1, C-2).
- Fix `customer-summary` to use `req.tenantId` only (H-1).
- Fix `validate()` to reassign the parsed body + `.strict()`; allowlist Prisma `data` (H-2).
- Correct the privacy-policy placeholder + retention numbers (H-8, one-line + copy).

**P1 (weeks):**
- Shared `safeFetch` on all three SSRF sinks (H-3).
- Route every internal-key check through `verifyInternalServiceKey`; delete literal fallbacks (H-4).
- Add nginx security headers + CSP (H-5); strip inbound `x-internal-key`/`x-tenant-id` (M-1).
- `npm audit fix` + pin; `npm ci --omit=dev` runtime images; add CI security gates (H-6, M-16).
- GDPR MVP: per-contact/user export + erasure (DB + Qdrant + Authentik), tenant off-boarding purge
  (H-7, M-12).
- Enforce MFA (at least for ADMIN/SYSTEM_ADMIN) and bind a password policy in `bootstrap.mjs`.

**P2 (1-2 months):**
- Retention/purge jobs per store (M-11); expand audit coverage + make it durable (H-11).
- iCount webhook fail-closed (M-3); idempotency key fix (M-4); Gmail/Outlook trigger auth (M-5).
- Sanitize chat-history path (H-9); consent record + cookie notice (M-14).
- Container hardening: non-root, caps, limits, pinned images (M-7, M-8, M-9).
- Incident-response runbook + basic monitoring/alerting (H-10).
- Sub-processor register + DPAs + SCC note (M-13).

**P3 (hardening / maturity):**
- Per-service scoped internal keys or mTLS (retire the single shared key, M-1).
- Extend tenant guard to single-row ops / lint invariant (M-2).
- AES key versioning + rotation (L-8); encrypt `BusinessDiscovery` / `WebhookTrigger.secret` (M-18).
- BFF + HttpOnly cookie session to remove tokens from `localStorage`.
- S3 versioning + quarterly DR drills + key-material in secrets manager (M-15).
- Per-session token for embedded chat (L-1); Cloudflare authenticated origin pulls (M-10).

---

## 10. Production Readiness Assessment

**Verdict: Conditional / not GA-ready.**

- Blocking for any production exposure: C-1, C-2 (unauthenticated cross-tenant message forgery).
  These are internet-reachable and require no credentials.
- Blocking for EU / regulated launch: H-7, H-8, H-10, H-11 (GDPR execution, accurate privacy notice,
  breach process, audit/monitoring).
- Blocking for GA multi-tenant trust: H-1, H-2, H-3 (cross-tenant read, mass assignment, SSRF).

A controlled pilot with trusted tenants, non-EU data, and the four P0 items closed is reasonable. The
identity core, secrets hygiene, backups, and AI tool-gating are genuinely strong and are not the
blockers; the integration edge and the compliance/observability layer are.

---

## 11. Evidence Appendix

Full per-domain findings with `file:line` for every claim:

- A. Authentication / Authorization / Multi-tenancy / Service-to-service:
  `scratchpad/audit/A-auth.md`
- B. Integrations / Webhooks / SSRF / AI / Internal APIs / Workers: `scratchpad/audit/B-integrations.md`
- C. Infrastructure / Docker / Nginx / Cloudflare / Terraform / Secrets / Supply chain:
  `scratchpad/audit/C-infra.md`
- D. Billing / GDPR / Audit logging / Retention / Backup-DR / Breach: `scratchpad/audit/D-gdpr.md`
- E. Web-app vulnerability classes (XSS/SQLi/injection/mass-assignment): `scratchpad/audit/E-websec.md`
- F. Previous-findings regression table: `scratchpad/audit/F-prevfindings.md`

Lead re-verifications performed this pass: C-1 (`webhook.ts:388`), C-2 (`webhook.ts:88`),
H-1 (`customer-summary.ts:36,53`), H-2 (`validate.ts:7` + `agents.ts:91`), H-4 (27 occurrences of the
committed default across 19 files; `/api/crm` gateway-exposed at `nginx.prod.conf.template:585`; prod
compose `:?required` gate at `docker-compose.prod.yml:317,487`), M-1 (nginx does not strip inbound
internal headers), and the secrets-not-committed / gitignore verification.

Confidence and uncertainty: items marked (RE-VERIFIED) were confirmed by the lead against current
code. Remaining items are from the specialist passes with cited evidence. Explicit open uncertainties
are listed at the end of each appendix file (e.g. live security-group state, `OIDC_AUDIENCE` prod
value, Authentik stock password-policy defaults, EC2 volume-encryption already confirmed true). Where
uncertain, the finding says so and is not asserted as fact.

---

## 12. Remediation Log (2026-07-17, this branch)

Autonomous P0+P1 remediation pass. Every item below was implemented, typechecked
(all 12 workspaces clean), and where a suite exists, tested. Shared solutions
were built once in `packages/shared` and adopted everywhere; each vulnerability
class was swept repo-wide, not just at the cited instance.

### P0 (all closed)

- **C-1 Email webhook forgery** - `services/webhook/src/routes/webhook.ts` `/email`
  now calls the shared `verifyWebhookSignature` (HMAC over rawBody with
  `EMAIL_WEBHOOK_SECRET`) and returns before tenant resolution on any failure.
  Fail-closed.
- **C-2 Meta webhook signature bypass** - the unified `POST /` handler routes
  through the shared verifier; a missing `x-hub-signature-256` header or unset
  app secret now DROPS the request instead of processing it. Swept the same
  file: Gmail Pub/Sub (`GMAIL_PUBSUB_TOKEN`), Outlook Graph `clientState`, and
  Slack replay window are all verified too (closes M-5 early).
- **H-1 Cross-tenant customer-summary** - `services/ai/src/routes/customer-summary.ts`
  uses `req.tenantId` only and asserts `conv.tenantId === req.tenantId`.
- **H-2 validate() mass assignment** - `packages/shared/src/middleware/validate.ts`
  reassigns `req.body = schema.parse(req.body)`. Repo-wide sweep of `data: req.body`
  / rest-spread sinks: explicit allowlists added to `agents.ts`, `departments.ts`,
  `permissions.ts`, `system.ts` (tenant/user), `templates.ts`, plus two further
  sinks the sweep found - `ai-agents.ts` PATCH (`AIAgent`, reached `tenantId`/`role`)
  and `router-rules.ts` PATCH (`RouterRule`, reached `tenantId`/`isDefault`).
- **H-8 Privacy policy** - placeholder removed, real contact
  (`privacy@gotcha.co.il`), retention numbers aligned (90-day backups).

### P1 (all closed)

- **H-3 SSRF cluster** - shared `safeFetch`/`assertPublicUrl`
  (`packages/shared/src/lib/safe-fetch.ts`: scheme allowlist, DNS-resolved
  private/link-local/metadata block, per-hop redirect revalidation) applied to
  ALL nine tenant-influenced fetch sinks found by a repo-wide sweep: KB URL
  ingestion, onboarding crawler (x2), flow HTTP node, WhatsApp template media
  download, catalog-tool dispatcher, WooCommerce, ReturnGO, Zoho, Salesforce,
  Shopify, and the custom-API tool (DNS check added on top of its allowlist).
- **H-4 Internal-key re-implementation** - all 27 committed-default fallbacks
  removed. Receivers use `requireInternalKey`/`verifyInternalServiceKey`
  (constant-time, fail-closed); senders use `getInternalServiceKey()` (no literal
  fallback). `voice-copilot` env default and callback-token HMAC secret hardened.
  Repo now has ZERO `chatcenter-internal-2026` occurrences outside tests.
- **H-5 / M-1 Nginx headers + header stripping** - HSTS, CSP, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy added at server
  scope and into every `location` that declares its own `add_header`, in BOTH
  `gateway/nginx.prod.conf.template` and `nginx/nginx.conf.template`.
  `server_tokens off`. Inbound `X-Internal-Key` stripped on all 99/105 proxied
  locations. `nginx -t` validates both.
- **H-6 / M-16 Supply chain** - `npm audit` prod tree now **1 low** (was 1
  critical + 11 high): `nodemailer` bumped to ^9, transitive `ws`/others patched.
  All 11 service Dockerfiles rewritten as two-stage builds: builder installs +
  `prisma generate`; runtime does `npm ci --omit=dev` (tsx moved to
  `dependencies`) + copies the generated client - dev toolchain
  (vitest/typescript/prisma-CLI) no longer ships. Containers run as non-root
  (`USER node`, M-8). Verified by building + booting the webhook image.
  `.github/workflows/security.yml` adds `npm audit --omit=dev --audit-level=high`,
  gitleaks, and typecheck gates.
- **H-7 / M-12 GDPR machinery** - new Prisma models `ConsentRecord`,
  `DataRetentionPolicy`, `DataSubjectRequest` (+ migration). Auth service:
  `/api/gdpr` for user/tenant export + erasure (DB + Qdrant via internal call +
  Authentik identity deletion), consent CRUD, retention-policy CRUD. Conversation
  service: `/api/gdpr/contacts` for contact export/erasure/consent. AI service:
  internal `deleteByTenantId` (Qdrant) + `runRetentionPurge`. Tenant deletion
  (`system.ts`) now routes through the comprehensive `eraseTenant` purge that
  cleans UsageLog/AuditLog/consent/retention/Qdrant/Authentik (previously
  orphaned). New `deleteIdentity` in the Authentik client.
- **Audit logging (H-11 partial)** - shared fire-safe `writeAudit` + `AuditAction`
  catalog in `packages/shared`. Wired into user/tenant lifecycle (create/update/
  delete/activate), role & permission changes, feature grants, invites, password-
  reset link issuance, and all GDPR/consent/retention actions. ~39 audit call
  sites (was ~3).
- **MFA + password policy** - `scripts/authentik/bootstrap.mjs` enforces MFA
  (`not_configured_action=configure` on the validation stage, covers ADMIN/
  SYSTEM_ADMIN) and binds a 12-char + complexity + HIBP + zxcvbn password policy
  to the recovery flow. Both wired into `main()`.
- **M-7 dev Docker socket** - removed the host `docker.sock` mount from the dev
  `authentik-worker`.

### Validation

- `npm run typecheck --workspaces` - clean across all 12 workspaces.
- `npm audit --omit=dev --audit-level=high` - passes (1 low remaining).
- Auth suite 20/20; conversation suite 6/6; ai `tool-execution-http` 5/5.
- Both nginx templates pass `nginx -t`; webhook prod image builds, boots as
  non-root with the generated Prisma client, and only fails on absent Redis.
- Pre-existing, environment-dependent test failures (Redis-less sandbox:
  crm-adapter resolver, cost-budget preflight, identity merge, behavior-engine)
  were confirmed to fail identically at baseline and are NOT regressions.

### Updated posture (engineering estimate, pending live re-audit)

- Security score: **6.0 -> ~8.0**. Both Critical webhook forgery paths closed;
  SSRF cluster, mass-assignment, cross-tenant read, internal-key timing channel,
  edge headers, and supply-chain advisories all remediated.
- ISO 27001: A.8.8 (vuln mgmt via audit gate), A.8.9 (headers/non-root),
  A.8.15 (audit coverage), A.8.25-28 (CI security pipeline) moved Missing/Partial
  -> Partial/Compliant. Management-system items (monitoring/alerting, IR runbook,
  sub-processor register) remain the standing gaps.
- GDPR: **3.5 -> ~7.0**. Export, erasure (DB+Qdrant+Authentik), consent record,
  retention framework, and DSR accountability now exist and are reachable.
  Standing gaps: RoPA/sub-processor register/DPAs, cookie-consent UI,
  breach-notification process - documentation/process items, not code.

### Not in this pass (remaining, lower priority)

- H-9 chat-history prompt-injection wrap (P2), H-10 IR runbook + monitoring (P2),
  retention/consent UI surfaces, iCount webhook fail-closed (M-3), buyCredits
  idempotency (M-4), image pinning (M-9), Cloudflare origin validation (M-10),
  at-rest encryption for BusinessDiscovery/WebhookTrigger.secret (M-18), and the
  P3 hardening set (per-service keys/mTLS, AES key rotation, BFF cookie session).

---

## 13. Independent Adversarial Re-Verification (2026-07-18)

A second pass treated the remediated code as untrusted and attempted to break every
P0/P1 control (external-pen-tester posture: forge webhooks, bypass the SSRF guard,
escalate via mass assignment, reach cross-tenant data, defeat the internal-key and
nginx controls). Four parallel break-it sweeps plus hands-on exploitation.

### Controls that HELD (attempted and could not break)

- **C-1/C-2 (Meta, email, Gmail, Outlook webhooks):** signature/secret verified via
  the shared fail-closed verifier BEFORE any enqueue; adapter HMACs use
  `timingSafeEqual`; missing header/secret/body all drop. Confirmed.
- **H-1 cross-tenant read:** `customer-summary` uses JWT tenant + asserts
  `conv.tenantId === req.tenantId`. No `body.tenantId || req.tenantId` pattern remains
  anywhere. `resolveTenant` forces the JWT tenant for non-SYSTEM_ADMIN, so client
  `x-tenant-id`/path params cannot widen scope.
- **H-2 mass assignment:** no route lets `req.body` set `role`/`tenantId`/
  `authentikSubject`/`isSystem`; every sink uses `validate()`+object-schema stripping
  or an explicit allowlist (incl. the two sweep-found ones, ai-agents & router-rules).
- **H-3 SSRF:** IPv4 obfuscation (decimal/octal/hex) is normalized by the WHATWG URL
  parser and blocked; scheme allowlist, credential-smuggling, redirect-rebind, and
  per-hop revalidation all hold; all 12 tenant-influenced fetch sinks call the guard
  before the request.
- **H-4 internal key:** zero committed defaults, zero inline non-constant-time compares;
  `verifyInternalServiceKey` is fail-closed (empty/array/weak/unset all reject).
- **H-6 supply chain:** npm audit prod = 1 low; Dockerfiles omit dev deps and run
  non-root.
- **H-7 GDPR authz:** cross-tenant export/erasure blocked (all loads are
  `findFirst({id, tenantId})`); tenant-level DSRs are SYSTEM_ADMIN-only;
  `/api/gdpr-internal` is not gateway-routed and is `requireInternalKey`-gated.

### NEW exploitable findings - FOUND and FIXED this pass

1. **[CONFIRMED, was exploitable] Slack webhook fail-open** (`services/webhook/src/routes/webhook.ts` `/slack`).
   The Slack handler still used the pre-remediation inline logic: it verified only
   when `SLACK_SIGNING_SECRET` was set AND all headers present - so an unset secret OR
   a simply-omitted `x-slack-signature` header bypassed verification and enqueued a
   forged message into any tenant with Slack connected (identical to the original C-2
   Meta bypass; missed by the first sweep). **Fixed:** verification is now mandatory and
   fail-closed (unset secret rejects in prod; missing timestamp/signature/body rejects;
   stale timestamp or HMAC mismatch rejects; all before enqueue). Regression tests added.

2. **[CONFIRMED, was exploitable] Cross-tenant payment-method IDOR** (`services/billing/src/routes/payment-methods.ts:63`).
   `DELETE /billing/payment-methods/:id` did `paymentMethod.update({where:{id}})` with no
   ownership check. `PaymentMethod` has no `tenantId` column (it hangs off
   BillingProfile→BillableEntity), so the Prisma tenant-guard did not cover it - an
   authenticated user with `settings:billing:manage` could REMOVE another tenant's card
   (billing DoS) given its id. **Fixed:** the delete now resolves the caller's own
   billing profile and scopes via `updateMany({where:{id, billingProfileId}})`, so a
   foreign id matches zero rows. (Same class as H-1/M-2 single-row-op scoping.)

### Hardened (latent / defense-in-depth, not proven exploitable end-to-end)

3. **SSRF `isBlockedIp` IPv6-mapped-hex gap.** `isBlockedIp` only decoded the embedded
   IPv4 of a v4-mapped IPv6 in DOTTED form, so `::ffff:a9fe:a9fe` (=169.254.169.254),
   `::ffff:7f00:1` (=127.0.0.1), NAT64 `64:ff9b::/96`, and v4-compatible forms returned
   `false`. It was NOT reachable through `assertPublicUrl` (URL hostnames keep the
   brackets, so `net.isIP` returns 0 and the bracketed literal fails DNS resolution and
   is blocked) - but the guard was blocking these only INCIDENTALLY, and `isBlockedIp`
   also runs on DNS-resolved addresses. **Hardened:** `isBlockedIp` now fully expands any
   IPv6 to its 16 bytes and blocks mapped/compatible/NAT64 targets in any notation,
   tolerates brackets/zone-ids, and fails safe on unparseable input; `assertPublicUrl`
   strips brackets so IPv6 literals engage the check directly. 10 regression tests added
   (`packages/shared/src/lib/__tests__/safe-fetch.test.ts`).

4. **Nginx header-inheritance incompleteness (LOW).** 5 `location` blocks with their own
   `add_header` (health, embedded-chat CORS, `_next/static`) re-emitted only 3 of the 6
   security headers, dropping X-Frame-Options/Permissions-Policy/CSP on those non-HTML
   responses (browser-facing HTML `location /` was already complete). **Fixed:** all 6
   headers repeated in every such block; both templates re-validated with `nginx -t`.

5. **Salesforce `refreshTokens` loginHost** - the token-refresh fetch skipped
   `assertPublicUrl` (constrained to `*.salesforce.com` by the OAuth-init regex, so not
   exploitable today). Guard added for consistency with the data path.

### Verification evidence

- Typecheck clean across all 12 workspaces. `npm audit --omit=dev`: 1 low.
- `safe-fetch.test.ts` (10) + `webhook-verify.test.ts` (15) pass; webhook suite 7/7
  (incl. new Slack fail-closed + Meta-rejection regressions). Both nginx templates
  pass `nginx -t`. SSRF guard exercised end-to-end against a live loopback server.
- Verdict: the two P0-class webhook/IDOR misses are now closed and regression-guarded;
  the remaining items were latent/low and were hardened. No exploitable P0/P1 path
  found remaining.
