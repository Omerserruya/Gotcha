> **Superseded note (2026-07-16):** Any findings or descriptions below concerning local JWT signing, bcrypt passwords, refresh tokens, magic links, or register/login endpoints are obsolete. GOTCHA's custom authentication was removed and replaced by Authentik (OIDC, RS256/JWKS). See `docs/security/authentik-architecture.md` for the current architecture; this document is kept as a historical record.

# GOTCHA - Security & Compliance Master Plan

> **The permanent Security & Compliance Bible of GOTCHA.**
>
> **Date:** 2026-07-16 · **Branch:** `feat/customer-intelligence-phase1` · **Lens:** startup securing itself for its first serious customers, not Fortune 500.
> **Method:** direct code trace. Every claim carries a `file:line`. Anything unprovable from code or config is marked **UNKNOWN** rather than guessed.
> **Optimized for:** Shopify PCD approval · GDPR · ISO 27001 readiness · customer trust · a secure AI platform.
> **Explicitly NOT optimized for:** SOC 2 bureaucracy, enterprise ceremony, or complexity for its own sake.

---

## 0. How to read this document

This supersedes the status claims in `SECURITY_SCORECARD.md` (2026-05-26) and extends `enterprise-readiness-audit.md` (2026-07-08). Where those docs and the code disagree, **the code wins and this document records the correction.**

Three rules this document is built on, learned the hard way from auditing the prior audits:

1. **A control that exists as a file is not a control.** It counts only when a live call site is proven. Two of the previous audit's "Patched" claims were modules that were written, unit-tested, and never called.
2. **A passing test is not proof of integration.** The prior security suite passed green while the module it tested was dead code.
3. **Never assume a finding is true because a prior doc said so.** The old scorecard's single blocking item (F-010, "`.env` committed") never happened.

---

## 1. Executive summary

**Verdict: GOTCHA is a well-engineered AI platform with two unauthenticated total-compromise paths and essentially no compliance surface. It is not launch-safe today, and it is weeks away from being submittable to Shopify.**

The AI-security stack is genuinely strong and should not be redesigned. The AWS/Terraform layer is genuinely well built. The problems are (a) two remotely exploitable authentication holes, (b) the config riding on top of good infrastructure, and (c) a compliance surface that mostly does not exist.

### The two findings that matter more than everything else combined

**C-1 - Anyone on the internet can mint a SYSTEM_ADMIN account.**
`POST /api/auth/register` accepts a client-supplied `role` and has no authentication middleware, only a rate limiter (`services/auth/src/routes/auth.ts:12,24,27`; mounted `services/auth/src/index.ts:20,33`). The role is written straight to the database and a matching JWT is signed and returned (`services/auth/src/services/auth.service.ts:26,30-40`). `SYSTEM_ADMIN` may then impersonate any tenant via the `x-tenant-id` header (`packages/shared/src/middleware/tenant.ts:42-53`). Tenant slugs are user-facing (typed into the login page).

```
POST /api/auth/register
{"email":"x@x.com","password":"12345678","name":"x","role":"SYSTEM_ADMIN","tenantSlug":"<known slug>"}
→ valid SYSTEM_ADMIN token → read every tenant's data
```

**C-2 - The production internal-service key is a public string, and it grants ADMIN on an attacker-chosen tenant.**
`packages/shared/src/middleware/auth.ts:25-31`: any Bearer token equal to `INTERNAL_SERVICE_KEY` yields `role:"ADMIN"` scoped to **whatever tenant the caller names in `x-tenant-id`**. That key's live production value (`.env.prod:105`) is byte-identical to the published `.env.example:36` value `chatcenter-internal-2026`, which is additionally hardcoded as a `||` fallback at **42 sites** (`grep -rn "chatcenter-internal-2026"`), so rotating the env var alone does not close it. And nginx prefix-matching exposes internal routers: `location /api/agent` (`gateway/nginx.prod.conf.template:525`) matches `/api/agent-loop` (`services/ai/src/index.ts:112`).

```
Authorization: Bearer chatcenter-internal-2026
x-tenant-id: <any victim tenant>
→ ADMIN on that tenant, from the internet, with no account
```

These are independent. Either alone is a full breach of every tenant's customer data. **Nothing else in this plan matters until both are closed.**

### Scores (0-10)

| Area | Score | One-line justification |
|---|---:|---|
| AI prompt security | **7.5** | Sanitizer/validator/budget real and wired - but chat history is unsanitized on every non-webchat channel |
| Tenant isolation (design) | **7.5** | JWT-authoritative `resolveTenant` + Prisma guard extension; no live leak found |
| Tenant isolation (backstop coverage) | **4.0** | Guard lists 28 of 82 tenant-scoped models; exempts `findUnique`/`update`/`delete` |
| Credential encryption | **7.0** | AES-256-GCM broadly applied; PCD/PII in `AuditLog`/`ToolExecution` plaintext |
| Authentication | **1.0** | C-1 unauthenticated SYSTEM_ADMIN escalation; fail-open on DB error |
| Secrets management | **2.0** | `.env` never committed (good) but prod secrets == public example values |
| Infrastructure (AWS/Terraform) | **8.0** | No inbound 80/443, IMDSv2, encrypted EBS, scoped IAM, real backups |
| Infrastructure (config on top) | **3.0** | `POSTGRES_PASSWORD=postgres` in prod; deploy script ships `.env.example` |
| AppSec (SSRF/webhook/headers) | **3.5** | Webhook HMAC fail-open; SSRF in crawler; no security headers |
| Audit logging | **4.5** | Good AI coverage; fire-and-forget, mutable, no retention, stores raw PII |
| Data lifecycle / GDPR | **1.5** | No erasure, export, consent, or retention anywhere |
| Ops (monitoring/DR) | **4.0** | Real backups + alarms, but alarms notify nobody and restore is untested |
| Vulnerability management | **1.0** | 17 vulns (9 high) in prod deps; no CI to catch them |
| Documentation / policies | **1.0** | Zero policy documents exist |
| **Overall** | **3.5** | Strong engineering, two open front doors, near-zero compliance |

---

## 2. Corrections to the existing security corpus

Auditing the auditors was a required part of this pass. Findings:

