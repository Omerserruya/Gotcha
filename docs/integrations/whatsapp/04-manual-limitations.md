# WhatsApp: What Cannot Be Automated, and Why

Phase 11 deliverable 7. Every onboarding step that stays manual because **Meta
requires a human**, with the documentation that says so.

The test applied throughout: *if Meta publishes an API for it, we call it.* Each
row below exists because no such API exists, or because Meta explicitly requires
the person holding the phone or running the business to act. Nothing here is a
shortcut we chose not to build.

Read with [01-meta-api-inventory.md](./01-meta-api-inventory.md), which carries
the endpoint evidence.

---

## Summary

| # | Manual step | Which flows | Blocking? |
|---|---|---|---|
| 1 | Grant permissions on Meta's consent screen | all | yes |
| 2 | Enter the phone verification code | A, E | yes |
| 3 | Enter the existing two-step verification PIN | A, E | yes, when set |
| 4 | Tap Connect in the WhatsApp Business app | B | yes |
| 5 | Complete Business Verification | any blocked account | yes, Meta-side |
| 6 | Display name review | new or changed names | no, async |
| 7 | Delete the WhatsApp account to move off the Business app | full migration | not offered |
| 8 | Disconnect the number from another platform | numbers with a webhook override | yes |
| 9 | Add a payment method | messaging beyond the free tier | Meta-side |
| 10 | Raise the registered-number cap | 3rd number before verification | automatic, on Meta's timing |

---

## 1. Granting permissions on Meta's consent screen

**What.** The customer picks their business, picks or creates a WhatsApp
account, and approves the permissions GOTCHA requests.

**Why it cannot be automated.** This is OAuth consent. Automating it would mean
acting on a person's Meta account without their knowledge, which is both a
policy violation and the thing consent exists to prevent.

**What we do instead.** Reduce it to one screen. Embedded Signup v4 collapses
asset selection, business information and permissions onto a single page
(inventory 1.3), and we request only three permissions, each traceable to an
endpoint we actually call
([02-permissions-review.md](./02-permissions-review.md)). Every permission we do
not request is one less line of alarming text between "Connect WhatsApp" and
"Done".

**Docs.** https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation

---

## 2. Entering the phone verification code

**What.** Meta sends a code by SMS or voice call to the number being added. The
customer enters it.

**Why it cannot be automated.** Possession of the number is the entire point of
the check. We can *request* the code programmatically
(`POST /<PHONE_NUMBER_ID>/request_code`) and *submit* it
(`POST /<PHONE_NUMBER_ID>/verify_code`), but the digits arrive on the
customer's device.

**What we do instead.** Both API calls are automated, so the customer's only
task is typing six digits. We also detect the case where none of this is
needed: an already-verified number returns HTTP 400 with code **136024**, which
the client treats as success rather than failure.

**Affects.** Scenario A, Scenario E. Not B (already verified through the app),
not C (already verified), not D.

**Docs.** https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers

---

## 3. Entering the existing two-step verification PIN

**What.** Registering a number that already has two-step verification requires
that number's existing 6-digit PIN.

**Why it cannot be automated.** Three separate reasons, and each alone is
sufficient:

- Meta requires the parameter: *"If your verified business phone number already
  has two-step verification enabled, set this value to your number's 6-digit
  two-step verification PIN."*
- There is **no endpoint to read** the PIN.
- Meta states plainly: **"there is no endpoint to disable two-step
  verification."** So we cannot clear it and set our own.

**What we do instead.** The pipeline reaches `ACTION_REQUIRED` with
`pendingAction: TWO_STEP_PIN` and asks, with an explanation of why nobody else
can reset it. Meta error **133005** (incorrect PIN) returns the customer to the
same prompt rather than failing the connection.

**What this replaces.** The previous implementation hardcoded `pin: "000000"`,
logged the inevitable failure as a "note", and marked the channel `CONNECTED`.
For any number with two-step verification already on, that call could not
succeed.

