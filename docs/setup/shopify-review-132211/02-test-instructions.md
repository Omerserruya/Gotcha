# Test Instructions (final version for submission 132211)

This replaces every earlier draft. Paste
[01-billing-architecture.md](./01-billing-architecture.md) at the top, then this.

---

## Before you start

GOTCHA is a **non-embedded** app. It opens as a normal top-level web
application rather than inside the Shopify Admin iframe, so there is no App
Bridge session token and no iframe storage to worry about. Signing in happens on
GOTCHA's own domain in the usual way.

Please use a **fresh Incognito window** so no existing session interferes.

**Review account:** `<REVIEW_EMAIL>`. The password is supplied separately in the
Partner Dashboard test-credentials field.

The supplied review account opens a dedicated review workspace. At the start of
review the workspace has no active Shopify store connection, so you can install
and connect your own review store and see the whole flow from the beginning.

---

## Installation and billing, in order

1. **Install from Shopify's App Review surface.** Start the installation from
   Shopify, not from a GOTCHA link.
2. **Approve the Shopify OAuth permission screen.**
3. **You are redirected to GOTCHA.** The authorized store is held as a pending
   installation; it is not yet attached to any workspace.
4. **Sign in** with the review account above. The pending installation survives
   the sign-in redirect.
5. **Claim the store.** GOTCHA shows the authorized store waiting to be
   attached. Attach it to the review workspace.

   **Stop here and look, before any payment.** This is the state the previous
   review asked about. The Shopify integration screen shows the store as
   **Authorized** with **Connector required** beside it: the OAuth grant is
   real and is not revoked, and no Shopify feature is switched on. The system
   toggle is off, writeback reads unavailable, and the Shopify tool count reads
   **0 of 68 available**. Meanwhile GOTCHA Core keeps working: WhatsApp,
   Instagram, email, web chat, the Inbox, manual knowledge and every
   non-Shopify integration are all live. Authorization and paid access are
   different facts, and the product says so on every screen that mentions
   Shopify.
6. **Continue to Shopify's hosted plan-selection page.** GOTCHA sends you to
   Shopify; the plan and its price are shown by Shopify.
7. **Approve the Shopify Connector subscription** on Shopify.
8. **You are returned to GOTCHA.**
9. **GOTCHA verifies the subscription directly with Shopify.** The return URL is
   not treated as proof of payment. GOTCHA performs its own authoritative read
   against Shopify before granting anything.
10. **Confirm Shopify becomes active.** The Shopify integration screen and the
    Billing screen both change to an active state only after that verification
    succeeds.
11. **Verify synchronization and Shopify functionality:** catalogue sync,
    Shopify products, Shopify customer and order context in the Inbox, a Shopify
    order action, and the storefront app embed.
12. **Open Billing** and confirm the two separate subscriptions: **GOTCHA Core**
    marked *Billed by GOTCHA*, and **Shopify Connector** marked *Billed and
    managed by Shopify*.

---

## What to look for at step 5 and step 10

This is the part that answers requirement 1.2.1, and it is worth checking
deliberately.

**Between step 5 and step 7 the store is authorized but unpaid.** In that
window GOTCHA shows *"Shopify Connector required"* and Shopify features are
off. This is not a display choice: the backend refuses Shopify reads, writes,
synchronization and storefront functionality for an unpaid store, so there is
nothing to show. The review account's GOTCHA Core subscription is active
throughout and does not change this.

**At step 10 the state changes only because Shopify confirmed the
subscription.** If you would like to see the negative case, decline the plan at
step 7: the store stays connected, GOTCHA Core keeps working, and every Shopify
capability stays off until a plan is approved.

---

## Billing screen, what it shows

- **GOTCHA Core**, *Billed by GOTCHA*. The standalone platform. States plainly
  that it does not include connection to Shopify or access to Shopify data.
- **Shopify Connector**, *Billed and managed by Shopify*, with the Shopify
  capabilities it unlocks listed, and the current subscription state. All
  purchase and management actions go to Shopify's hosted page; there is no
  GOTCHA checkout for the Connector, and GOTCHA does not display the Connector
  price because Shopify owns it.

Both sections are present at the same time. The page states explicitly that the
Connector is an additional subscription, not an alternative to Core.

---

## Support

`<SUPPORT_EMAIL>`, monitored during the review. If anything in this flow does
not behave as described, please tell us what you saw and we will reproduce it.
