# Enterprise Readiness Audit — Security, ISO 27001, SOC 2 & GDPR

> **Type:** Founder-level enterprise-readiness due-diligence audit (Enterprise SaaS Architect + Security lens).
> **Date:** 2026-07-08 · **Branch:** `feat/customer-intelligence-phase1` (working tree).
> **Method:** Phase-separated (Audit → Vision → Roadmap → Playbook). Every current-state claim is `file:line`-cited from a direct 2026-07-08 code trace. This is a **defensive** audit of the owner's own codebase.
> **Relationship to prior docs:** the `docs/security/` corpus (`SECURITY_ARCHITECTURE.md`, `THREAT_MODEL.md`, `SECURITY_FINDINGS.md` F-001…F-022, `SECURITY_SCORECARD.md`, all dated 2026-05-26) covered an **AI-hardening pass** and **predate the entire onboarding/discovery/billing feature set**. This audit re-verifies every major F-finding against the current tree and adds the new surface (N-findings). It supersedes the scorecard's "Conditional Ready 7.4/10" verdict, which reflected only the AI-hardening scope.
> **Constraint honored:** audit only — no code modified.

---

## Executive Summary

The AI-security posture the 2026-05-26 docs described is **real and has held up** — prompt-injection sandboxing, output validation, tenant isolation, and cost budgets all survived subsequent feature work — and the scorecard's single blocking item (`.env` committed) is **resolved** (`.env` is gitignored and absent from history). That is genuine progress.

But an enterprise-readiness lens is wider than the AI-hardening scope those docs measured, and on that wider lens the verdict is materially lower: the **new onboarding/discovery feature surface introduced fresh HIGH-severity AppSec holes that were never audited**, the **secrets posture regressed in a new way**, and the **GDPR/SOC2/ISO machinery required for an enterprise deal essentially does not exist.**

**The one-sentence verdict:**

> **GOTCHA is a well-hardened AI application and a not-yet-compliant enterprise platform: its prompt/tenant/cost defenses are strong, but a committed service-mesh key, two fail-open trust boundaries (webhook signatures, auth-on-DB-error), an SSRF in the new website crawler, and the total absence of data-subject rights, retention, backups, monitoring, and CI security gates put it Far from GDPR/ISO 27001/SOC 2 Type II.**

**The blocking enterprise-deal issues, ranked:**
1. **Committed/weak service-mesh & signing secrets** — `"chatcenter-internal-2026"` hardcoded in 32 sites + compose (`internal-auth`/`ai.service.ts:324`/`onboarding.ts:27`; `docker-compose.yml:144,341`); the compose `JWT_SECRET` default is ≥16 chars so it **passes** the F-004 prod guard while being repo-known (`docker-compose.yml:83`). Internal key = ADMIN-on-any-tenant (`auth.ts:23-31`).
2. **Public role escalation** — `/api/auth/register` accepts client `role` up to SYSTEM_ADMIN (`auth.ts:12`). *(Shared with the entitlements audit.)*
3. **Webhook signature fail-open** — omitting `x-hub-signature-256` bypasses verification entirely (`webhook.ts:88-95`); forged inbound message injection.
4. **SSRF in the onboarding crawler** — user-supplied domain fetched with `redirect:follow` and only a `^https?` check; no private-IP/metadata block (`onboarding.ts:1218,1383-1404`).
5. **No GDPR data-lifecycle machinery** — no erasure, export, consent, or retention (Art. 15/17/20 unmet).
6. **No CI/CD security gates** — no `.github/` at all: no dependency/secret scanning, no SAST, no change control.
7. **No backups/DR, no monitoring/alerting/structured logs.**
8. **Auth fail-open on DB error** (F-011, unchanged) and **audit log fire-and-forget & mutable** (F-019, unchanged).

**Overall enterprise-readiness score: 4.5/10** — strong AI/app hardening (7.5/10) dragging against near-zero compliance infrastructure (2/10) and two new HIGH AppSec holes. **Not enterprise-ready; a focused P0/P1 closes the exploitable holes and a P2/P3 builds the compliance surface.**