| Prior claim | Source | Reality | Evidence |
|---|---|---|---|
| **F-010 `.env` committed to git** - the scorecard's *sole* blocker to "Ready" | `SECURITY_FINDINGS.md:109-113` | **Never happened.** `.env`/`.env.prod` are absent from every commit in history. Likely a misread of `git status` untracked output | `.gitignore:5-6`; per-commit `git cat-file -e <c>:.env` over all history → no hit |
| **F-007 "sanitizer module wired in"** | `SECURITY_FINDINGS.md:89` | **False.** `sanitizeChatHistoryBody` is dead code; `ai-bot.service.ts` contains zero `sanitiz` occurrences | `services/ai/src/services/ai-bot.service.ts:2019-2025` pushes `content: m.body` raw; only callers of the fn are its definition + tests |
| **F-009 "module + the loudest 4 call sites"** | `SECURITY_FINDINGS.md:107` | **False.** Zero production call sites for `redact()`/`safeLogger` | `calendar-oauth.ts:243` still `console.error(..., await tokenRes.text())` - raw token response body |
| **"125 tests passed (125)"** | `SECURITY_SCORECARD.md:153` | **Not reproducible.** Real: 147 tests, **145 pass, 2 fail** (stale mocks: `_sum.tokensTotal` vs service's `tokensEquivalent`) | `services/ai/src/__tests__/security/cost-budget.test.ts:78,93` vs `cost-budget.service.ts:140-142` |
| **N-9 "no postgres backup strategy anywhere"** | `enterprise-readiness-audit.md:99` | **Wrong.** Nightly `pg_dump` + uploads tarball → S3, cron 02:30; DLM EBS snapshots. The audit never read `terraform/` | `terraform/user_data.sh:108-145`; `terraform/s3.tf:31-38`; `terraform/cloudwatch.tf:7-34` |
| **F-015 custom-DB SQL injection (Roadmap, risk Medium-High)** | `SECURITY_SCORECARD.md:46` | **Under-claimed - actually closed.** Parameterized binding, no concatenation | `services/ai/src/services/connectors/custom-db.service.ts:146,169` |
| **F-017 `ai-debug` needs gate tightening (Roadmap)** | `SECURITY_SCORECARD.md:48` | **Under-claimed - already stronger than recommended.** Fails closed; env key or single-use TTL JIT minted SYSTEM_ADMIN-only | `services/ai/src/routes/ai-debug.ts:62-89,94` |
| **"Fine-grained permission system built but unenforced"** | project memory / `project_rbac_audit` | **Partially refuted.** `requirePermission` *is* enforced - at **11** call sites, all in `services/billing` - vs `requireRole` at **212** sites across 8 services. A **bridge** now exists that did not before (`packages/shared/src/middleware/rbac.ts:44-53`). The finding is not "unenforced" but **A.8.2 inconsistency**: two models, no single authoritative answer | `services/billing/src/routes/{subscription,invoices,credits,payment-methods}.ts` |
| **N-5 "missing security headers"** | `enterprise-readiness-audit.md:93` | **Overstated.** `helmet()` is applied to every service (`packages/shared/src/lib/service-app.ts:19`). True **only** for the nginx-served static frontend | `service-app.ts:19` |
| **N-4 "weak compose defaults"** | `enterprise-readiness-audit.md:56` | **Fixed in prod.** `docker-compose.prod.yml:119,126,174` use `:?required`. Still true for dev | `docker-compose.prod.yml:119` |

**The pattern:** the previous corpus mixes real engineering with unverified status claims. Seven controls are genuinely wired; two were claimed and never existed; one blocker was fictional. This is why every claim here cites a call site.

---

## 3. PART 1 - Shopify Protected Customer Data

### 3.1 Why Shopify rejects the request - the direct answer

The team's working theory (per project memory) is that the 403s are a Partner Dashboard approval matter, not code. **That is correct about the 403 and dangerously incomplete about the approval.**

> **The three mandatory compliance webhooks do not exist. Not stubbed - absent.**

A repo-wide grep for `customers/data_request`, `customers/redact`, `shop/redact` (and underscore variants) returns **zero hits**. The webhook service registers only `/`, `/email`, `/gmail`, `/outlook`, `/slack` (`services/webhook/src/routes/webhook.ts:27,42,388,451,555,627`). No Shopify webhook route exists anywhere.

Shopify checks this first and mechanically. **Submitting today is rejected within minutes, and no amount of Partner Dashboard paperwork changes that.** The approval is not a rubber stamp; it is the review that inspects exactly what is missing here.

Worse, `customers/redact` is not merely unimplemented - **it is currently unimplementable**, because no code knows where a given customer's data landed (see 3.3).

### 3.2 Requirement-by-requirement

| # | Requirement | Status | Evidence (file:line) | Risk | Missing | Minimal fix |
|---|---|---|---|---|---|---|
| 1 | Mandatory compliance webhooks | **NO** | grep = 0 hits; routes at `services/webhook/src/routes/webhook.ts:27,42,388,451,555,627` | **CRITICAL - auto-reject** | All three handlers | Implement all three with real logic; register URLs in Partner Dashboard |
| 2 | HMAC verification on Shopify webhooks | **NO** | No Shopify HMAC anywhere. OAuth callback verifies only its own JWT `state`, never Shopify's `hmac` param (`services/ai/src/routes/connectors-admin.ts:456-461`) | **CRITICAL** | `X-Shopify-Hmac-Sha256` verify over raw body | `createHmac("sha256", SECRET).update(rawBody)` + `timingSafeEqual`; reject 401 |
| 3 | Data minimization | **PARTIAL** | Scopes `connectors-admin.ts:438-445` | HIGH | `write_discounts` is dead weight (`:431-437` explains REST uses `price_rules`). `create_customer`/`update_customer` tools exist (`shopify.adapter.ts:98-101,301-318`) but `write_customers` is **not requested** → those tools will 403 | Drop `write_discounts`; resolve the `write_customers` mismatch; document per-scope purpose |
| 4 | Purpose declaration per PCD field | **NO** | Privacy policy never mentions Shopify (grep: 0 hits) | HIGH | Per-field purpose + retention | Add Shopify PCD section; complete the PCD questionnaire |
| 5 | Encryption at rest / in transit | **PARTIAL** | **Tokens good:** AES-256-GCM (`packages/shared/src/lib/encryption.ts`), applied `connectors-admin.ts:232,290,395`. **PCD bad:** see 3.3. TLS terminated at Cloudflare (`DEPLOY.md:14`) | **HIGH** | PCD redaction before persistence | Redact PCD before writing tool output/audit metadata |
| 6 | Retention limits + automated deletion | **NO** | **No retention/purge job exists anywhere** in the codebase (verified: all `retention` grep hits are sales-methodology strings in `skills.ts`/`objectives.ts`) | **CRITICAL** | TTL job + erasure cascade | PCD ≤60 days unless justified |
| 7 | Access controls / least privilege | **PARTIAL** | OAuth init gated `requireRole("ADMIN")` (`connectors-admin.ts:411`); callback has no auth middleware (`:456`) | MEDIUM (**but see C-1/C-2 - currently NO**) | PCD-specific gate | Close C-1/C-2 first; then add a PCD read permission |
| 8 | Staff/personnel access logging to PCD | **NO** | `AuditLog` records **AI** actor actions (`actorType:"ai"`, `ai-bot.service.ts:2273`); no log of a *human* viewing PCD | HIGH | Human-read audit trail | Log actor, subject, timestamp, reason on every human PCD read |
| 9 | Opt-out / Shopify marketing consent | **NO** | `accepts_marketing`/`email_marketing_consent` never read (grep: 0 hits). Only GOTCHA's own `optOutChannels` exists (`schema.prisma:1594-1595`) | HIGH | Honor Shopify consent | Read + respect consent state before any outbound to a Shopify-sourced contact |
| 10 | DPA / subprocessor disclosure | **NO** | No DPA or subprocessor register exists. PCD is sent to an LLM provider - an **undisclosed subprocessor** | **CRITICAL** | DPA + register | Publish subprocessor list naming the LLM provider; execute Shopify DPA |
| 11 | Backups containing PCD | **PARTIAL** | Backups **do** exist: `terraform/user_data.sh:108-145` nightly `pg_dump` → S3, SSE-encrypted (`terraform/s3.tf:31-38`), 90-day expiry (`:56-57`) | MEDIUM | Restore never tested; PCD in backups has no redaction path | Document; test a restore; align policy wording |
| 12 | Real PCD in dev/test | **UNKNOWN** | Same env shape across envs (`docker-compose.yml:269-271`); separation neither proven nor disproven | MEDIUM | Env separation proof | Attest dev uses Shopify dev stores only |
| 13 | Incident response plan | **NO** | `docs/security/` contains only audit docs | HIGH | IR plan | Write one with a 72h notification clock |
| 14 | Privacy policy published | **PARTIAL** | Exists, bilingual, 464 lines, covers GDPR rights + retention (`frontend/src/app/privacy-policy/page.tsx`). **Zero mention of Shopify or PCD.** Listing URL: **UNKNOWN** (Dashboard, not code) | MEDIUM | Shopify disclosure | Add PCD section; set listing URL |

**Score: 0 of 14 fully met** - 8 NO, 5 PARTIAL, 1 UNKNOWN.

### 3.3 The PCD persistence problem (why redact is unimplementable)

Shopify customer data is **not** stored by the adapter - there are no Prisma writes in `shopify.adapter.ts`, so it is proxied live. That is good design and real credit.

But the data lands in two places anyway, verbatim and indefinitely:

1. **`ToolExecution.output`** - raw tool output persisted as JSON (`services/ai/src/services/tool-execution.service.ts:235-242`; schema `output Json` at `schema.prisma:1408`).
2. **`AuditLog.metadata`** - `action-executor.service.ts:696-705` spreads `params` **and `...result`** (the entire tool result) into the metadata blob.

So every AI call to a Shopify customer/order tool writes that customer's name, email, phone, address, and order history into plaintext JSON, with no retention job, no encryption, and no index from "customer" back to "the rows their data landed in".

**This is the single deepest fix in the Shopify track.** `customers/redact` requires knowing where a customer's data went. Today, nothing does.

### 3.4 Splitting the blame honestly

**(a) Missing code - the real blockers:** the three webhooks; Shopify HMAC (webhook + OAuth callback `hmac` param); PCD persisted in plaintext with no deletion path; marketing consent never read.

**(b) Missing process/org steps no code can satisfy:** PCD approval itself (**this is the direct cause of the observed 403s** - `read_customers`/`read_orders` are correctly requested at `connectors-admin.ts:439-440`, and `read_products` working proves the OAuth flow, adapter, and token handling are sound; the 403 is a *policy* gate); DPA + subprocessor disclosure; IR plan; privacy policy URL in the listing.

**(c) Genuine unknowns:** whether real PCD is used in dev; app listing state; Cloudflare TLS/WAF settings.

### 3.5 Bonus bugs found (not PCD, but real)

- **`write_customers` is never requested** while `create_customer`/`update_customer` tools are exposed → they will 403 exactly like the discount bug did. **Same class of scope/endpoint mismatch the team already fixed once** (`connectors-admin.ts:438-445` vs `shopify.adapter.ts:98-101,301-318`).
- **`write_discounts` is dead weight** - the code comment at `:431-437` already explains the REST path needs `read/write_price_rules` (now requested). Keeping it only widens the scope ask reviewers scrutinize.

---

## 4. PART 2 - GDPR

### 4.1 The headline

**No data-subject rights machinery exists.** Verified by direct grep, not inference:

- **No erasure endpoint.** Nothing deletes an end-user by phone/email across a tenant.
- **No export endpoint.** The only `/export` route in the entire codebase is a SYSTEM_ADMIN **waitlist CSV** (`services/auth/src/routes/waitlist.ts:179`) - unrelated to data-subject access.
- **No consent capture.** Every `consent` hit is OAuth `prompt=consent`.
- **No retention job.** Nothing purges anything, ever.
- **No legal basis** field or logic anywhere.
- **No cookie consent banner.**

Articles 6/13/15/17/20/30 are unmet **in code**. This is the weakest area of the platform and the one that most directly blocks EU customers.

> **The asymmetry worth internalizing:** the AI security work is genuinely sophisticated, and the GDPR surface is at zero. A buyer's security questionnaire will not notice the former and will stop at the latter.

### 4.2 Verified structural gaps

| Area | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|
| Privacy Policy exists | **PARTIAL** | Medium | `frontend/src/app/privacy-policy/page.tsx` - 464 lines, bilingual en/he, covers GDPR rights, retention, deletion | Fix the inaccuracies below |
| **Policy makes a false statement** | **NO** | **High** | Policy line 346 tells users encrypted backups retain data "up to 30 days" past deletion; `terraform/s3.tf:56-57` sets **90-day** expiry | Align the wording to 90 days (or shorten the lifecycle). An inaccurate Art. 13 disclosure is itself a violation |
| **Subprocessors named** | **NO** | **High** | Policy names **zero** subprocessors - no OpenAI, Anthropic, Meta, Twilio, Stripe, Shopify, Google, Deepgram | Publish a subprocessor register; name the LLM provider explicitly |
| Terms of Service | **YES** | - | `frontend/src/app/terms/page.tsx` (432 lines) | - |
| DPA | **NO** | High | No DPA artifact anywhere | Draft a customer-facing DPA |
| Cookie consent banner | **NO** | Medium | No consent/banner component found | Add if any non-essential cookies are set |
| Right to erasure (Art. 17) | **NO** | **Critical** | No endpoint erases an end-user by phone/email across a tenant. Per-object deletes exist (`services/conversation/src/routes/conversations.ts:188`), tenant cascade at `services/auth/src/routes/system.ts:352` | Build `eraseCustomer` cascading to Message/Customer/memory/Qdrant/AuditLog |
| Right of access / export (Art. 15/20) | **NO** | **Critical** | Only a SYSTEM_ADMIN waitlist CSV (`services/auth/src/routes/waitlist.ts:179`) | Per-subject export bundle |
| Consent capture | **NO** | High | All `consent` hits are OAuth `prompt=consent` | Capture message-processing consent |
| Retention / TTL | **NO** | **Critical** | **No purge job exists.** Verified: all `retention` grep hits are sales-methodology strings | Configurable TTL per data class |
| Voice recordings | **NO retention** | **High** | `recordingUrl` persisted (`schema.prisma:3140-3141`) with no purge; recording consent not evidenced | Recording notice + TTL. Voice is special-category-adjacent; treat first |
| PII in audit logs | **NO** | High | `AuditLog.metadata` stores raw tool results incl. customer PII (`action-executor.service.ts:696-705`); `ToolExecution.output` likewise (`tool-execution.service.ts:235-242`) | Redact before persist |
| Art. 32 encryption | **PARTIAL** | Medium | AES-256-GCM for credentials (`packages/shared/src/lib/encryption.ts`); `BusinessDiscovery` PII plaintext (`schema.prisma:778-813`); `WebhookTrigger.secret` plaintext (`schema.prisma:635`) | Extend encryption to PII blobs |
| Legal basis recorded (Art. 6/30) | **NO** | High | **No `legalBasis` / lawful-basis / legitimate-interest field or logic exists anywhere** in code or schema (verified by grep) | Decide the basis per processing activity and record it in the Art. 30 register |
| Cookie consent banner | **NO** | Medium | **No consent banner component exists** (verified by grep) | Required only if non-essential cookies/analytics are set - confirm what the frontend actually sets first |

### 4.3 PII inventory (from the real schema)

`Conversation:303` · `Message:384` (`body` = message content) · `BusinessDiscovery:778` (business emails/phones/free-text, plaintext JSON) · `ToolExecution:1402` (`output` - raw third-party PII) · `ConversationIntelligence:1426` · `Contact:1579` (`email`, `phone`) · `AuditLog:2584` (`metadata` - raw PII) · `VoiceCallSession:3125` (`recordingUrl:3140`) · `CustomerBrief:3694` · `CustomerProfile:3937`.

**Every one of these is retained indefinitely.**

### 4.4 Processors receiving personal data

| Processor | Personal data it receives | Evidence |
|---|---|---|
| **OpenAI** | Every bot turn: message bodies, customer name, CRM context, KB excerpts | `services/ai/src/services/ai.service.ts:116` |
| Meta | WhatsApp/Instagram message content + phone/IG handle | webhook + outgoing-worker paths |
| Twilio | Voice audio, phone numbers | `docker-compose.prod.yml:341` |
| Deepgram | Voice transcription | `docker-compose.prod.yml:341` (**confirm actual use**) |
| Shopify | Customer/order PCD (proxied, then persisted to audit) | `shopify.adapter.ts` |
| Zoho / HubSpot / Airtable / Fireberry | Contact/lead PII, conversation notes | `services/ai/src/services/connectors/*` |
| Google | Drive KB docs, Calendar events | `knowledge-oauth.ts`, `calendar-oauth.ts` |
| Qdrant | Embeddings of tenant knowledge + customer content | `docker-compose.prod.yml:294-295` |
| Stripe / iCount | Billing identity | `services/billing` |
| AWS / Cloudflare | All traffic + data at rest | `terraform/`, `DEPLOY.md:14` |

**None are disclosed to data subjects. No DPA register exists.**

**OpenAI retention - verified from code:** the client is constructed plainly - `new OpenAI({ apiKey, ...(baseURL) })` (`ai.service.ts:116-118`). There is **no zero-data-retention configuration and no `store:false`**. GOTCHA therefore relies on OpenAI's default API terms. Whether a ZDR / no-training agreement exists at the **account** level is **UNKNOWN from code**. Resolve and publish this: *"is our customer data used to train AI?"* is the first question every buyer and every Shopify reviewer asks, and today the honest answer is "we have not verified."

**Art. 22 (automated decision-making):** the platform **does profile individuals** - it automatically qualifies and disqualifies leads (`services/ai/src/services/goal-evaluator.ts`; disqualification is a terminal goal state). Assessment: this is profiling under Art. 4(4), but Art. 22 likely **does not** bite, because a decision to stop pursuing a sales lead does not normally produce "legal or similarly significant effects" on the person. **This judgement should be written down and revisited** if the platform ever gates pricing, credit, or service access on an automated score - at that point Art. 22 applies and a human-review right becomes mandatory.

---

## 5. PART 3 - ISO 27001 readiness

**Distance: Far.** There is no ISMS. ISO 27001 is ~70% organizational process, and GOTCHA has **zero policy documents** (verified: `docs/` contains only architecture/product/audit docs).

### 5.1 Controls

| Domain | Annex A | Status | Evidence | Minimal pragmatic fix |
|---|---|---|---|---|
| Information security policy | A.5.1 | **Missing** | No policy docs | One 2-page policy, founder-signed |
| Asset management | A.5.9-5.11 | **Missing** | No asset register | One spreadsheet: services, datastores, data classes |
| Access control | A.5.15 | **Missing** | **C-1** unauthenticated SYSTEM_ADMIN escalation | Close C-1; server assigns role |
| Identity / auth | A.8.2-8.5 | **Partial** | bcrypt `SALT_ROUNDS=10` (`services/auth/src/services/auth.service.ts:5,24`); refresh rotation (`auth.ts:192-199`); login rate-limited 30/15min. **No MFA** (0 hits repo-wide), no SSO, no lockout, password policy `min(8)` only. **`changePassword` never revokes refresh tokens** (`auth.service.ts:83-94`); refresh tokens stored plaintext | MFA for ADMIN; revoke refresh on password change (3 lines); bcrypt cost → 12 |
| RBAC consistency | A.5.15 | **Partial** | Two models + a bridge: `requireRole` at **212** call sites across 8 services vs `requirePermission` at **11**, all in `services/billing`. Bridge at `packages/shared/src/middleware/rbac.ts:44-53` | Pick one authoritative model. An auditor asks "which governs?" - today there are two answers |
| Privileged access | A.8.2 | **Missing** | Internal key = ADMIN on attacker-named tenant (`packages/shared/src/middleware/auth.ts:25-31`) | Close C-2 |
| Logging | A.8.15 | **Partial (weak)** | `AuditLog` real (`schema.prisma:2584-2602`) but only **11** `auditLog.create` sites. **Zero authentication events audited** - no login, logout, failed login, password change, or role change. Mutable rows, no retention field, fire-and-forget (`audit.service.ts:51-54`), stores raw PII | **Audit the 5 auth events** - A.8.15 expects them and it is the first thing sampled. Await the writes; strip PII |
| Monitoring | A.8.16 | **Partial** | 3 CloudWatch alarms (`terraform/cloudwatch.tf:41-95`) with **no `alarm_actions`** - they notify nobody. No Sentry, no aggregation | Add SNS + email/Telegram |
| Secrets | A.8.24 | **Missing** | Prod secrets == public example values (`.env.prod:4,82,104,105`) | Rotate; SSM (IAM already allows: `terraform/iam.tf:55-66`) |
| Cryptography / keys | A.8.24 | **Partial** | AES-256-GCM, random IV, auth tag, **fails closed** if key absent (`packages/shared/src/lib/encryption.ts:8-18,24-35`). Gaps: key = plain `SHA-256(passphrase)`, **not a KDF** (`:17`); **no key id/version in the blob → no rotation path**; `WebhookTrigger.secret` **plaintext** (`schema.prisma:635`); `BusinessDiscovery` PII plaintext (`schema.prisma:778-790`) | Accept "no rotation" as a documented risk now; add a key-version prefix before the first enterprise deal |
| Infrastructure | A.8.20-8.22 | **Compliant (good)** | AWS `il-central-1`, single `t4g.large`. SG **egress-only**; ingress only if `allowed_ssh_cidrs` set, and it **defaults to `[]`** (`terraform/main.tf:62-82`, `variables.tf:43-47`); IMDSv2 required (`terraform/ec2.tf:54-58`); encrypted EBS (`:46`) | Keep. Single EC2 is a SPOF |
| Backups | A.8.13 | **Partial** | **Real**: nightly `pg_dump` → S3 (`terraform/user_data.sh:102-145`), SSE, IA@30d/expire@90d, DLM snapshots; restore documented (`DEPLOY.md:593-600`). **No evidence a restore was ever run**; S3 versioning off (`terraform/s3.tf:22-25`) so a bad overwrite is unrecoverable | Do one timed restore drill; record date + duration. **That record is the audit evidence** |
| Business continuity | A.5.29-5.30 | **Missing** | No RTO/RPO string anywhere | State them honestly (e.g. RTO 8h, RPO 24h). One paragraph |
| Secure development | A.8.25-8.28 | **Missing** | **No `.github/` at all** → no CI, no required review, no branch protection evidence. `CLAUDE.md` says "Main is sacred" but nothing enforces it | One workflow (test + `npm audit`) + branch protection on `main` |
| Vulnerability management | A.8.8 | **Missing** | **17 vulns: 9 high, 8 moderate, 0 critical** across 278 prod deps. Highs: `axios` (**NO_PROXY bypass → SSRF**), `@xmldom/xmldom` (XML injection), `form-data` (CRLF), `multer` (DoS), `nodemailer` (**SMTP command injection**), `path-to-regexp` (ReDoS), `socket.io-parser`, `undici`, `ws`. No Dependabot/gitleaks/CodeQL | `npm audit fix`; add `dependabot.yml` + an audit step in CI |
| Change management | A.8.32 | **Partial** | `DEPLOY.md` exists; manual deploy scripts; branch protection **UNKNOWN** | Require PR + CI green |
| Incident response | A.5.24-5.28 | **Missing** | None | One-page runbook + 72h clock |
| Risk management | A.6.1 | **Missing** | No register | This document seeds it |
| Supplier management | A.5.19-5.22 | **Missing** | No vendor register | Reuse the subprocessor register |
| Physical | A.7 | **Compliant (inherited)** | AWS (`terraform/`) | Cite AWS compliance |
| HR security | A.6 | **UNKNOWN** | Not evidenceable from code | Onboarding/offboarding checklist |

### 5.2 What an auditor fails you on first

1. **There is no ISMS.** No policy, scope, SoA, risk register, management review, or internal audit. This is an instant **Stage 1 fail - the auditor never opens the code.** Everything below is secondary.
2. **C-1** - a pentest report containing an unauthenticated privilege escalation ends the conversation regardless of paperwork.
3. **C-2** - the service-mesh root credential is a public git string.
4. **No authentication audit trail.** A.8.15 explicitly expects logon/logoff/failed-attempt records. The system logs AI tool calls but not a single login. **The first thing an auditor samples is the thing that does not exist.**
5. **Backups never restore-tested; alarms wired to nobody.** A.5.30/A.8.16 want evidence of *operation*, not existence. Both controls exist and both are unevidenced.
6. **No supplier register** while tenant data flows to OpenAI, Twilio, Deepgram, Cloudflare, and Meta.
7. **No CI** - 9 high-severity vulns unnoticed; change control is honor-system.

### 5.3 The ISMS artifacts (this is where certification is won)

**None of these are engineering.** ISO certifies a management system. Roughly two focused weeks of writing separates "not certifiable" from "certifiable" - the code is not the blocker.

**Mandatory clauses (no SoA → no certificate):** Information Security Policy (approved, dated, owned) A.5.1 · ISMS scope statement (4.3) · **Statement of Applicability** covering all 93 Annex A controls with justification (6.1.3 - the certificate itself references it) · risk methodology (6.1.2) · **risk register** (A.5.7) · risk treatment plan (6.1.3) · **management review minutes (9.3)** · **internal audit report + corrective actions (9.2, 10.1)**.

> Auditors ask for management review and internal audit on day one, and startups never have them. Budget for them explicitly.

**Operational:** asset register w/ owner + classification · access control policy + **quarterly access review records** · supplier register + DPAs · IR plan (severity ladder, contacts, 72h clock) · BCP with RTO/RPO + **one restore-drill record** · secure development policy + change approvals · vulnerability policy (cadence + SLA) · cryptography policy (state the accepted "no key rotation" risk) · logging & retention policy.

**HR set (A.6), entirely absent:** NDA · AUP · onboarding/offboarding checklist · background-check stance (*"not performed, risk accepted" is a legitimate startup answer*) · annual awareness training record.

**Do not:** buy a GRC tool, hire a consultant yet, or do any work on A.7 - inherit it from AWS in one SoA line.

---

## 6. PART 4 - AI security

**This is the strongest part of the platform.** Keep it; do not redesign it.

### 6.1 Verified in force (real, wired, proven call sites)

- **Prompt injection - context blocks:** `sanitizeUntrusted(..., {wrap:true})` on customer/CRM/memory/template (`prompt-builder.service.ts:535,538,541,544`) and knowledge (`:1346`). Guardrails treat `<untrusted>` as data (`guardrails.md:37,40,42,54`).
- **Output validator:** wired on the live reply path (`ai-bot.service.ts:38` → `:3610`).
- **Cost budget:** wired, all three caps real (`ai-bot.service.ts:1118,1123,2091`; `cost-budget.service.ts:58-60`).
- **Embedded-chat rate limits:** defined **and applied** (`embedded-chat.ts:34,46,58` → `:79,174,238`).
- **Tool-calling AND-rule:** `isAllowed` **AND** `isEnabled` **AND** integration `CONNECTED` in one query (`packages/shared/src/lib/agent-tools.ts:861-870`), re-gated at dispatch (`ai-bot.service.ts:1854,2235`) with a surface/dispatch invariant guard (`:2248`).
- **Knowledge poisoning:** Qdrant retrieval tenant-filtered (`knowledge-retrieval.service.ts:67-68,82`).
- **File uploads:** `multer.memoryStorage()` (no disk → no path traversal), 10MB cap, MIME allowlist (`knowledge.ts:194-198`). `uploads/` is empty and unused.
- **Custom-DB:** parameterized, no injection surface (`custom-db.service.ts:146,169`).
- **`ai-debug`:** fails closed; SYSTEM_ADMIN-only JIT (`ai-debug.ts:62-89,94`).
- **Identity merge:** requires `strongSignal` AND `allow_auto_merge` (default false) AND vendor support (`crm-identity.service.ts:238-239,375`).

### 6.2 Open AI-security gaps

| # | Gap | Severity | Evidence | Fix |
|---|---|---|---|---|
| A-1 | **Chat history unsanitized on every non-webchat channel** | **High** | `ai-bot.service.ts:2019-2025` pushes `m.body` raw; file has zero `sanitiz` calls. Webchat is covered only incidentally (`embedded-chat.ts:191`). WhatsApp/Instagram/email are covered **nowhere** | One line: `sanitizeChatHistoryBody(m.body)`. The function is already written and tested |
| A-2 | **Tenant guard covers 28 of 82 models** | High | `packages/shared/src/lib/prisma.ts:16-46`; unguarded incl. `KnowledgeChunk`, `CustomerProfile`, `AgentCustomerMemory`, `RefreshToken` | Add the 54 missing models |
| A-3 | Guard exempts `findUnique`/**`update`**/**`delete`** | Medium | `prisma.ts:99-105` | Unguarded id-keyed **writes** are the worse half; remove at least `update`/`delete` |
| A-4 | `sessionId` is a bearer capability | Medium | `embedded-chat.ts:243` unauthenticated, returns full history to any CUID holder | Sign the session token |
| A-5 | PII/token redaction never wired | High | zero `redact()` call sites; `calendar-oauth.ts:243` dumps raw token response | Wire the 4 named sites |
| A-6 | Budget caps fail open on DB error | Medium | `cost-budget.service.ts:144-148` `catch → return 0`; 2 stale tests mean caps are **untested** | Fix mocks (`tokensTotal` → `tokensEquivalent`) |
| A-7 | Output validator skipped on approval replies | Low | `ai-bot.service.ts:3608` | Acceptable; documented |

**No live cross-tenant leak was found.** A sweep of unguarded models cleared all 8 candidates as false positives - a proximity heuristic, so not a proof of absence.

---

## 7. PART 5 - Infrastructure

### 7.1 What is genuinely good (keep)

No inbound 80/443 in the security group (`terraform/main.tf:67-84`) - public traffic arrives via **Cloudflare Tunnel dialing outbound** (`DEPLOY.md:14-16`). IMDSv2 required; EBS encrypted; S3 private + SSE + lifecycle; IAM least-privilege with `kms:ViaService`; nightly backups; DLM snapshots; helmet + CORS locked to `FRONTEND_URL` + 1000/15min on all 8 services (`packages/shared/src/lib/service-app.ts:19-31`); edge rate limiting 100r/s (`gateway/nginx.prod.conf.template:52`); raw-body capture preserved for HMAC (`service-app.ts:37`).

### 7.2 Ports

**Production: exactly one host port published (gateway :80), and the AWS SG makes even that unreachable directly.** No datastore is exposed. Correctly designed.

**Development is where the risk lives:** `docker-compose.yml:11-12` binds Postgres to **`0.0.0.0:5432`** with `postgres`/`postgres`, and `:31-33` binds Qdrant to **`0.0.0.0:6333/6334`** with no auth (customer embeddings). Whether the dev box is behind a restrictive SG is **UNKNOWN** (no dev Terraform exists). **Minimal fix:** bind to `127.0.0.1`.

### 7.3 Ranked infrastructure risks

1. **C-2** - public static internal key + nginx prefix exposure (see §1).
2. **Prod Postgres password is `postgres`** (`.env.prod:4`). Contained only by the SG; one SSRF pivot or container escape = full tenant data.
3. **`scripts/push-deploy.sh:67-71,88` is the mechanism** - it scp's local `.env`, and **falls back to shipping `.env.example` to land as `.env` on the box**. That is *how* weak values reach prod. `DEPLOY.md:29` claims SSM Parameter Store; the script does not do that.
4. **Workers drop messages permanently.** All 8 BullMQ queues declared with no `attempts`/`backoff`/DLQ (`packages/shared/src/lib/queue.ts:19-29`); BullMQ defaults to `attempts: 1`. **A transient OpenAI/Meta blip silently loses an inbound customer message.** For a messaging platform this is a data-loss path, not just an ops gap.
5. **Nothing tells anyone when it breaks** - 3 alarms with no `alarm_actions`; no Sentry/aggregation; backups never restore-tested.
6. Single EC2, no resource limits; Terraform state local and unencrypted (`terraform/versions.tf:15-20`).
7. All 15 Dockerfiles run as root; `qdrant:latest` unpinned with `pull_policy: always`.
8. **No CI.** 9. Static frontend ships without security headers.

### 7.4 Explicit NO / UNKNOWN

- **RabbitMQ - NO.** Does not exist; queueing is BullMQ over Redis.
- **Neo4j - NO.** Not part of the stack; `graphify-out/` is a gitignored dev-tool artifact.
- **Sentry / Prometheus server / log aggregation / DLQ / CI - NO.**
- **Secrets hardcoded in IaC - NO.** The sweep returned zero hits; all `${VAR}` interpolation. The leak is `.env.prod` + source fallbacks, not the IaC.
- **`allowed_ssh_cidrs` value - UNKNOWN** (`terraform.tfvars` gitignored). **If it is `0.0.0.0/0`, port 22 is world-open - verify manually.**
- **Dev host exposure, Cloudflare WAF/TLS settings, backup restorability, branch protection - UNKNOWN.**

---

## 8. PART 6 - Required documentation

**Zero policy documents currently exist.** `docs/` holds architecture, product, and audit docs only.

| Document | Have it? | Create? | Priority |
|---|---|---|---|
| Privacy Policy | **Yes** (`frontend/src/app/privacy-policy/page.tsx`) - but wrong on backups, names no subprocessors | Fix | **P0** |
| Terms of Service | **Yes** (`frontend/src/app/terms/page.tsx`) | Review | P2 |
| **Subprocessor List** | No | Yes - name the LLM provider | **P1** |
| **DPA** | No | Yes | **P1** |
| **Incident Response Plan** | No | Yes - 72h clock | **P1** |
| Retention Policy | No | Yes - must match the code you build | **P1** |
| Security Policy | No | Yes - 2 pages | P2 |
| Access Control Policy | No | Yes | P2 |
| Backup & DR Policy | No | Yes - backups exist, write down RTO/RPO | P2 |
| Risk Register | No | Yes - seed from this doc | P2 |
| Asset Register | No | Yes - one spreadsheet | P2 |
| Data Classification Policy | No | Yes | P2 |
| Cookie Policy | No | Only if non-essential cookies are set | P3 |
| Acceptable Use Policy | No | Yes | P3 |
| ISO Evidence Folder | No | Yes | P3 |

---

## 9. PART 7 - Startup compliance roadmap

**Sequencing law:** exploitable holes first. **No compliance work matters while an anonymous attacker can mint a SYSTEM_ADMIN token.** Do not start Shopify or GDPR work before P0 is closed.

### P0 - Before launch (days). Non-negotiable.

| # | Item | Evidence | Complexity |
|---|---|---|---|
| P0-1 | **Server assigns role in `/register`.** Drop `role` from the schema; default `AGENT` | `services/auth/src/routes/auth.ts:12`; `auth.service.ts:26` | **S** |
| P0-2 | **Remove all 42 `\|\| "chatcenter-internal-2026"` fallbacks; fail closed at boot.** Rotate the key | `grep -rn "chatcenter-internal-2026"` | **S** |
| P0-3 | **Rotate `POSTGRES_PASSWORD` + `SYSTEM_ADMIN_SETUP_SECRET`** (currently the public example values) | `.env.prod:4,82` | **S** |
| P0-4 | **Deny `/api/agent-loop`, `/api/crm/auto-link`, `/api/ai-assist/intent` at the nginx edge** | `gateway/nginx.prod.conf.template:525,539,326` | **S** |
| P0-5 | **Mandatory webhook HMAC - reject unsigned** | `services/webhook/src/routes/webhook.ts:88-95` | **S** |
| P0-6 | **SSRF guard on the onboarding crawler** (block private ranges + `169.254.169.254`; no redirects) | `services/auth/src/routes/onboarding.ts:1218,1383-1404` | **M** |
| P0-7 | **Sanitize chat history** - one line | `ai-bot.service.ts:2024` | **S** |
| P0-8 | **`npm audit fix`** - 17 vulns, 9 high, incl. axios SSRF | verified | **S** |
| P0-9 | **Fix `push-deploy.sh`** - delete the `.env.example` fallback | `scripts/push-deploy.sh:67-71,88` | **S** |
| P0-10 | Bind dev datastores to `127.0.0.1`; verify `allowed_ssh_cidrs` ≠ `0.0.0.0/0` | `docker-compose.yml:11-12,31-33` | **S** |
| P0-11 | **Fix the privacy policy's false backup claim** (30 → 90 days) | policy:346 vs `terraform/s3.tf:56-57` | **S** |
| P0-12 | **Fail closed on auth DB error** (`.catch(() => next())` admits revoked users) | `packages/shared/src/middleware/auth.ts:47-50` | **S** |
| P0-13 | **Revoke refresh tokens on password change** - today a stolen refresh token survives the victim's password reset | `services/auth/src/services/auth.service.ts:83-94` | **S** |

**Business value:** removes every finding a buyer's pentest flags on day one. **Security value:** closes two total-compromise paths. **Trust value:** you can honestly answer "has this been reviewed?". **Dependencies:** none. Mostly one-line changes.

**Verification checklist:**
- [ ] `POST /register {role:"SYSTEM_ADMIN"}` → account is `AGENT`
- [ ] `Bearer chatcenter-internal-2026` + `x-tenant-id` → **401**
- [ ] Service refuses to boot without `INTERNAL_SERVICE_KEY`
- [ ] Unsigned webhook → rejected
- [ ] Crawler against `169.254.169.254` → blocked
- [ ] `###SYSTEM:` in a WhatsApp message → neutralized in the prompt
- [ ] `npm audit` → 0 high
- [ ] `curl` prod Postgres port from off-host → refused

### P1 - Before Shopify approval (2-6 weeks)

| # | Item | Note |
|---|---|---|
| P1-1 | **The three compliance webhooks + Shopify HMAC** | The auto-reject. Nothing ships before this |
| P1-2 | **Erasure cascade** (`eraseCustomer` → Message/Customer/memory/Qdrant/AuditLog/ToolExecution) | Makes `customers/redact` honest. **Gates P1-1** |
| P1-3 | **Stop persisting raw PCD/PII** in `ToolExecution.output` + `AuditLog.metadata`; add retention | `tool-execution.service.ts:235-242`; `action-executor.service.ts:696-705` |
| P1-4 | **Retention/TTL jobs** per data class (messages, voice recordings first) | None exist today |
| P1-5 | **Read + honor Shopify marketing consent** | |
| P1-6 | Drop `write_discounts`; fix the `write_customers` mismatch | Prevents a repeat 403 |
| P1-7 | **Subprocessor register + DPA + IR plan + Shopify PCD privacy section** | Legal-gated - start now, it is the long pole |
| P1-8 | Wire `redact()`; add BullMQ `attempts`/`backoff` + DLQ | Stops silent message loss |
| P1-9 | Add SNS `alarm_actions`; add CI (test + `npm audit` + gitleaks) | Alarms currently notify nobody |
| P1-10 | Export / portability endpoint (Art. 15/20) | |
| P1-11 | **Audit the 5 authentication events** (login, logout, failed login, password change, role change) | Zero exist today. A.8.15's first sample; cheap and high-credibility |
| P1-12 | **One timed restore drill; record date + duration** | Backups exist but have never been proven to restore. The record *is* the evidence |
| P1-13 | Fix the 2 stale `cost-budget` tests (`tokensTotal` → `tokensEquivalent`) | Caps are real but currently unverified, and they fail open |

**Business value:** unblocks the Shopify channel and EU deals. **Complexity:** L. **Dependencies:** P0; P1-2 gates P1-1.

**Verification:** submit-readiness = all three webhooks respond correctly to Shopify's test payloads with valid HMAC; erasing a test customer removes them from Message/Contact/memory/Qdrant/audit; retention job purges past-TTL rows.

### P2 - Before ISO 27001 audit (quarter)

ISMS + the policy set (§8); risk register; asset register; access reviews; MFA for ADMIN; login lockout; unify the RBAC split (billing island vs `Role` enum); durable + immutable audit log with PII stripped; **restore drill** with RTO/RPO; structured logging + aggregation; Terraform S3 backend + lock; `USER node` in Dockerfiles; pin images; consent capture; cookie policy if applicable.

**Dependencies:** P0, P1. **Verification:** an auditor can pull change-control, monitoring, backup-restore, and IR evidence unaided.

### P3 - Later

Redis `requirepass`; Qdrant API key; resource limits; per-tenant prompt-firewall config; encoded-injection (base64/ROT13) detection; tool-execution sandbox; quarterly red-team; SOC 2 Type II machinery; KMS/Vault.

---

## 10. The standing rules (how GOTCHA stays secure)

1. **Trust boundaries fail closed.** Four currently fail open (webhook signature, auth-on-DB-error, budget-on-DB-error, missing internal key). An enterprise review fails the moment it finds one "if the check can't run, allow it."
2. **No secret has a fallback.** A `|| "default"` on a credential is a backdoor with good intentions. Fail at boot instead.
3. **A control is not shipped until a call site proves it.** Two prior "patched" findings were dead modules. **Grep for the call site, not the file.**
4. **A passing test is not integration.** Test the wiring, not just the function.
5. **Never widen a scope or weaken a boundary to unblock a test.** Fix the caller.
6. **The privacy policy is a factual claim.** If it says 30 days, the lifecycle must say 30 days. Ship policy and code together.
7. **Data you never store is data you never have to redact, export, or breach.** The Shopify adapter proxying live is the right instinct - the audit log undid it.

---

## 11. Open UNKNOWNs (resolve, do not guess)

- `allowed_ssh_cidrs` **actual** value - `terraform.tfvars` is gitignored. The variable **defaults to `[]`** (`terraform/variables.tf:43-47`), so the safe case is the default; confirm prod did not override it.
- Dev host (`dev.gotcha.co.il`) network exposure; published 5432/6333 reachability.
- Whether OpenAI zero-retention / no-training is configured on the account.
- Whether Deepgram is used at all.
- Cloudflare WAF/TLS/HSTS settings.
- Whether backups actually restore.
- Whether real PCD is used in dev stores.
- Shopify app listing state; branch protection.
- HR onboarding/offboarding process.

---

## 12. Provenance

Evidence base: direct trace on 2026-07-16 across `services/{ai,auth,conversation,webhook,billing,incoming-worker,voice-copilot}`, `packages/shared/{src,prisma}`, `gateway/`, `nginx/`, `terraform/`, `scripts/`, `frontend/src/app/{privacy-policy,terms}`, all three compose files, and all 15 Dockerfiles. Prior-audit claims re-verified independently against current code; `npm audit` and the security test suite executed rather than cited.

**Relationship to prior docs:** supersedes `SECURITY_SCORECARD.md` (2026-05-26) status claims; extends `enterprise-readiness-audit.md` (2026-07-08), correcting its N-9 backups finding. `THREAT_MODEL.md` and `SECURITY_ARCHITECTURE.md` remain useful and are not superseded.

*Living document. Re-verify before each funding, enterprise, or app-store milestone. Claims decay - call sites do not lie.*
