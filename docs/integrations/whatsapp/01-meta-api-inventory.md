# WhatsApp Platform: Official Meta API Inventory

Research pass for the zero-friction onboarding and multi-number redesign.
Every row below was read from Meta's own documentation on **2026-08-05**; the
source URL is carried with the row so a later reader can re-check it rather
than trust this file. Where Meta's docs do not state something, this file says
so instead of guessing.

**Graph API version in use: `v24.0`**, decided in one place
(`packages/shared/src/lib/meta-graph-version.ts`) and reviewed by 2027-10-01.
Meta's Embedded Signup pages currently show examples on `v25.0`; both are live
and the version choice is deliberate, not drift. See "Version notes" at the end.

---

## 0. Vocabulary, so the rest of the file is unambiguous

| Meta term | What it actually is |
|---|---|
| **Business Portfolio** (formerly Business Manager) | The container that owns WABAs. `<BUSINESS_PORTFOLIO_ID>` in endpoints. |
| **WABA** | WhatsApp Business Account. Groups phone numbers, templates, a funding source. |
| **Business phone number** | One WhatsApp number. Identified by `<PHONE_NUMBER_ID>`, which is NOT the phone number itself. |
| **Business integration system user access token** | The customer-scoped token we receive by exchanging the Embedded Signup code. Referred to below as the **business token**. |
| **Coexistence** | Meta's official name for onboarding a number that is already live in the WhatsApp Business *app*, so the app and Cloud API run side by side. |

---

## 1. Embedded Signup

### 1.1 Launch (browser, Facebook JS SDK)

```js
FB.login(fbLoginCallback, {
  config_id: '<CONFIGURATION_ID>',
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {} }
});
```

| Field | Value |
|---|---|
| Endpoint | Facebook JS SDK `FB.login`, not a Graph call |
| Token type | None (produces an authorization code) |
| Permissions | Declared on the Facebook Login for Business **configuration**, not inline |
| Prerequisites | App is a Tech Provider or Solution Partner; configuration ID created in App Dashboard |
| Docs | https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation |

### 1.2 The `WA_EMBEDDED_SIGNUP` message event

Posted to the opener window. Payload:

```
{
  data: {
    phone_number_id, waba_id, business_id,
    ad_account_ids?, page_ids?, dataset_ids?,
    catalog_ids?, instagram_account_ids?, waba_ids?   // waba_ids = multi-WABA
  },
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH' | 'FINISH_ONLY_WABA'
       | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
       | 'CANCEL'
}
```

`business_id` is the **Business Portfolio ID**, and it is the single most
valuable field we were not previously capturing: it is what makes the inspector
in section 8 possible without asking the customer anything.

On `CANCEL`, `data.current_step` names the abandoned screen. The full set:
`BUSINESS_ACCOUNT_SELECTION`, `WABA_PHONE_PROFILE_PICKER`,
`WHATSAPP_BUSINESS_PROFILE_SETUP`, `PHONE_NUMBER_SETUP`,
`PHONE_NUMBER_VERIFICATION`, `PERMISSIONS`.
Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/errors/

### 1.3 Version 4, and the v2 deprecation

| Fact | Detail |
|---|---|
| v4 released | 2025-10-08 |
| **v2 deprecated** | **2026-10-15** |
| What v4 changes | Asset selection, business info and permissions collapse onto a single page; multiple messaging products onboard in one flow; asset admins can share assets from other portfolios; phone numbers auto-link to Pages when onboarding to ads |
| New products in v4 | Conversions API (WhatsApp / Instagram / Messenger), Click to Messenger ads, Click to Instagram Direct ads |
| Docs | https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4 |

**This is a hard deadline, ~14 months out at time of writing.** v4 is selected
by the Facebook Login for Business *configuration*, not by a code parameter, so
the migration is a dashboard change plus verification that our event handling
copes with the v4 payload. Our handler must therefore be written against the
event *shape*, tolerating unknown `event` values, rather than against a fixed
list. That is a design constraint, recorded here so it is not rediscovered
under time pressure in 2026-10.

### 1.4 Onboarding volume limits