---

# PHASE 1 — CURRENT STATE AUDIT

## 1.1 Evidence base & method

Direct trace (2026-07-08): `packages/shared/src/{lib/jwt.ts,lib/encryption.ts,middleware/{auth,tenant}.ts}`, `services/webhook/src/routes/webhook.ts`, `services/auth/src/routes/{onboarding,system,auth}.ts`, `services/ai/src/{routes/ai-assist.ts,services/{prompt-sanitizer,output-validator,cost-budget,audit,qdrant}.service.ts}`, `docker-compose*.yml`, `nginx/*.template`, `gateway/*.template`, `packages/shared/prisma/schema.prisma`. Each 2026-05-26 F-finding re-checked against current code.

## 1.2 Area-by-area posture

### Tenant isolation — STRONG (improved since docs)

- Pattern: every table carries `tenantId`; **no DB-level RLS** — correctness depends on each Prisma `where` including `tenantId`. `resolveTenant` makes JWT tenant authoritative for non-admins and rejects rather than silently resolving undefined (`tenant.ts:26-77`).
- Sampled >10 routes across auth/conversation/ai/analytics/chatbot: all tenant-scoped. The new onboarding services (`onboarding-state`, `recommendations`, `nudge-engine`, `employee-tuning`) and AI endpoints (`ai-assist.ts:39,70,100`) are all properly scoped.
- **CHANGED vs docs:** F-002 (cross-tenant `findUnique` long-tail) is **substantially remediated** — `voice-channels.ts` down to 2 id-only lookups, both guarded (`:518-521, 1286-1290`); 21 `tenantId !==` guards now present.
- **Residual (LOW):** still convention-based — one missed `where` in future code silently leaks; `system.ts:29` deliberately opts the system router out of the tenant guard (by design for SYSTEM_ADMIN).

### Secrets & encryption — MIXED (one fix, one regression)

- **App-level encryption at rest — GOOD:** AES-256-GCM (`encryption.ts`) for channel tokens (verified on the WhatsApp write path `channels.ts:404`), integrations, connectors, calendar OAuth, Twilio secrets. (Stale schema comment on `ChannelAccount.credentials` — the write path does encrypt.)
- **JWT (F-004) — FIXED:** `resolveJwtSecret()` throws in prod on missing/<16-char secret (`jwt.ts:12-21`).
- **F-010 (`.env` committed) — REMEDIATED:** not tracked, not in history, `.gitignore:5-7` excludes it. This was the scorecard's single gating item.
- **NEW N-1 [CRITICAL] — committed internal-service key:** `"chatcenter-internal-2026"` hardcoded fallback in 32 sites + compose default; grants `role:ADMIN` on any tenant. If unset in prod, the mesh root credential is a public git string.
- **NEW N-4 [MEDIUM] — weak compose defaults that defeat the F-004 guard:** `JWT_SECRET:-change-me-in-production-min-32-chars!!` is ≥16 chars so it **passes** the prod throw; `SYSTEM_ADMIN_SETUP_SECRET`/`POSTGRES_PASSWORD` similarly weak.
- **No KMS/Vault** (all env-based). **TLS:** nginx templates have no `listen 443`/`ssl_certificate` — they proxy plain HTTP; the "nginx terminates TLS" claim is **not evidenced in-repo** (presumably an external LB — unverified).

### Audit logging — PARTIAL

- `AuditLog` model (`schema.prisma:2568-2586`); AI tool execution + every bot turn write rows (`action-executor.service.ts:688`, `ai-bot.service.ts:3503`); CLAUDE.md "log every AI interaction" is met for the autonomous-bot path.
- **F-019 UNCHANGED [MEDIUM]:** fire-and-forget; a DB blip loses the evidence (`audit.service.ts:51-54`).
- **No user-visible audit trail; no retention/immutability/WORM** — ordinary mutable rows (a SOC2/ISO gap).
- **Gap:** the two grandfathered auth-side LLM calls log usage but **no audit row** (cross-ref onboarding audit T-6).

