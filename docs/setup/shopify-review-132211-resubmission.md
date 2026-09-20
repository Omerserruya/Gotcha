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

There were **three** defects, not one. The first was the message the reviewer
saw; the other two are why they could not have connected a store even without
it, and they were only found after Shopify Support reframed the problem.

### 2a. The Connect button refused on a configuration gap

| Layer | Finding |
|---|---|
| `docker-compose.prod.yml` | `SHOPIFY_APP_HANDLE` was declared on the `billing` service and **never on `ai`**. |
| `chatcenter-ai-1` at runtime | The variable was **entirely absent**, confirmed by `docker inspect`. |
| `resolveShopifyInstallUrl()` | Returned `null`, because no handle was configured. |
| `GET /connectors/shopify/install/start` | Answered `503 shopify_install_not_available`. |
| `frontend/src/lib/shopify-connect.ts` | Rendered the sentence the reviewer quoted. |

A missing environment variable had become the merchant's error message.

Behind it sat a design fault: one variable fed two different identifiers. The
App Store listing slug (`apps.shopify.com/<slug>`) and the app handle used in
admin deep links (`/charges/<handle>/pricing_plans`) are not guaranteed to
match, so keeping the pricing URL correct meant leaving the variable blank,
which disabled the button.

### 2b. The sign-in redirect destroyed the parked installation

This is the one that actually mattered, and the database proves it. The
reviewer's store appears **nowhere** in our data: no `CommerceConnection`, no
`TenantIntegration`, no subscription, no entitlement. Shopify recorded
`Installed` and then an activated plan charge on it. OAuth succeeded and the
installation was then unreachable.

An install that begins on Shopify has no GOTCHA session, so the callback parks
the verified installation and redirects to
`/settings/business-systems/shopify/finish?handle=...`. That handle was the
only reference to the authorized store.

`AppLayout` sent every signed-out user to a bare `/login`. `beginLogin` then
recorded `window.location` as the return path, but by then the location **was**
`/login`, so the original URL was already gone. Sign in, land on the dashboard,
Shopify reads `DISCONNECTED`, and there is no route back. Every other caller in
the codebase passes `?next=`; the generic guard did not.

### 2c. The parked installation expired too quickly

`PENDING_CONNECTION_TTL_SECONDS` was 15 minutes. The reviewer installed at
21:17, so the record expired at 21:32; Shopify logged their plan approval at
21:33. Fifteen minutes is not enough for a first-time user to find credentials
and complete an identity-provider flow.

### 2d. A server-side shop list gated billing

`SHOPIFY_BILLING_TEST_SHOPS` decided which stores entered the App Pricing flow,
so a reviewer's store would have taken a different code path from the one under
review.

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
- **A parked installation now survives sign-in.** The handle is additionally an
  HttpOnly, SameSite=Lax cookie set at the OAuth callback, so it survives a full
  OIDC round trip. The Shopify settings screen surfaces the authorized store
  with a "Finish connecting" action instead of offering Connect to somebody who
  has just completed Shopify's OAuth. `AppLayout` now preserves the path AND
  query when bouncing to login.
- **The parked installation is held for 2 hours**, configurable via
  `SHOPIFY_PENDING_INSTALL_TTL_SECONDS` and clamped to [5m, 24h].
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
problem precisely, and your support team's follow-up was exactly right about
the cause.

**What was wrong.** Our installation and OAuth flow worked; your own app
history confirms it, showing the install and then an activated plan charge on
your store. The failure came afterwards. When an installation begins on
Shopify, the merchant has no GOTCHA session yet, so we park the authorized
store and ask them to sign in. Our sign-in redirect discarded the reference to
that parked installation, and a second defect expired it after fifteen minutes.
So after signing in there was no way to reach the store you had just
authorized, and the Shopify page correctly reported it as not connected.

Both are fixed. The reference now survives the entire sign-in flow, the parked
installation is held long enough to complete a first-time sign-in, and the
Shopify settings page now surfaces an authorized-but-unclaimed store directly,
with a "Finish connecting" action.

**How to test.**

1. Start the installation from your usual App Review surface and approve the
   requested permissions.
2. You will arrive at GOTCHA. Sign in with the supplied test account.
3. The store you just authorized is detected automatically and shown with a
   **Finish connecting** action. You do not need to install again, and you are
   never asked to type a `.myshopify.com` domain.
4. Complete Shopify App Pricing when prompted.
5. Shopify then shows as **CONNECTED**, and the full feature set is available.

**The test account.** It belongs to a workspace created specifically for this
review, with no Shopify store attached and no inherited state. A workspace uses
one Shopify store at a time; if you connect a second, the app names the store
that would be disconnected and asks you to confirm rather than replacing it
silently.

**About the "Connect Shopify" button.** It points at our App Store listing,
which is the compliant target once the listing is public. While the app is
still awaiting approval that URL is not publicly reachable, so please begin
from your App Review surface as above. Nothing else in the flow depends on
publication.

**On requirement 1.1.1.** GOTCHA is not an embedded app. `embedded` is `false`
in our app configuration, we ship no App Bridge and no session-token code, and
our live responses send `Content-Security-Policy: frame-ancestors 'self'` and
`X-Frame-Options: SAMEORIGIN`, so the application cannot render inside the
Shopify admin at all. Your screencast also shows it running correctly in a
Chrome Incognito window. We understand the Embedded App Checks can retain a
stale state after an app moves from embedded to non-embedded, and we would be
grateful if you could confirm whether 1.1.1 was a substantive finding here or
that stale signal.

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