| Limit | Value |
|---|---|
| New business customers onboarded | 10 per rolling 7-day window |
| After Business Verification | 200 per rolling 7-day window |
| Sandbox accounts | valid 30 days |
| Test (`555`) numbers | 2 per business customer |

Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup

---

## 2. Token exchange

| Field | Value |
|---|---|
| Endpoint | `GET /oauth/access_token` |
| Params | `client_id`, `client_secret`, `code` |
| Returns | Customer-scoped **business token** |
| Token type | App credentials in, business token out |
| Prerequisites | Code from `WA_EMBEDDED_SIGNUP`; code is single-use and short-lived |
| Limitation | Meta's docs do **not** document a `redirect_uri` requirement for the Embedded Signup popup code. Our current code brute-forces four variants including `redirect_uri` permutations; that is a symptom of never having pinned the correct call, not of a genuine ambiguity. |
| Docs | https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation |

### 2.1 Reading what the token actually granted

| Field | Value |
|---|---|
| Endpoint | `GET /debug_token?input_token=<BUSINESS_TOKEN>` |
| Auth header | `Bearer <APP_ID>|<APP_SECRET>` (app access token) |
| Returns | `data.granular_scopes[]`, each `{ scope, target_ids[] }` |
| Use | `target_ids` for scope `whatsapp_business_management` are the WABA IDs the customer granted. For `business_management` they are the portfolio IDs. |
| Docs | https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/ |

This is the backbone of the inspector: it tells us **exactly** what we may
touch, before we touch anything. Note that Meta's doc says to "capture the
first ID in the `target_ids` array" - that instruction is correct for the
single-WABA case and **wrong for multi-number tenants**, which is precisely
the assumption this project removes. We read the whole array.

---

## 3. Business Portfolio / Business Management APIs

| Capability | Endpoint | Token | Permission | Notes |
|---|---|---|---|---|
| WABAs the portfolio owns | `GET /<BUSINESS_PORTFOLIO_ID>/owned_whatsapp_business_accounts` | business token | `business_management` | Fields: `id`, `name`, `currency`, `timezone_id`, `message_template_namespace`. Supports `filtering`/`sort` on creation time |
| WABAs shared with the portfolio | `GET /<BUSINESS_PORTFOLIO_ID>/client_whatsapp_business_accounts` | business token | `whatsapp_business_management` (**Advanced Access**) | Same field set |

Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/

**Limitation, documented:** Meta's page does not state a cap on WABAs per
portfolio. It does state a cap on *registered phone numbers* per portfolio (see
5.4). We do not invent a WABA cap.

---

## 4. WABA APIs

| Capability | Endpoint | Token | Permission |
|---|---|---|---|
| Read WABA | `GET /<WABA_ID>` | business token | `whatsapp_business_management` |
| List numbers | `GET /<WABA_ID>/phone_numbers` | business token | `whatsapp_business_management` |
| Read subscriptions | `GET /<WABA_ID>/subscribed_apps` | business token | `whatsapp_business_management` |
| Subscribe our app | `POST /<WABA_ID>/subscribed_apps` | business token | `whatsapp_business_management` |
| Health | `GET /<WABA_ID>?fields=health_status` | business token | `whatsapp_business_management` |

Readable WABA fields: `id`, `name`, `account_review_status`
(`PENDING` / `APPROVED` / `REJECTED`), `currency`, `timezone_id`,
`message_template_namespace`, `business_verification_status`,
`on_behalf_of_business_info`, `primary_funding_id`, `health_status`,
`owner_business_info`.

Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/

**Documented limitation:** "Existing WhatsApp Business Accounts (WABAs) that
were originally created via the developer app cannot be selected or onboarded
directly." (https://developers.facebook.com/docs/whatsapp/embedded-signup)
Our inspector must therefore treat a developer-app-created WABA as a
non-selectable asset and say so plainly rather than offering a flow that
will fail.

### 4.1 Subscription is what makes messages arrive

`GET /<WABA_ID>/subscribed_apps` returns `{ data: [...], paging: {} }` where
each entry is a WhatsAppApplication node. **Our app appearing in that list is
the only proof that inbound messages can reach us.** The current code treats a
failed `POST` as a soft warning on one path (`/connect/whatsapp-session`) and
correctly as fatal on the other (`/connect/whatsapp`); the redesign makes it
uniformly a first-class, re-checkable, repairable health fact.

