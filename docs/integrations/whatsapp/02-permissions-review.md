# WhatsApp: Facebook Login Permission Review

Phase 2 of the zero-friction onboarding redesign. Answers one question:
**which permissions should our Facebook Login for Business configuration
request, and why.**

Companion to [01-meta-api-inventory.md](./01-meta-api-inventory.md), which
carries the endpoint-level evidence.

---

## Where our permissions are actually declared

This matters, because it is a common source of confusion in this repo.

WhatsApp is the **only** Meta channel we connect through Facebook Login for
Business. Look at `services/auth/src/routes/channels.ts`:

```ts
// whatsapp
oauthUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=...&config_id=${EMBEDDED_SIGNUP_CONFIG_ID}&...`;

// messenger / other
oauthUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=...&scope=${scopes[platform]}`;
```

Messenger passes `scope=` in the URL. WhatsApp passes `config_id=` and **no
`scope` at all**, because a Login for Business configuration carries its own
permission set, defined in the App Dashboard.

**Consequence: no code change in this repo can alter which WhatsApp
permissions we request.** Everything below is a change to the configuration
identified by `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, made in the Meta App
Dashboard. This document is the specification for that change, and section 5
is the verification step that proves it took effect.

---

## 1. `whatsapp_business_management` - REQUIRED

Meta: "necessary if your app needs access to onboarded customer WhatsApp
Business account settings and message templates."

**Verdict: request it, and request Advanced Access.**

Nearly every call the redesign depends on needs it:

| Our need | Endpoint | Section |
|---|---|---|
| Discover which WABAs we were granted | `GET /debug_token` granular scopes | 2.1 |
| List WABAs in the portfolio | `GET /<PORTFOLIO_ID>/client_whatsapp_business_accounts` | 3 |
| Read WABA review + verification state | `GET /<WABA_ID>` | 4 |
| List numbers on a WABA | `GET /<WABA_ID>/phone_numbers` | 4 |
| Read `platform_type` and `is_on_biz_app` (flow selection) | `GET /<PHONE_NUMBER_ID>` | 5.1 |
| Read + write webhook subscriptions | `GET`/`POST /<WABA_ID>/subscribed_apps` | 4.1, 7.2 |
| Read health and Meta's own remediation text | `?fields=health_status` | 8 |
| Verify a number | `request_code` / `verify_code` | 5.2 |
| Migrate between WABAs | `POST /<WABA_ID>/phone_numbers` | 9.1 |

**Advanced Access specifically.** Meta's phone-numbers reference: "If you are
requesting the code on behalf of another business, the access token needs to
have Advanced Access to the `whatsapp_business_management` permission." Our
tenants are, by definition, other businesses. The same applies to
`client_whatsapp_business_accounts`, which the manage-accounts doc marks as
Advanced Access. Standard Access would work in our own test portfolio and fail
for every real customer, which is the worst possible failure shape: it passes
development and breaks in production.

---

## 2. `whatsapp_business_messaging` - REQUIRED

Meta: "necessary if your app needs access to onboarded customer business phone
number settings, or if your app will be used by customers to send and receive
messages."

**Verdict: request it. It is not optional for us.**

GOTCHA's entire product is sending and receiving WhatsApp messages
(`packages/shared/src/channels/whatsapp.adapter.ts`). Beyond messaging, it is
required for phone-number settings, and Meta's registration reference states
that `POST /<PHONE_NUMBER_ID>/deregister` requires **both**
`whatsapp_business_management` and `whatsapp_business_messaging`. Deregistration
is part of a clean disconnect, so both permissions are needed for the full
lifecycle, not just the happy path.

---

## 3. `business_management` - REQUIRED for this redesign, and we should add it

**This is the one substantive change.**

Meta's Embedded Signup overview scopes this permission narrowly: "Solution
Partners additionally require the `business_management` permission to share
credit lines." We are a Tech Provider, not a Solution Partner, and we do not
share credit lines. Read literally, that sentence says we do not need it.

But the Business Portfolio endpoints are Business Management API endpoints, and
`GET /<BUSINESS_PORTFOLIO_ID>/owned_whatsapp_business_accounts` is documented
under `business_management`. Without it we can see only the WABAs the customer
happened to tick during signup, discovered through `debug_token` granular
scopes. We cannot see:

- WABAs the customer already owns but did not select this time
- whether the portfolio is business-verified, which decides their number cap
  (2 vs 20, inventory section 5.4)
- whether a number they are about to add already lives in a WABA of theirs

**Every one of those is an input to Phase 3's inspector and Phase 4's automatic
flow selection.** Without `business_management`, the "detect the situation and
pick the right flow automatically" requirement degrades to "detect what the
customer just handed us", which is the behaviour we are replacing. Scenario C
(reuse existing Cloud API assets, do not create duplicates) is not reliably
detectable without it, and duplicate-WABA creation is exactly the outcome that
strands a customer's numbers across two accounts.

**Verdict: add `business_management` to the configuration.** It carries a real
cost, discussed in section 6, and it must degrade gracefully, specified in
section 4.

---

## 4. Hard requirement on the implementation: degrade, never fail closed

`business_management` is a heavier permission and Meta may grant Advanced
Access to it later than the two WhatsApp permissions, or a customer's admin may
decline it on the permissions screen. The inspector therefore treats portfolio
inspection as **best-effort enrichment, never a precondition**:

| Permission granted | Inspector behaviour |
|---|---|
| All three | Full portfolio sweep. Every scenario A-E detectable. |
| WhatsApp two only | Inspect exactly the WABAs in `debug_token` `target_ids`. Scenarios A, B, D fully detectable; C detectable only within granted WABAs; E offered only when its prerequisites are provably met. |
| Missing a WhatsApp permission | Report it as a named missing permission in the diagnostic model and stop before any write. |

The diagnostic model carries `missingPermissions[]` and `degraded: boolean` so
the UI can say what it could not check, rather than silently checking less.
An inspector that quietly narrows its own scope is worse than one that fails,
because it produces a confident wrong flow selection.

---

## 5. Verification: prove the grant, do not assume it

Requesting a permission in a configuration and receiving it from a specific
customer are different things. After every token exchange we call
`GET /debug_token?input_token=<BUSINESS_TOKEN>` and read `data.granular_scopes`,
which returns the scopes actually granted **and** the asset IDs each one covers.

That single call answers all of:

- did we get `whatsapp_business_management`, and for which WABAs
- did we get `business_management`, and for which portfolios
- did we get `whatsapp_business_messaging`

This is why section 4 is implementable: we never guess at our own permissions,
we read them per customer, per connection. It is also how a configuration
change is verified in production: connect one number and inspect the granular
scopes.

---

## 6. Permissions we deliberately do NOT request

Recorded so the decisions are not re-opened as oversights.

| Permission | Why not |
|---|---|
| `catalog_management` | The Embedded Signup payload can return `catalog_ids`, and WhatsApp supports product messages. We do not ship a WhatsApp catalog feature. Requesting permissions for unbuilt features lengthens App Review and adds scary checkboxes to the customer's consent screen for no delivered value. Revisit when commerce messaging is actually built. |
| `pages_messaging`, `pages_show_list` | Messenger's permissions. Messenger has its own OAuth path with its own `scope=` parameter (`channels.ts`). Folding them into the WhatsApp configuration would force a WhatsApp-only customer to consent to Page access. |
| `instagram_basic`, `instagram_manage_messages` | Same reasoning. Instagram connects through Instagram Login with its own app credentials (`INSTAGRAM_APP_ID`). |
| `ads_management` | Embedded Signup v4 can onboard Click-to-WhatsApp ads and auto-link numbers to Pages. Genuinely useful later; not part of this project, and it materially widens consent. |
| `whatsapp_business_manage_events` | Conversions API for WhatsApp, a v4 product. Same reasoning as ads. |

The principle: **the customer's consent screen is part of the onboarding
friction we are removing.** Every permission we add is another line of scary
text between "Connect WhatsApp" and "Done". Three permissions, each of which we
can point at a specific endpoint we call, is the right trade. Section 6's list
is what we give up to keep that true.

---

## 7. Summary

| Permission | Access level | Status | Reason |
|---|---|---|---|
| `whatsapp_business_management` | **Advanced** | Keep, confirm Advanced | Every inspection, subscription, health and verification call |
| `whatsapp_business_messaging` | **Advanced** | Keep, confirm Advanced | Sending and receiving; required with the above for deregister |
| `business_management` | Advanced when available | **ADD** | Portfolio sweep; makes Scenario C and the number-cap check possible. Must degrade gracefully |
| Everything else | - | Do not request | Consent-screen friction without a shipped feature |

### Action for the App Dashboard

On the configuration referenced by `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`:

1. Confirm `whatsapp_business_management` and `whatsapp_business_messaging` are
   both present at **Advanced Access**, not Standard.
2. Add `business_management`.
3. Plan the move to Embedded Signup **v4** before **2026-10-15**, when v2 is
   deprecated. This is also a configuration-level change, so it belongs in the
   same maintenance window as items 1 and 2.

Then connect one number and read `granular_scopes` from `debug_token` to prove
all three landed. The inspector surfaces this, so the check is a UI read rather
than a manual API call.