### Data lifecycle / GDPR — WEAKEST AREA (largely new territory)

- **Retention/TTL cleanup: NONE** — all TTL hits are in-memory caches; no job purges Messages/Conversations/AuditLog/BusinessDiscovery/embeddings. Data retained indefinitely.
- **Right-to-erasure: NONE** — per-object operational deletes exist (`conversations.ts:188`, tenant-level cascade delete `system.ts:352`), but no endpoint erases a single end-user (by phone/email) across a tenant; no self-service tenant deletion.
- **Export/portability: NONE for customer data** — only a SYSTEM_ADMIN waitlist CSV (`waitlist.ts:179`).
- **Consent capture: NONE** — all `consent` hits are OAuth `prompt=consent`; no cookie or message-processing consent anywhere.
- **PII inventory:** `Message.body`, `Customer`, `Conversation.customerName`, CRM prefetch cache, KB→Qdrant embeddings, `SystemAgentMessage.content`, and **NEW** `BusinessDiscovery` (business emails/phones/WhatsApp/brand voice/free-text report — plaintext JSON, DB-only protection, `schema.prisma:778-813` — N-8).
- **Subprocessors receiving PII:** OpenAI (every turn), Meta, Twilio, Zoho/HubSpot, Google, Calendly, Qdrant. **No DPA/subprocessor register in-repo.**
- **Severity: HIGH enterprise/GDPR blocker.**

### AI-specific — STRONG (held up)