**Guardrail.** `MetaWhatsAppClient.register(phoneNumberId, pin, ...)` makes
`pin` a required positional parameter, so no future caller can reintroduce a
hardcoded default without deliberately writing one.

**Docs.**
https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration ,
https://developers.facebook.com/docs/whatsapp/cloud-api/reference/two-step-verification/

---

## 4. Tapping Connect in the WhatsApp Business app

**What.** For Coexistence, Meta messages a verification code to the number from
the official Facebook Business Account. The customer opens WhatsApp Business on
their phone, taps **Connect**, optionally chooses to share chat history, and
pastes the code.

**Why it cannot be automated.** This is Meta's consent mechanism for letting a
platform read and send on a number that is live on someone's personal device.
Automating it would let a platform attach itself to a business's WhatsApp
without the phone holder's knowledge.

**What we do instead.** Explain precisely what will happen before it happens.
The connect screen says a code is coming and that they will tap Connect in the
app. We do not describe it as a QR scan; the current flow is a code, and
telling someone to look for a QR they will never see is its own friction.

**Prerequisite the customer must meet.** WhatsApp Business app **2.24.17 or
higher**.

**Deadline the customer does not see.** Meta gives partners **24 hours** after
onboarding to synchronise contacts and history, or the number must be
offboarded.

**Docs.** https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/

---

## 5. Completing Business Verification

**What.** Meta requires the business to submit legal documentation proving it
is who it says it is.

**Why it cannot be automated.** It is a legal identity check on the customer's
company. There is no API, and there could not be one.

**What we do instead.** We never ask for it speculatively. It surfaces only
when it is actually blocking something, through `health_status`, and we render
**Meta's own `possible_solution` text verbatim** rather than paraphrasing it.
Meta knows why it blocked an account; our summary of that would be strictly
worse and would leave the customer unable to act.

**Downstream effects the customer will notice.**

- The portfolio's registered-number cap stays at **2** instead of **20**
  (inventory 5.4). Directly limits Phase 7's multi-number promise.
- Programmatic WABA-to-WABA migration is unavailable: both source and
  destination must be verified (inventory 9.1).
- Onboarding volume for us stays at 10 rather than 200 new customers per
  rolling 7 days (inventory 1.4).

**Docs.** https://developers.facebook.com/docs/whatsapp/overview/business-accounts/

---

## 6. Display name review

**What.** The name recipients see is reviewed by Meta. `name_status` moves
through `PENDING_REVIEW` to `APPROVED` or `DECLINED`.

**Why it cannot be automated.** It is a human policy review against WhatsApp's
naming guidelines.

**What we do instead.** Read `name_status` and report it. On `DECLINED` we say
what to do: choose a different name in WhatsApp Business settings. We do not
block connection on a pending review, because a number can be connected and
working while its name is still under review.

**Where it does block.** Migration requires `name_status = APPROVED` with no
pending change (inventory 9.1), so `evaluateMigration` returns `null` and the
migration option is not shown at all.

**Docs.** https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers

---

## 7. Moving a number off the WhatsApp Business app entirely

**What.** Phase 6's "Option 2: move completely to GOTCHA".

**Why it cannot be automated, and why we do not offer it.** Meta publishes **no
API** for this. The documented path is entirely manual and destructive: the
customer opens WhatsApp, goes to Settings > Account > Delete my account,
confirms, and waits up to 3 minutes for the number to become available. Meta
states the consequences plainly:

> "Your existing messaging history will be lost"
>
> "You will be unable to use that number with the WhatsApp Business app again,
> unless you deregister the number from Cloud API"

Meta's own recommended alternative is Coexistence, which preserves history and
keeps the app usable.

**What we do instead.** `businessAppOptions().fullMigration.available` is
**always `false`**, and the option is rendered as unavailable with the reason
stated, rather than hidden. A customer who has heard that platforms can "take
over" a number needs to know why we decline, or they will assume we simply
cannot do it. There is a test asserting it is never offered.

