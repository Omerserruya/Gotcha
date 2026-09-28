# Screencast script — one continuous recording

**Target length: 6–8 minutes.** One take, no cuts. The reviewer is checking a
billing boundary, not evaluating the product, so every second spent on an
unrelated GOTCHA feature is a second they have to sit through. Resist showing
the Inbox in depth, the AI builder, analytics, or anything not on this list.

**Recording setup:** Chrome Incognito, 1440×900, browser zoom 100%, no
extensions, no bookmarks bar, no notifications. Narrate briefly or add captions;
either is fine, but the URL bar must stay visible throughout so the reviewer can
see which domain they are on at each step.

| # | Shot | What must be on screen | Say / caption | ~t |
|---|------|------------------------|---------------|-----|
| 1 | Incognito window opens | Empty Incognito, URL bar visible | "Fresh Incognito, no existing session." | 0:00 |
| 2 | Shopify review install surface | Shopify's own install page for GOTCHA | "Starting the install from Shopify." | 0:10 |
| 3 | OAuth permission screen | Shopify's permission/scopes screen | "Approving the requested scopes." | 0:25 |
| 4 | Redirect to GOTCHA | URL bar changes to the GOTCHA domain | "Shopify redirects to GOTCHA. Non-embedded: this is a normal top-level app, not an Admin iframe." | 0:40 |
| 5 | Sign in | GOTCHA login, review account | "Signing in with the review account." | 0:55 |
| 6 | Clean workspace | Workspace with no Shopify connection | "This workspace has no Shopify store connected." | 1:10 |
| 7 | Pending store detected | The authorized store shown waiting to be claimed | "The authorized store survived the sign-in redirect and is waiting to be attached." | 1:20 |
| 8 | Claim the store | Store attached to this workspace | "Attaching it to this workspace." | 1:35 |
| 9 | **Shopify still unavailable** | Shopify integration screen showing *Shopify Connector required*; Shopify features off | "The store is authorized, but nobody has paid Shopify yet, so every Shopify capability is off. OAuth alone does not grant access." | 1:50 |
| 9b | **Billing screen, mid-flow** | GOTCHA Core active *and* Connector required, side by side | "Core is active and billed by GOTCHA. It does not include Shopify. The Connector is separate and not yet active." | 2:10 |
| 10 | Shopify hosted pricing page | `admin.shopify.com/.../charges/.../pricing_plans` in the URL bar | "Plan selection happens on Shopify's page. Shopify shows the price." | 2:35 |
| 11 | Approve the Connector | Shopify's approval confirmation | "Approving the Shopify Connector." | 2:50 |
| 12 | Redirect back to GOTCHA | URL bar back on the GOTCHA domain | "Back in GOTCHA." | 3:05 |
| 13 | **Active / connected** | Connector shows active; Shopify integration connected | "GOTCHA verified the subscription directly with Shopify before changing anything. The return URL is not treated as proof of payment." | 3:15 |
| 14 | Initial synchronization | Catalogue sync running / completing | "Initial Shopify synchronization starts now that the Connector funds it." | 3:35 |
| 15 | **Billing page, final** | Core: *Billed by GOTCHA* + "does not include connection to Shopify"; Connector: *Billed and managed by Shopify* + capability list | "Two separate subscriptions, held at the same time. Core billed by GOTCHA, Connector billed and managed by Shopify." | 3:55 |
| 16 | Shopify data in GOTCHA | Shopify products, and an order/customer context panel in the Inbox | "Shopify products and order context, all funded by the Connector." | 4:30 |
| 17 | Storefront app embed | The app embed live on the Shopify storefront | "The storefront app embed." | 5:00 |
| 18 | Customer interaction | A real message from the storefront reaching the Inbox | "A customer message from the storefront." | 5:20 |
| 19 | Shopify action + approval | A Shopify-backed action proposed, approved, executed | "A Shopify order action, through the approval flow." | 5:45 |
| 20 | Final confirmation | Billing page once more, both sections visible | "Core and the Shopify Connector, coexisting. Cancelling the Connector would switch Shopify off and leave Core running." | 6:20 |

---

## The three shots that actually answer the finding

If time or a retake forces a trade-off, protect these:

- **Shot 9 + 9b** — authorized but unpaid, with Shopify off and Core on. This
  is the proof that Core does not carry Shopify.
- **Shot 13** — active only after server-side verification.
- **Shot 15** — both subscriptions on one screen, each naming its biller.

## Do not film

- Signing up for GOTCHA Core, or any GOTCHA checkout. The reviewer must not be
  left wondering whether Shopify functionality was bought outside Shopify.
- Any screen showing a password, token, shop access token or subscription id.
- Deep tours of the AI builder, analytics, automations or channel setup.