- Prompt-injection defenses (F-003/F-005/F-007) intact: `sanitizeUntrusted` wired into customer/crm/memory/template/knowledge blocks (`prompt-builder.service.ts:535-544,1346`); output validator + cost budget present.
- No PII in logs on the hot files; `log-redact.ts` exists.
- Qdrant tenant filter enforced (`qdrant.service.ts:108`).
- Residual footgun (unchanged): a tenant that sets all tools ALLOW lets the bot act on injected instructions.
- **NEW low-risk surface:** the business-discovery LLM ingests attacker-controllable crawled text but only produces a tenant-facing report (not fed to the customer bot's tool loop) — low blast radius, unsanitized.

### AppSec basics — MIXED, two new HIGH

- **NEW N-3 [HIGH] SSRF:** onboarding `fetchHomepageText`/`fetchPageRaw` fetch a user-supplied domain with `redirect:follow`, only `^https?` validation, **no private-IP/metadata/localhost block** (`onboarding.ts:1218,1383-1404`). Content-type gate limits exfil; the request still fires at internal services / cloud metadata.
- **NEW N-2 [HIGH] webhook fail-open:** verification runs only `if (signature)` and only `if (appSecret && rawBody)` (`webhook.ts:88-95`) — omit the header, bypass entirely; forged WhatsApp/Meta inbound injection. (Slack path correctly uses `timingSafeEqual`.)
- Input validation: `zod` in 17 files — not universal; many routes hand-roll checks.
- XSS: 3 `dangerouslySetInnerHTML`, all static/safe (no user-data injection).
- CORS: wildcard scoped only to `/api/embedded-chat` (intentional widget); no broad misconfig.
- Auth is Bearer-JWT (low CSRF surface); login rate-limited 30/15min but **no lockout/captcha/backoff**.
- Dependency hygiene: single lockfile; **no `npm audit`/Snyk/Dependabot**.
- **NEW N-5 [MEDIUM]:** nginx emits no HSTS/CSP/X-Frame-Options/X-Content-Type-Options.

### Ops readiness — WEAK

- Logging: `console.*` throughout; **no structured logging/aggregation** (no pino/winston/ELK/Datadog).
- Health checks: present in `docker-compose.prod.yml`.
- **NEW N-9: no postgres backup strategy** anywhere (no pg_dump/WAL/barman).
- Incident response: none. Environment separation: dev/override/prod compose present.
- **NEW N-7 [MEDIUM]: no `.github/` at all** — no CI, no automated audit, no secret scanning, no SAST.

## 1.3 F-finding reconciliation (2026-05-26 → 2026-07-08)

| ID | 2026-05-26 status | Current | Evidence |
|---|---|---|---|
| F-001 embedded-chat rate limit | Patched | **Holds** | limiters live |
| F-002 cross-tenant findUnique | Partial/roadmap | **Largely remediated** | `voice-channels.ts:518-521,1286-1290`; new services scoped |
| F-003 CRM prompt injection | Patched | **Holds** | `prompt-builder.service.ts:538` |
| F-004 JWT `change-me` | Patched | **Holds** (but N-4 compose default defeats it) | `jwt.ts:12-21` vs `docker-compose.yml:83` |
| F-005 output validator | Patched | **Holds** | wired |
| F-006 cost ceiling | Patched | **Holds** | cost-budget live |
| F-007/F-008 input sanitization | Patched | **Holds** | sanitizer intact |
| F-009 token log redaction | Patched (top sites) | **Holds** | log-redact present |
| **F-010 `.env` committed** | OPEN (the gate) | **REMEDIATED** | gitignored, not in history |
| F-011 auth fail-open on DB | Open | **Unchanged** | `auth.ts:47-50` |
| F-019 audit fire-and-forget | Documented | **Unchanged** | `audit.service.ts:51-54` |
| F-012/14/15/17 | Roadmap | Not re-verified this pass | — |

**New since the docs (never audited):** N-1 committed internal key, N-2 webhook fail-open, N-3 SSRF, N-4 weak compose defaults, N-5 missing security headers, N-6 GDPR machinery absent, N-7 no CI gates, N-8 BusinessDiscovery plaintext PII, N-9 no backups; plus the entitlements audit's register-role escalation.

## 1.4 What works well (do not redesign)

1. **AI prompt-security stack** — sanitizer + output validator + cost budget. Category-leading for a platform this age. Keep.
2. **Tenant-isolation pattern + the F-002 cleanup** — JWT-authoritative resolveTenant, near-complete guard coverage. Keep; harden with a Prisma middleware backstop (see vision).
3. **App-level AES-256-GCM for credentials.** Correct. Keep; extend to BusinessDiscovery PII.
4. **AI-action audit coverage** for the bot path. Keep; fix durability (F-019).
5. **`.env` remediation.** The one gate closed. Keep it closed.

## 1.5 Compliance mapping (honest)

| Framework | Distance | Rationale |
|---|---|---|
| **GDPR** | **Far** | No consent, no erasure/export, no retention, no DPA/subprocessor register; AES + isolation are the only present pillars |
| **SOC 2 Type I** | **Moderate** | Audit log/RBAC/encryption exist; blockers: fire-and-forget mutable audit, no CI change-control, weak/committed secrets, no backup evidence, no monitoring |
| **SOC 2 Type II** | **Far** | Needs operating-effectiveness over time: automated evidence, alerting, backup/restore tests, vuln mgmt, IR — essentially none |
| **ISO 27001** | **Far** | No ISMS, no risk register beyond these docs, no supplier mgmt, no BCP/DR |

## 1.6 Scores (0–10)

| Area | Score | Justification |
|---|---|---|
| AI prompt security | **8.0** | Sanitizer/validator/budget, held up |
| Tenant isolation | **7.5** | Strong pattern, F-002 cleaned; convention-based residual |
| Credential encryption | **7.0** | AES-256-GCM broad coverage; BusinessDiscovery PII plaintext |
| Secrets management | **3.5** | `.env` fixed; committed internal key + weak compose defaults |
| Authentication robustness | **5.0** | Sound primitives; register escalation, fail-open, no lockout |
| AppSec (input/SSRF/webhook) | **4.0** | zod partial; SSRF + webhook fail-open new HIGHs |
| Audit logging | **5.0** | Coverage good; fire-and-forget, mutable, no retention |
| Data lifecycle / GDPR | **1.5** | Erasure/export/consent/retention absent |
| Ops readiness (logs/backup/IR) | **2.5** | Health checks only; no backups/monitoring/CI |
| Security headers / TLS evidence | **3.0** | No HSTS/CSP; TLS termination unverified in-repo |
| **Overall enterprise readiness** | **4.5** | Strong app hardening, near-zero compliance infra |

---

# PHASE 2 — VISION

*First principles. The AI/app hardening is strong and stays; the vision is a compliance and trust-boundary surface an enterprise buyer's security team can pass — not a rewrite.*

## 2.1 Trust boundaries fail closed, not open

Every boundary that currently fails open becomes fail-closed with an explicit, monitored exception: webhook signatures **required** (reject unsigned); auth-on-DB-error backed by a Redis liveness cache so a blip doesn't admit a revoked user; the internal service key **required at boot** (no default) and rotated; SSRF closed by an allowlist / private-range block / disabled redirects on every server-side fetch. **Why:** an enterprise security review fails the moment it finds one "if the check can't run, allow it" — and this codebase has four.

## 2.2 Secrets have one source and none are in git

All secrets move to a secrets manager (or at minimum required-at-boot env with no committed fallback); the 32 hardcoded internal-key fallbacks and the weak compose defaults are deleted; a secret-scanner (gitleaks) in CI makes a future committed secret impossible to merge. **Why:** the `.env` fix proved the discipline; N-1/N-4 prove it isn't yet systematic.

## 2.3 The data subject has rights

A GDPR surface exists as first-class product capability: **erasure** (delete a customer by identifier across a tenant, cascade to messages/memory/embeddings), **export** (portable per-subject/per-tenant bundle), **consent** (message-processing + cookie consent captured and honored), **retention** (configurable TTL jobs purging messages/conversations/discovery/embeddings), and a **subprocessor register + DPA** surfaced to the buyer. **Why:** these are hard gates for any EU enterprise deal and none exist today.

## 2.4 The platform is observable and recoverable

Structured logging with aggregation and alerting on the security signals the codebase already audits (output-validator blocks, budget aborts, rate-limit 429s, auth anomalies); postgres backups with tested restore; an incident-response runbook. **Why:** SOC 2 Type II is "operating effectiveness over time" — unmeasurable without these.

## 2.5 CI is a security gate

`.github/` with dependency scanning (Dependabot/`npm audit`), secret scanning (gitleaks), and SAST (CodeQL) on every PR; the tenant-isolation invariant (every Prisma query tenant-scoped) enforced by a Prisma middleware backstop + a lint/test. **Why:** change-control evidence is a SOC 2/ISO control, and it also prevents the next N-1.

## 2.6 What should remain exactly as it is

The prompt-sanitizer/output-validator/cost-budget stack; the JWT-authoritative resolveTenant pattern; AES-256-GCM credential encryption; the AI-action audit coverage; the embedded-chat rate limiters; the Slack `timingSafeEqual` verification (the correct pattern the Meta path should copy). Correct — do not touch for novelty.

## 2.7 What should disappear

The committed internal-key fallbacks; the weak compose defaults; the client-supplied `role` in register; the fail-open branches on trust boundaries; unbounded indefinite retention.

---

# PHASE 3 — ROADMAP

> Sequencing law: **exploitable holes first (P0), fail-closed boundaries + secrets discipline (P1), GDPR/compliance surface (P2), full SOC2/ISO evidence (P3).** No compliance work matters while an unauthenticated forged-message or SSRF path is open.

## P0 — Close the exploitable holes (days)

**Objective:** nothing an external attacker can trivially exploit remains.
**Scope:** rotate + require-at-boot the internal service key, delete the 32 fallbacks + weak compose defaults [N-1,N-4]; register server-assigns role [entitlements S-1]; enforce mandatory webhook HMAC, reject unsigned [N-2]; SSRF guard (allowlist + private-range/metadata block + no redirects) on onboarding fetches [N-3]; add security headers (HSTS/CSP/X-Frame-Options/X-Content-Type-Options) [N-5].
**Business value:** removes the findings a buyer's pentest would flag on day one.
**Risk:** low-medium — mandatory webhook verification could drop legitimate unsigned traffic (verify all live providers send signatures first); SSRF allowlist must permit legitimate customer domains (block private ranges, not public ones). **Complexity:** S-M. **Dependencies:** none; coordinate with entitlements P0.
**Success criteria:** boot refuses without an internal key; forged unsigned webhook rejected; discovery cannot reach `169.254.169.254`/localhost/private ranges; no client role accepted; headers present.
**Verification:** unsigned webhook → 401; discovery against a metadata URL → blocked; register elevated role → AGENT; `curl -I` shows headers.

## P1 — Fail-closed boundaries + secrets discipline (2–4 weeks)

**Objective:** no trust boundary fails open; no secret is in git.
**Scope:** Redis-backed liveness cache to replace auth fail-open [F-011]; durable audit (Redis stream → idempotent Postgres writer) [F-019]; secrets manager (or required-at-boot everywhere) + gitleaks in CI; login lockout/backoff; encrypt BusinessDiscovery PII at rest [N-8]; Prisma tenant-scope middleware backstop.
**Business value:** the boundaries a security questionnaire probes all pass.
**Risk:** medium — the liveness cache and audit-stream are new infra; the Prisma backstop must not break intentional cross-tenant SYSTEM_ADMIN reads (exempt the system router). **Complexity:** M. **Dependencies:** P0.
**Success criteria:** a DB blip no longer admits a revoked user; audit writes survive a DB blip; no committed secret can merge; discovery PII encrypted.
**Verification:** simulate DB outage → revoked user rejected; kill DB during an audit write → row reconciled from the stream; gitleaks blocks a test secret.

## P2 — The GDPR surface (4–8 weeks)

**Objective:** data-subject rights, retention, consent, subprocessor transparency.
**Scope:** erasure endpoint (delete a customer by identifier across a tenant + embeddings) [N-6]; per-subject/per-tenant export; message-processing + cookie consent capture and enforcement; configurable retention TTL jobs (messages/conversations/discovery/embeddings/audit within legal minimums); subprocessor register + DPA surface; self-service tenant deletion.
**Business value:** unblocks EU enterprise deals.
**Risk:** medium-high — erasure must cascade correctly (messages, memory, embeddings, CRM mirror) without orphaning; retention must respect audit-log legal minimums. **Complexity:** L. **Dependencies:** P1 (durable audit, encryption).
**Success criteria:** a data-subject request is fulfillable end-to-end (erase + export); retention jobs run; consent is captured and honored.
**Verification:** erase a test customer → gone from Message/Customer/memory/Qdrant; export returns a complete bundle; retention job purges past-TTL rows; consent withdrawal stops processing.

## P3 — SOC 2 / ISO 27001 evidence machinery (quarter+)

**Objective:** operating-effectiveness evidence over time.
**Scope:** structured logging + aggregation + alerting on the audited security signals; postgres backups with tested restore + DR runbook; incident-response plan; full CI security suite (Dependabot + gitleaks + CodeQL) as required gates; access reviews; the ISMS/risk-register artifacts; TLS termination made explicit and verifiable.
**Business value:** SOC 2 Type II / ISO 27001 attestation becomes achievable.
**Risk:** low-medium; mostly additive + process. **Complexity:** L. **Dependencies:** P0-P2.
**Success criteria:** an auditor can pull change-control, monitoring, backup-restore, and IR evidence; alerting fires on the security signals.
**Verification:** restore from backup in a drill; trigger an output-validator block → alert fires; CI blocks a vulnerable dependency.

---

# PHASE 4 — IMPLEMENTATION PLAYBOOK (for Claude Sonnet)

> NO CODE. Backend/shared changes: rebuild images, `nginx -s reload`. **Treat P0 as blocking for the whole roadmap.** **Never** weaken a boundary to "unblock" a test — fix the caller.

## 4.1 Implementation order

**P0:** (1) internal key required + rotate + delete fallbacks → (2) register role server-assign → (3) mandatory webhook HMAC → (4) SSRF guard → (5) security headers.
**P1:** (6) Redis liveness cache (auth) → (7) durable audit stream → (8) secrets manager + gitleaks → (9) login lockout → (10) BusinessDiscovery PII encryption → (11) Prisma tenant-scope backstop.
**P2:** (12) erasure → (13) export → (14) consent capture → (15) retention jobs → (16) subprocessor register/DPA.
**P3:** (17) structured logging + alerting → (18) backups + restore drill + DR runbook → (19) CI security suite → (20) IR plan + ISMS artifacts.

## 4.2 Key architecture decisions (made)

- **SSRF guard:** a shared `safeFetch` util (resolve host → reject if private/loopback/link-local/metadata; disable redirects or re-validate each hop; keep the existing content-type + timeout caps) used by both onboarding fetch sites and any future server-side fetch. Do NOT allowlist by domain (customers have arbitrary domains) — **block private ranges, allow public.**
- **Webhook verification:** make signature presence mandatory per provider; copy the Slack `timingSafeEqual` pattern to the Meta path; reject (401) unsigned. Add a per-provider "verification required" flag so a provider that genuinely can't sign is an explicit, logged exception, not a silent bypass.
- **Auth fail-open replacement:** Redis-backed `isActive` cache (TTL ≈ JWT lifetime); on DB error, read the cache; only if the cache is also unavailable, fail **closed** for privileged roles.
- **Durable audit:** `logAudit` writes to a Redis stream; a small consumer idempotently writes to Postgres; the row is immutable (append-only; no update path) and retention-tagged.
- **Secrets:** required-at-boot with no committed fallback (minimum); gitleaks pre-merge. The internal key becomes a per-environment secret; rotate on deploy.
- **GDPR erasure:** a tenant-scoped `eraseCustomer(identifier)` that cascades Message/Customer/Conversation/AgentCustomerMemory + a Qdrant delete-by-filter + CRM-mirror note; transactional where possible, compensating where cross-store.
- **Retention:** a scheduled job (reuse the nudge-engine BullMQ pattern) with per-entity TTL config; audit-log retention respects a legal minimum floor.

## 4.3 Files likely affected

- **Shared:** `middleware/auth.ts` (Redis liveness), `lib/audit` (stream), new `lib/safe-fetch.ts`, `middleware/tenant.ts` (Prisma backstop), `lib/encryption.ts` (BusinessDiscovery PII).
- **Webhook:** `services/webhook/src/routes/webhook.ts` (mandatory HMAC).
- **Auth:** `routes/auth.ts` (register role, lockout), new GDPR routes (erasure/export/consent), retention job.
- **AI:** `services/business-discovery` + `onboarding.ts` fetch sites (`safeFetch`), Qdrant erasure.
- **Infra:** `docker-compose*.yml` (delete weak defaults, secrets), `nginx/*.template` + `gateway/*.template` (security headers, TLS), new `.github/workflows/*`.

## 4.4 Database migrations

- Additive: consent records, retention config, `BusinessDiscovery` PII encryption (encrypt-in-place migration for existing rows), immutable audit-stream table if separate.
- No destructive changes required for the security work; erasure operates on existing tables.

## 4.5 API changes

- `POST /api/auth/register`: drop `role` (cross-ref entitlements).
- Webhook routes: 401 on missing/invalid signature (was 200-through).
- New: `DELETE /api/customers/:identifier` (erasure), `GET /api/export` (portability), consent capture endpoints.
- No change to AI/kernel contracts.

## 4.6 AI changes

- No new LLM calls. `safeFetch` wraps the discovery crawler (behavior-preserving except blocking private targets). Qdrant gains a delete-by-tenant-and-subject path for erasure.

## 4.7 Regression risks

- **Mandatory webhook verification** could drop live traffic — verify every production provider signs before flipping; ship the per-provider exception flag first.
- **SSRF guard** could block legitimate customer sites behind CDNs resolving to shared IPs — block only RFC-1918/loopback/link-local/metadata, not public IPs; test against real customer domains.
- **Auth fail-closed** could lock users out during a DB+Redis double outage — scope fail-closed to privileged roles; keep low-privilege read paths degrade-safe.
- **Erasure cascade** could orphan or over-delete — dry-run mode + a scoped transaction; verify Qdrant + CRM mirror included.
- **Retention jobs** could delete audit evidence needed for compliance — enforce a legal-minimum floor.

## 4.8 Manual QA checklist

- [ ] Boot with unset internal key → refuses; rotated key → S2S works; grep shows no `chatcenter-internal-2026` in source/compose.
- [ ] Unsigned/forged webhook → 401; correctly-signed → processed.
- [ ] Discovery against `http://169.254.169.254`, `http://localhost`, `http://10.0.0.1` → blocked; against a real public domain → works.
- [ ] Register elevated role → AGENT; login lockout after N failures.
- [ ] Security headers present on all responses.
- [ ] DB-outage sim: revoked user rejected (not admitted); audit row survives via stream.
- [ ] Erasure: customer gone from Message/Customer/memory/Qdrant/CRM-note; export returns complete bundle.
- [ ] Consent withdrawal halts processing; retention job purges past-TTL rows (audit floor respected).
- [ ] BusinessDiscovery PII encrypted at rest.

## 4.9 Automated testing checklist

- [ ] `safeFetch` unit tests (private/loopback/link-local/metadata blocked; public allowed; redirect handling).
- [ ] Webhook signature tests (missing → 401, wrong → 401, valid → 200) per provider.
- [ ] Auth liveness-cache tests (DB down + cache hit → correct; both down → fail-closed for privileged).
- [ ] Register-role rejection test.
- [ ] Tenant-scope Prisma backstop test (a query missing tenantId is caught).
- [ ] Erasure cascade test (all stores); export completeness test.
- [ ] gitleaks + `npm audit` + CodeQL wired as CI gates (a planted secret/vuln fails the build).

## 4.10 Rollout / rollback

- **Rollout:** P0 immediately, per-service. Webhook mandatory-verification behind a per-provider flag (exception → enforce). SSRF guard is behavior-preserving for public targets → ship directly. Auth fail-closed staged: cache first (observe), then fail-closed for privileged. GDPR/retention behind flags with dry-run first.
- **Rollback:** security-forward changes (register, internal key, SSRF, webhook) are **fix-forward, not rollback** — a rollback re-opens the hole. Infra/CI additions are inert to revert. Erasure/retention gated by dry-run + flags so they can be disabled without data loss.

## 4.11 Definition of Done (per phase)

- **P0:** no committed secret; forged webhook rejected; SSRF closed; no client role; headers present.
- **P1:** no boundary fails open; audit durable; secrets required-at-boot + scanned; discovery PII encrypted.
- **P2:** a full data-subject request (erase + export) is fulfillable; consent + retention live; subprocessor register published.
- **P3:** an auditor can pull monitoring/backup-restore/change-control/IR evidence; alerting fires on security signals.

---

# VERIFICATION CHECKLIST (audit integrity)

- [x] Every current-state claim cited to working-tree `file:line` (2026-07-08).
- [x] Every major 2026-05-26 F-finding re-verified against current code (§1.3), not assumed: F-010 remediated, F-002 largely remediated, F-011/F-019 unchanged, AI-hardening F-findings hold.
- [x] New surface (onboarding/discovery/billing) audited fresh: N-1…N-9 with severities.
- [x] Compliance distance stated honestly per framework (§1.5) — Far for GDPR/ISO/SOC2-II.
- [x] Superseded the scorecard's "Conditional Ready 7.4/10" (AI-hardening scope) with a full enterprise-readiness verdict (4.5/10).
- [x] No code, migrations, or tasks created. Cross-references: register-role escalation + internal key → shared with `docs/architecture/platform-entitlements-audit.md`; discovery SSRF/PII → `docs/product/onboarding-platform-audit.md`; AI-action audit coverage → `docs/product/ai-employee-platform-audit.md`.