Note: the Graph API *reference* page for `subscribed_apps`
(https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/)
states POST and DELETE are unavailable on that node. That page is the generic
Graph reference and is contradicted by the WhatsApp platform docs and by
production behaviour, where `POST /<WABA_ID>/subscribed_apps` is the documented
subscription call. We follow the WhatsApp platform docs and the webhook-override
page, both of which show POST explicitly. Recorded here because the discrepancy
will otherwise be re-found and mistaken for a bug.

---

## 5. Phone Number APIs

### 5.1 Reading numbers

| Capability | Endpoint | Token | Permission |
|---|---|---|---|
| List | `GET /<WABA_ID>/phone_numbers` | business token | `whatsapp_business_management` |
| Read one | `GET /<PHONE_NUMBER_ID>` | business token | `whatsapp_business_management` |

Readable fields on the phone number node: `id`, `display_phone_number`,
`verified_name`, `quality_rating`, `code_verification_status`, `name_status`
(beta), `status`, `throughput`, `is_official_business_account`,
`messaging_limit_tier`, `platform_type`, `certificate`, `account_mode`,
`webhook_configuration`.

List supports `sort=last_onboarded_time_ascending|descending` and
`filtering` on `account_mode` (`SANDBOX` | `LIVE`).

Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers

**Two fields carry the whole flow-selection decision:**

| Field | Meaning for us |
|---|---|
| `platform_type` | `CLOUD_API` means the number is already on Cloud API |
| `is_on_biz_app` | `true` means the number is also live in the WhatsApp Business app |

Both `true` together is exactly the Coexistence state.
Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/

**Documented limitation:** Meta's phone-numbers page does *not* publish a
complete enumeration of `status` values in one place. Values seen in the docs:
`CONNECTED` (required to send/receive), plus `PENDING`, `DELETED`, `MIGRATED`,
`BANNED`, `RESTRICTED`, `RATE_LIMITED`, `FLAGGED`, `DISCONNECTED`, `UNKNOWN`,
`UNVERIFIED` referenced in context. `quality_rating` values seen: `GREEN`,
`YELLOW`, `RED`, `NA`, `UNKNOWN`. Our code therefore treats these as open
string sets with known members, never as closed enums that would throw on an
unseen value.

### 5.2 Verification

| Capability | Endpoint | Params | Permission |
|---|---|---|---|
| Send code | `POST /<PHONE_NUMBER_ID>/request_code` | `code_method` (`SMS`\|`VOICE`), `language` | `whatsapp_business_management`, **Advanced Access** when acting for another business |
| Verify code | `POST /<PHONE_NUMBER_ID>/verify_code` | `code` | same |

If the number is already verified, `request_code` returns HTTP 400 with error
code **`136024`**. That is a success signal for us, not a failure.

Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers

### 5.3 Registration

| Capability | Endpoint | Params |
|---|---|---|
| Register | `POST /<PHONE_NUMBER_ID>/register` | `messaging_product: "whatsapp"`, `pin` (6 digits), optional `data_localization_region` (ISO 3166 alpha-2) |
| Deregister | `POST /<PHONE_NUMBER_ID>/deregister` | requires `whatsapp_business_management` **and** `whatsapp_business_messaging` |
| Set two-step PIN | `POST /<PHONE_NUMBER_ID>` with `{ "pin": "<6_DIGITS>" }` | |

Docs:
https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration ,
https://developers.facebook.com/docs/whatsapp/cloud-api/reference/two-step-verification/

**Three limitations that directly indict our current implementation:**

1. **The PIN is not ours to choose.** Meta: "If your verified business phone
   number already has two-step verification enabled, set this value to your
   number's 6-digit two-step verification PIN." Our code posts a hardcoded
   `pin: "000000"` and swallows the error. For any number with two-step
   verification already on, that call cannot succeed, and we then mark the
   channel `CONNECTED` anyway.