**Note on the separate, real migration API.** Meta *does* support programmatic
migration **between WABAs** (inventory 9.1), and we implement it as Scenario E.
It explicitly excludes Business app numbers: *"Business phone numbers in use
with the WhatsApp Business App cannot be migrated using this process."* The two
are different operations and are not conflated in the UI.

**Docs.** https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/migrate-existing-whatsapp-number-to-a-business-account/

---

## 8. Disconnecting the number from another platform

**What.** A number whose webhooks point at another provider's URL.

**Why it cannot be automated.** We can *read* the override
(`GET /<PHONE_NUMBER_ID>?fields=webhook_configuration` and the
`override_callback_uri` on `subscribed_apps`), and we could technically
overwrite it. We do not. Silently seizing a number another platform is actively
serving would break that platform's customer relationship without anyone
deciding to.

**What we do instead.** Detect it and report it as a `WEBHOOK_OVERRIDDEN`
blocker: *"Another platform is currently receiving this number's messages.
Disconnect it there before connecting it to GOTCHA."* The flow selector treats
it as fatal, so we never half-connect a number whose messages will go elsewhere.

**Docs.** https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/

---

## 9. Adding a payment method

**What.** A funding source on the WABA, read as `primary_funding_id`.

**Why it cannot be automated.** It is the customer's billing relationship with
Meta. No API, and correctly so.

**What we do instead.** Read `primary_funding_id` during inspection. It is a
mandatory prerequisite on the *destination* WABA for migration, so its absence
withholds the migration option rather than letting a customer start something
that will fail.

---

## 10. Raising the registered-number cap

**What.** A new business portfolio may register **2** business phone numbers.
On Business Verification, or on reaching a 2,000 messaging limit, Meta raises
this to **20** automatically.

**Why it cannot be automated.** Meta raises it; there is no endpoint to
request it.

**What we do instead.** The inspector computes `registeredNumberCap` per
portfolio from its verification status and reports where the customer stands.
This is the honest ceiling on "unlimited numbers": the architecture must not
assume one number, and equally must not promise a customer more numbers than
Meta will register for them.

**Docs.** https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers

---

## What is fully automated

For contrast, everything below happens with no customer involvement, because
Meta publishes an API and we call it:

- exchanging the authorization code for a business token
- discovering which permissions and which assets were granted (`debug_token`)
- listing business portfolios, owned WABAs and shared WABAs
- reading WABA review status, business verification status and funding
- listing every phone number with `platform_type` and `is_on_biz_app`
- deciding which of the five onboarding flows applies
- subscribing our app to the WABA's webhooks, **and reading it back to confirm**
- registering the number, where registration is actually required
- requesting and submitting the verification code
- reading display name, quality rating, throughput, messaging limit tier
- reading `health_status` on both the account and the number
- re-subscribing webhooks as a one-click repair
- disconnecting one number without disturbing its siblings

**No step in this list requires anyone to open the Meta Business Dashboard.**
The manual steps above are manual because Meta requires a person, not because
we left something unbuilt.

---

## Non-limitations worth stating

Things that look like limits and are not:

| Assumption | Reality |
|---|---|
| "A tenant can only have one WhatsApp number" | False at Meta and false here. The cap is registered numbers per portfolio (2, then 20), not per tenant. |
| "Numbers must share one WABA" | False. A tenant may span several WABAs and several portfolios; `debug_token` returns an array of granted WABA ids. |
| "Adding a number risks the existing ones" | Not at the Meta layer: every call is keyed by phone number id or WABA id. It was true in our old code, and is what this project removed. |
| "Coexistence is a degraded mode" | It is Meta's recommended path for a Business app number. The real trade is throughput (fixed 20 messages per second) and the unsupported message types, both stated up front on the connect screen. |
