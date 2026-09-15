# Shopify App Store review 132211: what changed, and how to test it

App: **GOTCHA** (client id `b1ce3aa5…5f76`)
Reference: **132211**
Status at rejection: Paused. Visibility: Limited.

This document is two things: the note to paste into the Partner Dashboard
resubmission, and the record of what was actually wrong. Sections 1 to 3 are
for us. Section 4 is written to be sent as-is.

---

## 1. What the reviewer reported

> We noticed that the app is currently integrated with your demo store. When we
> attempted to integrate our own store for testing, we received the following
> error message: "New Shopify connections aren't available just yet - our
> Shopify App Store listing is still being published. Contact support and we'll
> connect your store for you."

Cited under **4.5.5** (test credentials must grant the complete feature set),
with **1.1.1** listed separately under "Other updates".

## 2. Root cause

Nothing in the installation flow was broken. The reviewer's own app history
proves it: on their store, `Installed` at 9:17 pm was followed by
`Subscription charge activated` at 9:33 pm. OAuth, the store link, plan
selection and Partner API verification all completed on a store that was not
ours and was not on any list.

What failed was a single in-app shortcut, and it failed for a configuration
reason:

| Layer | Finding |
|---|---|
| `docker-compose.prod.yml` | `SHOPIFY_APP_HANDLE` was declared on the `billing` service and **never on `ai`**. |
| `chatcenter-ai-1` at runtime | The variable was **entirely absent**, confirmed by `docker inspect`. |
| `resolveShopifyInstallUrl()` | Returned `null`, because no handle was configured. |
| `GET /connectors/shopify/install/start` | Answered `503 shopify_install_not_available`. |
| `frontend/src/lib/shopify-connect.ts` | Rendered the sentence the reviewer quoted. |

A missing environment variable had become the merchant's error message.

Two aggravating factors sat behind it:

1. **One variable fed two different identifiers.** Shopify uses "handle" for
   the App Store listing slug (`apps.shopify.com/<slug>`) and for the app
   handle used in admin deep links (`/charges/<handle>/pricing_plans`). They
   are not guaranteed to match. Because a single variable drove both, keeping
   the pricing URL correct meant leaving it blank, which disabled the button.
2. **A server-side shop list gated billing.** `SHOPIFY_BILLING_TEST_SHOPS`
   decided which stores entered the App Pricing flow. A reviewer works from a
   store nobody added to that list, so the reviewer would have travelled a
   different code path from the one under review.

## 3. What changed

- **The Connect action can no longer refuse.** It always resolves to a
  Shopify-owned page. There is deliberately no fallback that asks the merchant
  to type a `.myshopify.com` domain, which requirement 2.3.1 forbids.
- **The handle was split** into `SHOPIFY_APP_STORE_HANDLE` (listing slug) and
  `SHOPIFY_APP_PRICING_HANDLE` (app handle), so an unknown value for one can
  never disable the other. Both are now set, and `ai` receives them.
- **The shop allowlist no longer gates anything.** It was removed from the
  post-install decision, from plan selection and from the verified return, and
  is retained only as a boot-time diagnostic. It was **not** replaced with a
  reviewer-specific tenant or shop allowlist. Every connected store now follows
  the same path; what varies is the evidence, not the code path.
- **Connecting a second store is now an explicit decision.** A workspace holds
  one Shopify store, so a second connection necessarily disconnects the first.
  That used to happen silently. The merchant is now shown which store would be
  disconnected and must confirm.

What did not change: the authorization rules. The shop is still read from the
stored connection and never from a query parameter or request body; a billing
return whose `shop` does not match is still refused; and reaching the billing
return URL is still treated as no evidence of payment, because Shopify appends
`plan_handle` and `shop` to a redirect anybody can replay. The subscription is
re-verified against the Partner API before any entitlement moves.

---

## 4. Notes for the reviewer (paste this)

Thank you for the detailed report and the screencast. They identified the
problem precisely.

**What was wrong.** The installation flow itself was working. The failure was a
self-imposed block in our own application: our "Connect Shopify" button
required an App Store listing handle that was missing from one service's
configuration, and when it was missing the button returned an error instead of
sending the merchant to Shopify. That error message is the one you saw. It has
been removed, and the underlying configuration gap has been fixed.

**What to test.** Sign in with the test credentials supplied with this
submission, then go to **Settings > Business Systems > Shopify** and press
**Connect Shopify**. You will be sent to Shopify to select and authorize your
own store. At no point are you asked to type a shop domain.

**One thing to be aware of about the listing URL.** The Connect button points
at our official App Store listing page. Because the app is still awaiting
approval, that URL is not publicly reachable yet. It will become available to
every merchant the moment the listing is approved, with no code change on our
side. So that you are not blocked by this during review, you can install
directly using the install link included with this submission, which exercises
exactly the same OAuth flow, the same store link and the same billing path.

**The test account.** The account supplied has no Shopify store attached, so
the Connect flow starts clean. If you connect a store and later wish to connect
a different one, the app will tell you which store would be disconnected and
ask you to confirm, rather than replacing it silently.

**On requirement 1.1.1.** GOTCHA is not an embedded app. `embedded` is `false`
in our app configuration, we ship no App Bridge and no session-token code, and
our live responses send `Content-Security-Policy: frame-ancestors 'self'` and
`X-Frame-Options: SAMEORIGIN`, so the application cannot be rendered inside the
Shopify admin at all. It is a standalone application that authenticates through
the authorization code grant. Your own screencast also shows the application
running correctly in an incognito window: the session, navigation and settings
pages all loaded there, and the only thing that stopped the flow was the
message described above.

---

## 5. Before resubmitting

- [ ] Confirm the test credentials sign in and the workspace has **no** Shopify
      store attached.
- [ ] Include the direct install link in the submission notes.
- [ ] Confirm `apps.shopify.com/gotcha-3` resolves once the listing is
      approved. Until then a 404 is expected: an unlisted listing is not
      publicly reachable, and an unlisted app still requires review before any
      merchant can install it.
- [ ] Do not run `shopify app deploy`. The live configuration was read back and
      compared on 2026-09-15 and matches this repository (26 scopes identical,
      redirect URLs, app URL, proxy and webhooks all matching), but the TOML
      omits `handle` and `use_legacy_install_flow`, which a deploy would
      overwrite on the live app.