2. **Registration is rate limited to 10 requests per number per 72-hour moving
   window**, error code **`133016`**. Blind retries burn a scarce budget on a
   customer's number.
3. **There is no endpoint to disable two-step verification.** So a wrong PIN is
   not something we can programmatically clear. It must be surfaced to the
   customer as an input, which is the one unavoidable manual step in Scenario A
   for a number that already had two-step verification set.

### 5.4 Registered-number caps

| Stage | Cap |
|---|---|
| New business portfolio | **2** registered business phone numbers |
| After Business Verification, or on reaching a 2,000 messaging limit | **20** (Meta raises it automatically) |

Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers

This is the real ceiling on "unlimited numbers per tenant". Our architecture
must not assume one number; it also must not promise a customer more numbers
than Meta will register for them. The inspector reports the cap position.

---

## 6. Coexistence (WhatsApp Business app numbers)

| Field | Value |
|---|---|
| Trigger | Embedded Signup `extras.featureType = "whatsapp_business_app_onboarding"` |
| Completion event | `event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"`, payload carries `waba_id` |
| Customer requirement | WhatsApp Business app **2.24.17 or higher** |
| Registration | **Skip it.** Meta: "skip the phone number registration step, as the number is already registered." No PIN needed. |
| Required webhook fields | `history`, `smb_app_state_sync`, `smb_message_echoes` |
| Detection afterwards | `is_on_biz_app: true` **and** `platform_type: "CLOUD_API"` |
| Throughput | **Fixed 20 messages per second**, not scalable |
| History | Up to 180 days of chat history, delivered in three phases; media asset IDs only for messages within **14 days** of onboarding |
| Sync deadline | **24 hours** to synchronise contacts and messaging history, otherwise the customer must be offboarded |
| Companion devices | All supported except WhatsApp for Windows and WhatsApp for WearOS; companions unlink on onboarding and can be re-linked after |
| Disconnect signal | `account_update` webhook with `PARTNER_REMOVED` |

**Not supported on a Coexistence number:** group chats, disappearing messages,
view-once messages, live location, broadcast lists, voice and video calls,
business tools, messaging tools, business profile edits, channels.

**Customer-side manual step:** the customer receives a verification code by
message from the official Facebook Business Account, taps **Connect** in their
WhatsApp Business app, optionally shares chat history, and pastes the code.
This cannot be automated, by design. It is not a QR scan in the current flow;
our UI copy must describe what actually happens.

Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/

---

## 7. Webhooks and app subscriptions

### 7.1 Resolution order

Meta resolves a webhook destination in this order:

1. the **phone number's** override callback URL, if set
2. the **WABA's** override callback URL, if set
3. the **app's** default callback URL

Overridable fields: `messages`, `message_echoes`, `calls`, `consumer_profile`,
`messaging_handovers`, group updates, `smb_message_echoes`,
`smb_app_state_sync`, `history`, `account_settings_update`.
**Template and account-level webhooks always go to the app's default URL** and
cannot be overridden.

### 7.2 Endpoints

| Action | Call |
|---|---|
| Set WABA override | `POST /<WABA_ID>/subscribed_apps` with `{ override_callback_uri, verify_token }` |
| Read WABA override | `GET /<WABA_ID>/subscribed_apps` (response carries `override_callback_uri`) |
| Remove WABA override | `POST /<WABA_ID>/subscribed_apps` with an empty body |
| Set number override | `POST /<PHONE_NUMBER_ID>` with `{ webhook_configuration: { override_callback_uri, verify_token } }` |
| Read number override | `GET /<PHONE_NUMBER_ID>?fields=webhook_configuration` |
| Remove number override | `POST /<PHONE_NUMBER_ID>` with `{ webhook_configuration: { override_callback_uri: "" } }` |

URL limit: 200 characters. Verify token: no documented limit.

Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/

