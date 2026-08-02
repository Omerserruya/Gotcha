# Integration connection lifecycle

One connection model for every provider, and the provider-by-provider truth
about what actually works.

Written 2026-07-20, after a test round reported that Monday, Google Calendar
and Calendly "don't connect".

---

## 1. The rule

> **Connection state comes from persisted backend state, confirmed by the
> provider. Never from the browser.**

The UI may show transient activity (`authorizing`), but it must never claim
`connected` because a popup closed, a callback route loaded, credentials were
submitted, or a promise resolved. Those all happen when the connection is
broken.

Concretely: `TenantIntegration.status` (`PENDING | TESTING | CONNECTED |
ERROR | DISCONNECTED`) is the source of truth, and a callback only writes
`CONNECTED` after a real API call to the provider succeeds.

## 2. Provider adapter contract

`services/ai/src/services/connectors/integration-framework.ts`

| Member | Purpose |
|---|---|
| `slug` | Catalog slug |
| `tools()` | Tools this adapter really implements |
| `execute(...)` | Run one tool |
| `validate?(...)` | **Connection probe** — prove the stored credential works |
| `refreshTokens?(...)` | OAuth refresh |

`validate()` exists because the generic fallback — "call the first READ tool
with `{}`" — is wrong for any provider whose read tools have required
arguments. `google_calendar.list_events` demands `from_iso`/`to_iso`, so that
provider could *never* pass a test and sat permanently in `ERROR`. Adapters
with argument-hungry reads implement a cheap identity call instead.

`POST /api/integrations/:slug/test` prefers `validate()` and falls back to the
read-tool probe.

## 3. OAuth state: signed, bound, single-use

`packages/shared/src/lib/oauth-state-store.ts`

A signature proves *we* issued the state. It does **not** prove the state has
not been used before — a signed JWT with a 10-minute expiry is replayable for
those ten minutes by anyone who captures it (referrer logs, shared machine,
proxy). Every provider here had that hole.

So each state carries a `jti` and the callback **consumes** it:

- `mintOAuthState(claims)` → signed token carrying `tenantId`, `provider`,
  `userId`, `flow`, plus provider extras.
- `consumeOAuthState(raw, provider)` → verifies, then burns the `jti` via
  Redis `SET NX EX`. First consume wins; later ones return `replayed`.
- **Fails closed** when Redis is unreachable — degrading to "allow" would
  silently reopen the replay window.
- Legacy tokens with no `jti` are rejected.

**Return context travels inside the signed state**, never a query parameter —
that would be an open redirect, and it is also how onboarding lost its place
(the callback fell back to a hard-coded marketplace path). `returnPathForFlow()`
derives the destination and only ever emits a relative path.

All 8 marketplace providers plus the calendar, knowledge, CRM and channel OAuth
routes use this. `connectors-admin.ts` contains **zero** raw `jwt.sign` for
state.

### Known gap

**No PKCE except Airtable.** These are confidential server-side clients
exchanging codes with a client secret, so PKCE is defence-in-depth rather than
the primary control, and provider support varies. It was deliberately *not*
added blind: turning it on for a provider that mishandles it breaks a working
connector, and a real consent round-trip is needed to verify.

## 4. Onboarding reachability

OAuth init routes must use `requireOnboardingOrActiveTenant()`, **not**
`requireActiveTenant()`. During onboarding the tenant is `PENDING_ONBOARDING`,
so the stricter guard answers 403 and the connect silently dies — this was the
actual cause of "Monday doesn't connect in onboarding", and the same bug was
later found on the AI-employee builder routes.

Still `requireActiveTenant()` by design: `/connectors/:slug/status`,
`/disconnect`, `/config` and the `meta/*` pickers. Verified no frontend caller
reaches them during onboarding.

## 5. Provider status

| Provider | Status | Notes |
|---|---|---|
| **Monday** | Working | OAuth2. Callback now probes `api.monday.com/v2` (`query { me { id } }`) before persisting `CONNECTED`; failure persists `ERROR` + `lastError`. |
| **Google Calendar** | Working, narrow | Implements **`list_events` only**. The catalog previously advertised `create_event` and `check_availability`, which the adapter *throws* on — those rows were deleted. Booking goes through the validated `schedule_meeting` flow; availability through the built-in `check_availability` resolver. |
| **Calendly** | **Unavailable (unpublished)** | OAuth plumbing exists, but there is no registered `ProviderAdapter`, no tools, and nothing populates the `eventTypeUri` its booking path requires. Presenting a connect button would be a fake workflow, so `is_published = false` with an honest description. Existing `tenant_integrations` rows untouched — it returns the moment the adapter lands. |

## 6. The UI bug worth remembering

`IntegrationDrawer` rendered a **"Connect with OAuth" button with no `onClick`**.
Clicking it did literally nothing, for *every* OAuth provider surfaced there.
No error, no network call — which is why the reports said "connection does not
work" while backend traces looked clean.

When a connect appears dead, check the handler exists before suspecting the
provider.

## 7. Testing

- `packages/shared/src/__tests__/oauth-state-store.test.ts` (11) — single use,
  concurrent consume, provider mismatch, expiry, fail-closed, no open redirect.
- Live sweep: all 8 providers accept a state once and return
  `state_already_used` on replay of the same token.
