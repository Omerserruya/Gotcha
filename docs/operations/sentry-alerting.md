# Sentry alerting — operator runbook

**Every rule in this document assumes `environment:production`.** Sentry receives
nothing from development, test, CI, local or staging, by construction — see
[Why nothing else can send](#why-nothing-else-can-send).

---

## 1. The four projects

Create exactly these four projects in the GOTCHA Sentry org. Do not create one
per microservice.

| Project | Platform | Receives | DSN variable |
|---|---|---|---|
| `gotcha-frontend` | `javascript-nextjs` | browser: React rendering, client API failures, integration setup UI, AI Assistant UI, HITL UI, billing UI, guided tours, route transitions | `SENTRY_FRONTEND_DSN` |
| `gotcha-core-backend` | `node` | `auth`, `ai`, `conversation`, `billing`, `analytics`, `chatbot` — AI orchestration, tool selection, adapter execution, HITL lifecycle, OAuth callbacks, authorization, tenant resolution, integration provisioning | `SENTRY_CORE_BACKEND_DSN` |
| `gotcha-workers-webhooks` | `node` | `webhook`, `incoming-worker`, `outgoing-worker`, `notifications` — async jobs, scheduled jobs, retries, queues, Meta / Shopify / Gmail Pub-Sub / Outlook / Slack webhooks, billing callbacks | `SENTRY_WORKERS_DSN` |
| `gotcha-voice` | `node` | `voice-copilot` — Twilio provisioning, inbound and outbound calls, TwiML, media WebSockets, recordings, transcripts, conferences, call callbacks | `SENTRY_VOICE_DSN` |

**Why four and not eleven.** Grouping is by *how someone responds*, not by how the
code is packaged. Core-backend means a user is blocked right now. Workers means
nobody is waiting and it will retry, so the rate matters more than the instance.
Voice means a live call is degrading and seconds count. Eleven projects would
mean eleven alert configs and one incident spread across six dashboards.

Inside a project, the `service` tag identifies the exact service, so grouping
stays coarse while attribution stays exact.

### Tags available on every backend event

| Tag | Example | Use |
|---|---|---|
| `service` | `auth`, `incoming-worker`, `voice-copilot` | narrow an alert to one service |
| `sentry_project` | `gotcha-core-backend` | sanity check routing |
| `error_code` | `action_provider_failed` | **the field every rule below filters on** |
| `release` | image tag or `SENTRY_RELEASE` | regression detection |

`error_code` is the alerting contract. Rules never match on exception *messages* —
someone rewords a string, the rule silently stops firing, and the first anyone
knows is the incident it was meant to catch. The vocabulary is
`packages/shared/src/lib/observability/error-codes.ts`.

---

## 2. Environment variables

```env
SENTRY_FRONTEND_DSN=
SENTRY_CORE_BACKEND_DSN=
SENTRY_WORKERS_DSN=
SENTRY_VOICE_DSN=

SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
```

Set them in `.env.prod` only. No DSN is ever committed; `docker-compose.prod.yml`
defaults every one to empty, so unset means Sentry is simply off.

- `SENTRY_ENVIRONMENT` — must be exactly `production` or nothing is sent.
- `SENTRY_RELEASE` — defaults to the deployed image `TAG` so an issue can always
  be traced to a build. Set it explicitly for a named release.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` — build-time only, for source-map upload.
  Never baked into the browser bundle.

The browser DSN is frozen into the static export at build time as
`NEXT_PUBLIC_SENTRY_DSN`. **Changing it requires a gateway rebuild, not an `.env`
edit** — production serves static files and reads nothing from the environment.

---

## 3. Why nothing else can send

`initSentry()` requires **both** of these before it will even load the SDK:

```
NODE_ENV=production           the process really is a production build
SENTRY_ENVIRONMENT=production an operator deliberately said so
```

Neither is redundant. Staging and CI legitimately run production builds, so
`NODE_ENV` alone would let a staging stack pollute the stream the on-call
rotation pages on. `SENTRY_ENVIRONMENT` alone is a plain string anyone can set
locally. Requiring both means an accidental event needs two independent mistakes.

The environment check runs **before** the DSN is read, so a CI job holding a real
DSN still takes the no-op path.

- **Tests** — the suite installs a module-load trap that throws if anything
  requires `@sentry/*`. It never fires, which proves no client, transport or
  queue is ever constructed. There is nothing to mock because nothing is loaded.
- **CI** — a guard asserts no workflow sets `SENTRY_ENVIRONMENT: production` or
  injects any DSN.
- **Source maps** — uploaded only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
  `SENTRY_RELEASE` are all present *and* `SENTRY_ENVIRONMENT=production`.
  Otherwise `next.config.js` skips the wrapper entirely, so a laptop build does
  no network I/O and needs no credentials.

---

## 4. What never leaves the process

Enforced in `beforeSend` for every event, backend and browser:

| Data | Treatment |
|---|---|
| Request bodies | **dropped whole.** There is no safe subset of a customer conversation, an OAuth callback or a webhook payload |
| Headers | **allow-list** (`content-type`, `user-agent`, `accept*`, `content-length`, `x-request-id`, `x-forwarded-proto`). Everything else dropped, including any header invented later |
| Query strings | stripped; path kept. This is where `code`, `state` and signed webhook params live |
| Cookies, `env` | dropped |
| User | reduced to an opaque `id`. No email, name, username or IP |
| Credential-shaped strings | redacted anywhere they appear, including inside exception messages — Bearer tokens, JWTs, `sk-`, `shpat_`, Twilio `AC`/`SK`, Slack `xox*`, GitHub `gh*` |
| Keys named like secrets or content | redacted by name (`*token*`, `*secret*`, `signature`, `body`, `message`, `transcript`, `phone`, `email`, …) |
| Session Replay | **disabled.** It records the DOM, which here means customer conversations, phone numbers and billing details |
| `sendDefaultPii` | `false` |

If scrubbing itself throws, the event is dropped. An unscrubbed event is worse
than a missing one.

---

## 5. Operator setup

1. **Create the four projects** — Sentry → Projects → Create Project. Use the
   names and platforms in §1. Copy each DSN into `.env.prod`.
2. **Set the environment** — `SENTRY_ENVIRONMENT=production` in `.env.prod`.
3. **Connect Slack** — Settings → Integrations → Slack → Add Workspace
   Installation. Authorise the GOTCHA workspace, then invite the Sentry app to
   `#gotcha-prod-alerts`, `#gotcha-security` and `#gotcha-ai-ops`. A rule cannot
   target a channel the app is not a member of.
4. **Create each rule below** — Alerts → Create Alert, pick the project, pick the
   type, then set the filter, threshold and action exactly as written.
5. **Set the environment filter on every rule** to `production`. Sentry defaults
   to "All Environments"; leaving it there is the single most common way these
   rules end up noisy.

> Slack alert rules are **not** created through an API here. The steps above are
> the authorised path; automating them requires explicit approval.

---

## 6. `#gotcha-security`

Security rules use **Issue Alerts** on **first occurrence**, not thresholds. One
cross-tenant exposure is an incident; waiting for a second is not a policy.

All five: **Environment** `production` · **Action** Slack → `#gotcha-security` ·
**Frequency** every occurrence (no digest).

| # | Project | Filter | Trigger | Threshold | Window | Recovery |
|---|---|---|---|---|---|---|
| S1 | `gotcha-core-backend` | `error_code:authorization_invariant_broken` | Issue Alert — a new issue is created **or** the event's tags match | first event | n/a (immediate) | Manual. Resolve the Sentry issue after review; a regression re-alerts |
| S2 | `gotcha-core-backend` | `error_code:cross_tenant_exposure` | Issue Alert — first event | first event | n/a | Manual. Treat as a data-protection incident before resolving |
| S3 | `gotcha-core-backend` | `error_code:irreversible_duplicate_execution` | Issue Alert — first event | first event | n/a | Manual. Reconcile the duplicate before resolving |
| S4 | `gotcha-core-backend` | `error_code:hitl_payload_mismatch` | Issue Alert — first event | first event | n/a | Manual. The approved payload and the executed payload diverged — do not resolve without establishing which ran |
| S5 | `gotcha-workers-webhooks` | `error_code:webhook_signature_invalid` | **Metric Alert** — count of events | **> 20 in 5 min** (critical); **> 5 in 5 min** (warning) | 5 min, 1 min interval | **Auto-resolves** when the count returns below the warning threshold for one full window |

**Why S5 differs.** A single failed signature is background noise on the public
internet — a scanner, a stale secret, a provider retrying an old payload. A
*spike* is the signal: a rotated secret nobody redeployed, or someone probing.
Alerting per event would page on noise and train people to ignore the channel.

**Set `frequency: 5 minutes`** on S1–S4 so a storm of the same issue does not
repeat-page; the issue is already open.

---

## 7. `#gotcha-ai-ops`

Execution failures. These are expected at a low rate and meaningful as a rate
change, so most are **Metric Alerts** with automatic recovery.

All: **Environment** `production` · **Action** Slack → `#gotcha-ai-ops`.

| # | Project | Filter | Trigger | Threshold | Window | Recovery |
|---|---|---|---|---|---|---|
| A1 | `gotcha-core-backend` | `error_code:hitl_execution_failed` | Metric Alert — count | **> 3 in 10 min** (critical); **> 1 in 10 min** (warning) | 10 min, 1 min interval | Auto-resolves below warning for one window |
| A2 | `gotcha-core-backend` | `error_code:action_execution_failed` | Metric Alert — count | **> 10 in 10 min** (critical); **> 4 in 10 min** (warning) | 10 min | Auto-resolves |
| A3 | `gotcha-core-backend` | `error_code:action_provider_failed` | Metric Alert — count | **> 15 in 10 min** (critical); **> 6 in 10 min** (warning) | 10 min | Auto-resolves |
| A4 | `gotcha-core-backend` | `error_code:action_persistence_failed` | Issue Alert — first event | first event | n/a | **Manual.** The action ran and the record did not — the system's memory and the world disagree. Never auto-resolve |
| A5 | `gotcha-core-backend` | `error_code:action_notification_failed` | Metric Alert — count | **> 10 in 15 min** (critical) | 15 min | Auto-resolves |
| A6 | `gotcha-core-backend` | `error_code:ai_provider_degraded` | Metric Alert — count | **> 20 in 5 min** (critical); **> 8 in 5 min** (warning) | 5 min, 1 min interval | Auto-resolves below warning for one window |

**Threshold rationale.** A3 sits above A2 deliberately: provider failures are the
common, self-healing case (a rate limit, a 502 from Shopify) and should not page
until they stop looking like weather. A4 has no threshold at all because a single
occurrence means an action was executed against a real system and not recorded —
the one failure mode in this list that silently corrupts state.

---

## 8. `#gotcha-prod-alerts`

General production health. **Environment** `production` · **Action** Slack →
`#gotcha-prod-alerts`.

| # | Project | Filter | Trigger | Threshold | Window | Recovery |
|---|---|---|---|---|---|---|
| P1 | `gotcha-core-backend` | *(no filter — all events)* | Issue Alert — a new issue is created | first event of a **new** issue | n/a | Manual. `frequency: 30 minutes` |
| P2 | `gotcha-core-backend` | `error_code:oauth_integration_failed` | Metric Alert — count | **> 10 in 15 min** (critical); **> 4 in 15 min** (warning) | 15 min | Auto-resolves |
| P3 | `gotcha-workers-webhooks` | `error_code:webhook_processing_failed` | Metric Alert — count | **> 25 in 10 min** (critical); **> 10 in 10 min** (warning) | 10 min | Auto-resolves |
| P4 | `gotcha-core-backend` | `error_code:billing_failed` | Metric Alert — count | **> 3 in 15 min** (critical); **> 1 in 15 min** (warning) | 15 min | Auto-resolves |
| P5 | `gotcha-voice` | `error_code:voice_failed` | Metric Alert — count | **> 5 in 5 min** (critical); **> 2 in 5 min** (warning) | 5 min, 1 min interval | Auto-resolves below warning for one window |
| P6 | `gotcha-voice` | *(no filter — all events)* | Issue Alert — a new issue is created | first event of a **new** issue | n/a | Manual. Voice gets its own catch-all because a call cannot be retried |
| P7 | `gotcha-frontend` | *(no filter — all events)* | Metric Alert — count | **> 50 in 10 min** (critical); **> 20 in 10 min** (warning) | 10 min | Auto-resolves. **Spike detection, not per-error** — one browser throwing is not an incident |
| P8 | `gotcha-frontend` | `release:{{SENTRY_RELEASE}}` | Issue Alert — **a new issue is created** and `The issue is older than 0 minutes` unset | first event of a new issue on the current release | n/a | Manual. This is the regression rule: a new issue appearing only after a deploy |

**P1 vs P7.** Backend gets per-new-issue alerting because volume is low and each
new issue is a distinct fault. The frontend gets rate alerting because a single
user on a broken extension or an ad blocker can generate errors indefinitely, and
per-issue paging there is how a channel becomes muted.

**Thresholds are a starting point.** Tune after the first week against real
volume: the correct threshold is a little above normal, and normal is not
knowable before production traffic exists.

---

## 9. Emission status — read this before trusting the rules

Alert rules match `error_code` tags. **Those tags are not yet emitted anywhere in
the codebase.** The vocabulary and routing exist and are typed; the call sites
that raise each code have not been instrumented.

Every rule in §6–§8 that filters on `error_code:` will therefore **never fire**
until the corresponding `captureError(err, { error_code: ... })` call is added.
The unfiltered rules (P1, P6, P7) work today.

Instrumenting them means touching the HITL and action-execution paths, including
the deferred generic P0 execution routes this task was told not to modify. That
work is deliberately not done here.

To wire one:

```ts
import { captureError, ERROR_CODES } from "@chatcenter/shared";

captureError(err, {
  error_code: ERROR_CODES.action_provider_failed,
  provider: "shopify",   // low cardinality only
});
```

Keep tag values low-cardinality. A tenant id or message id turns the Sentry tag
index into a unique-value list and makes the alert unusable.

| Code | Emitted today |
|---|---|
| `authorization_invariant_broken` | ❌ pending |
| `cross_tenant_exposure` | ❌ pending |
| `irreversible_duplicate_execution` | ❌ pending |
| `hitl_payload_mismatch` | ❌ pending |
| `webhook_signature_invalid` | ❌ pending |
| `hitl_execution_failed` | ❌ pending |
| `action_execution_failed` | ❌ pending |
| `action_provider_failed` | ❌ pending |
| `action_persistence_failed` | ❌ pending |
| `action_notification_failed` | ❌ pending |
| `ai_provider_degraded` | ❌ pending |
| `oauth_integration_failed` | ❌ pending |
| `webhook_processing_failed` | ❌ pending |
| `billing_failed` | ❌ pending |
| `voice_failed` | ❌ pending |

Unhandled exceptions from every wired service reach the right project today via
the Express error handler and the worker/voice init, tagged with `service` — so
P1, P6 and P7 are live the moment DSNs are set.

---

## 10. Release and source maps

For a named production release:

```bash
SENTRY_ORG=<org> \
SENTRY_AUTH_TOKEN=<token> \
SENTRY_RELEASE=<git-sha-or-version> \
SENTRY_ENVIRONMENT=production \
REGISTRY=... PLATFORM=linux/arm64 SERVICES=gateway ./scripts/docker-publish.sh
```

The publisher prints `sourcemap upload=yes (explicit production release)` when
all four are present, and `no` otherwise. Maps are uploaded and then deleted from
the build output, so stack traces are readable in Sentry without shipping sources
to every visitor.

Backend services take `SENTRY_RELEASE` from the environment at runtime and fall
back to the deployed image `TAG`.
