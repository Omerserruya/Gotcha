# Shopify Partner / Dev Dashboard — manual checks

**Do not change anything while working through this.** The purpose is to record
where the Dashboard and the repository disagree, so a human can decide. Every
"expected" value below comes from `shopify-app/shopify.app.production.toml` or
from the code, and is cited.

| # | Check | Expected (source) | Dashboard shows | Match? |
|---|-------|-------------------|-----------------|--------|
| 1 | **Embedded setting** | `embedded = false` (`shopify.app.production.toml:56`) | | |
| 2 | **App URL** | `https://app.gotcha.co.il/api/connectors/shopify/install` (`:77`) | | |
| 3 | **OAuth redirect URLs** | the three in `:107-111` — `app.`, apex and `dev.` `/api/connectors/shopify/oauth/callback` | | |
| 4 | **Shopify Connector plan exists** | handle `gotcha-connector`, monthly, public (production `SHOPIFY_BILLING_PLAN_CATALOG`) | | |
| 5 | **Plan status** | published / available to install | | |
| 6 | **Hosted pricing page resolves** | `admin.shopify.com/store/<store>/charges/<app>/pricing_plans` — the exact shape the server builds (`config.ts:357`) | | |
| 7 | **Return URL after approval** | returns to GOTCHA, landing on `/integrations/shopify/billing/complete` | | |
| 8 | **Listing visibility** | as intended for this submission (currently limited visibility) | | |
| 9 | **Test credentials** | review email present; password current and verified in Incognito today | | |
| 10 | **Test Instructions** | replaced with `01-billing-architecture.md` + `02-test-instructions.md` | | |
| 11 | **Screencast URL** | reachable without login, not expiring, correct video | | |
| 12 | **Support information** | monitored address; matches `04-reviewer-account-checklist.md` | | |
| 13 | **Requested scopes** | the 25 in `:89` — confirm the Dashboard grants exactly these, no more | | |
| 14 | **Protected customer data declarations** | `read_customers` / `write_customers` / `read_orders` / `read_all_orders` are requested, so PCD approval and the data-handling declarations must be complete and current | | |
| 15 | **Theme app extension / version** | `shopify-app/extensions/gotcha-chat` — confirm the published version is the one being demonstrated | | |
| 16 | **Pricing section in the listing** | describes the Connector as the Shopify-billed subscription and does not advertise GOTCHA Core plans as purchasable through Shopify | | |

## Notes worth carrying into the review

**Non-embedded (rows 1–3).** The repository declares `embedded = false`, and
the runtime matches: GOTCHA opens as a top-level application, does not depend on
Admin iframe cookies, does not require App Bridge session tokens, and does not
rely on storage inside an iframe. **Do not add App Bridge** to satisfy an
automated check aimed at embedded apps — it would be machinery guarding a case
that cannot occur here. If the Dashboard's embedded toggle disagrees with the
toml, that is a mismatch to report, not to silently fix.

**Scopes (row 13).** The list is broad because the adapter covers orders,
fulfilment, returns, discounts and customers. If the Dashboard grants scopes the
toml does not request, that gap is worth closing before review — a reviewer may
ask why a scope is held.

**Row 16 is the listing-side half of requirement 1.2.1.** The in-app Billing
page now states the separation; the listing must not contradict it.

## Mismatches found

_Record them here. Do not fix during this pass._

| Row | Dashboard value | Repo value | Decision | Who |
|-----|-----------------|-----------|----------|-----|
| | | | | |