**Design note.** Per-number overrides are a real capability and they are
tempting for multi-number isolation, but they are *not* what we need: GOTCHA
has one webhook endpoint and routes by `phone_number_id` inside the payload.
Adding overrides would give every number a distinct URL to keep healthy, which
multiplies failure modes rather than reducing them. We read them (to detect a
number pointed somewhere else, which is a genuine "another platform owns this
number" diagnosis) and we do not set them. Recorded so the decision is not
re-litigated as an oversight.

---

## 8. Health status

| Field | Value |
|---|---|
| Endpoint | `GET /<WABA_ID>?fields=health_status` and `GET /<PHONE_NUMBER_ID>?fields=health_status` |
| Token | business token |
| Permission | `whatsapp_business_management` |

Response carries `can_send_message` plus an `entities` array covering the WABA,
the business, the phone number and message templates, each with its own
`can_send_message` and, when blocked, `errors[]` with `error_code`,
`error_description` and `possible_solution`.

`can_send_message` values: `AVAILABLE`, `LIMITED`, `BLOCKED`.

**This single call is the correct basis for our per-number health panel**,
because `possible_solution` is Meta's own remediation text and is far more
accurate than anything we could infer. Our health engine reports it verbatim
alongside our own checks rather than paraphrasing it.

Meta's canonical URL for this moved during the docs reorganisation; the field
is documented on the WABA and phone number reference pages under
`health_status`. Both `docs/whatsapp/cloud-api/guides/monitor-account-health`
and `docs/whatsapp/business-management-api/guides/monitor-account-health/`
returned 404 on 2026-08-05, so this row is recorded from the reference pages
and must be re-verified when Meta republishes the guide.

---

## 9. Migration APIs

### 9.1 Between WABAs, programmatically

| Step | Call |
|---|---|
| 1. Initiate | `POST /<DESTINATION_WABA_ID>/phone_numbers` with `cc`, `phone_number`, `migrate_phone_number: true` -> returns `{ id: <PHONE_NUMBER_ID> }` |
| 2a. Request code | `POST /<PHONE_NUMBER_ID>/request_code` with `code_method`, `language` |
| 2b. Verify | `POST /<PHONE_NUMBER_ID>/verify_code` with `code` |
| 3. Register | `POST /<PHONE_NUMBER_ID>/register` with `messaging_product`, `pin` |

Permission: `whatsapp_business_management`. Initiated by the **destination**
WABA owner.

**Prerequisites, all mandatory:**

- number currently registered with the source WABA
- **two-step verification disabled** on the number
- `name_status` is `APPROVED`, with no pending display-name change
- source WABA: Business Verification approved, review status Approved
- destination WABA: Business Verification and WABA review approved, payment
  method configured, and **at least one app already subscribed to its webhooks**

**Limitations:**

- test numbers cannot be migrated
- **"Business phone numbers in use with the WhatsApp Business App cannot be
  migrated using this process"**
- only high-quality templates migrate; rejected/pending ones do not
- template quality ratings do **not** migrate; every migrated template starts
  `UNKNOWN` and stays unknown for 24 hours

Docs: https://developers.facebook.com/docs/whatsapp/business-management-api/guides/migrating-phone-numbers-between-wabas-programmatically

### 9.2 From the consumer app / Business app to Cloud API

There is **no API for this**. Meta's documented path is manual: the customer
opens WhatsApp, goes to Settings > Account > Delete my account, confirms, and
waits up to 3 minutes for the number to become available. Consequences Meta
states explicitly:

- "Your existing messaging history will be lost"
- "You will be unable to use that number with the WhatsApp Business app again,
  unless you deregister the number from Cloud API"

Meta's own recommended alternative is to onboard through Coexistence instead,
which preserves history and keeps the app usable.

Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/migrate-existing-whatsapp-number-to-a-business-account/

**Product consequence, and this is the answer to Phase 6 Option 2:** "Move
completely to GOTCHA" is a destructive, manual, partially irreversible path
that Meta does not expose an API for. We therefore do **not** present it as an
equal option. Coexistence is presented as the path; full migration is described
only as a consequence-labelled advanced action, and only for a number where the
prerequisites in 9.1 are actually met.

---

## 10. Multi-number support: what Meta actually allows

| Question | Answer | Source |
|---|---|---|
| Can one WABA hold many numbers? | Yes. `GET /<WABA_ID>/phone_numbers` returns a list. | 5.1 |
| Can one portfolio hold many WABAs? | Yes. `owned_whatsapp_business_accounts` returns a list. | 3 |
| Can one customer grant us several WABAs at once? | Yes. The Embedded Signup payload carries `waba_ids` for the multi-WABA case, and `debug_token` `target_ids` is an array. | 1.2, 2.1 |
| Is there a ceiling? | Yes: **registered numbers per portfolio**, 2 before Business Verification, 20 after. Not documented as a WABA count limit. | 5.4 |
| Does adding a number disturb existing ones? | Not at the Meta layer. Every call above is keyed by `<PHONE_NUMBER_ID>` or `<WABA_ID>`. Blast radius is ours to control, and today it is not controlled: our connect route loops over **every** number in the WABA. | 5.1 |

**Conclusion: multi-number is fully supported by Meta and is entirely a
GOTCHA-side architecture problem.** Nothing in Meta's platform forces the
one-number-per-tenant shape our code currently assumes.

---

## 11. Version notes

| Surface | Version | Note |
|---|---|---|
| Our Graph calls | `v24.0` | Single source: `packages/shared/src/lib/meta-graph-version.ts`, available until 2028-02-18 |
| Meta's Embedded Signup examples | `v25.0` | Released 2026-02-18, available until 2028-07-29 |
| FB JS SDK loaded by our frontend | `v25.0` | The SDK mints the popup code against its own version |
| Latest released | `v26.0` | Released 2026-07-29 |

The SDK version and the Graph version are allowed to differ: the code exchange
is an OAuth call, not a WhatsApp call, and Meta serves it on any live version.
Our current code's four-attempt exchange fallback exists because that was never
established. Section 2 pins it.

---

## 12. Explicitly impossible, and why

| Wanted | Verdict | Reason and source |
|---|---|---|
| Automate the Coexistence connect step | **Impossible** | The customer must tap Connect in their WhatsApp Business app and paste a code delivered to that app. Meta requires the device-holder's consent by design. (6) |
| Automate consumer/Business-app to Cloud API migration | **Impossible** | No API exists. Manual account deletion only. (9.2) |
| Disable two-step verification programmatically | **Impossible** | "There is no endpoint to disable two-step verification." (5.3) |
| Register a number whose two-step PIN we do not know | **Impossible** | The PIN is a required parameter and cannot be reset by us. Must be collected from the customer. (5.3) |
| Onboard a WABA created via a developer app | **Impossible** | "cannot be selected or onboarded directly". (4) |
| Migrate a number that is in use with the WhatsApp Business app | **Impossible** | Explicitly excluded from the migration process. (9.1) |
| Exceed the portfolio's registered-number cap | **Impossible** | 2 before verification, 20 after; raised by Meta, not by us. (5.4) |
| Complete Business Verification for the customer | **Impossible** | Meta requires the business to submit its own documentation. No API. |
| Set a display name without review | **Impossible** | `name_status` is reviewed by Meta; we can only read it. (5.1) |

---

## 13. What this inventory changes about our current implementation

Recorded as findings, not as fixes; the fixes are the rest of this project.

1. `POST /connect/whatsapp` loops over **every** phone number in the WABA and
   connects all of them. A customer adding their support number gets their
   sales number silently re-bound too. This is the single biggest obstacle to
   Phase 7.
2. `pin: "000000"` is hardcoded, and its failure is logged as a "note" and
   ignored. See 5.3.
3. Four speculative token-exchange attempts, one of which targets a
   hardcoded `v25.0`. See 2.
4. `debug_token` reads `target_ids[0]` only, discarding the rest. See 2.1.
5. `business_id` from the signup payload is never captured, so we can never
   inspect the portfolio. See 1.2.
6. `/connect/whatsapp-session` treats webhook subscription failure as a
   warning and still writes `CONNECTED`. See 4.1.
7. `platformMeta` stores only `wabaId` and `qualityRating`; there is nowhere to
   record platform type, coexistence, verification, messaging status, health,
   or the flow that connected the number. See Phase 7 requirements.
8. Nothing reads `health_status`, `platform_type` or `is_on_biz_app`, so no
   flow selection is possible and no honest health can be shown.
9. Embedded Signup v2 deprecation on 2026-10-15 is not tracked anywhere.
