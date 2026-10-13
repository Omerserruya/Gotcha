# Policy → enforcement → evidence

Every row: the requirement, the code that enforces it, the automated test that
would fail if it stopped being true, the manual check, and where it appears in
the screencast. Shot numbers refer to `03-screencast-script.md`.

| # | Requirement | Enforcement point | Automated test | Manual check | Shot |
|---|-------------|-------------------|----------------|--------------|------|
| 1 | Shopify-tied paid capability must be billed through Shopify | `shopify-authorization.ts` — only `SHOPIFY_SUBSCRIPTION` / `SHOPIFY_GRANDFATHERED` count | `shopify-authorization.test.ts` "a Core plan granting a shopify_* key does NOT authorize Shopify" | Approve the Connector and watch access appear only after | 13 |
| 2 | A Core plan must never unlock Shopify | `entitledIn()` requires a Shopify funding source; `CORE_FEATURES` carries no Shopify key | `shopify-entitlement-boundary.test.ts`; `plan-capability-matrix.test.ts` "no GOTCHA-billed plan sells Shopify" | Billing page with Core active, Connector absent | 9b |
| 3 | One entitlement must not unlock all | per-capability check + `shopify-capability-map.ts` | `shopify-capability-matrix.test.ts` — 16 cells, 12 denials | n/a (not merchant-visible) | — |
| 4 | Shopify API calls require the entitlement | `loadConnection()` with a named capability; sole credential path | `shopify-connection-gate.test.ts` "one funded capability does not unlock another" | Products fail to load pre-approval | 9 |
| 5 | Synchronization requires the entitlement | `shopify-catalog.service` → `CATALOG` | `shopify-connection-gate.test.ts` | Sync starts only post-approval | 14 |
| 6 | Shopify-derived context requires it | `commerce-context.service` → `ORDER_CONTEXT` | same | Inbox order panel empty pre-approval | 9, 16 |
| 7 | Shopify AI tools require it | tool SURFACE + dispatch in `ai-bot.service` / `executeAdapterTool` | `shopify-capability-matrix.test.ts` tool classification + drift guard | Agent has no Shopify tools pre-approval | 9 |
| 8 | Shopify human-agent actions require it | `requireFeature(SHOPIFY_PRODUCT_MESSAGING)` → veto | `shopify-authorization.test.ts` | Product picker unavailable pre-approval | 9 |
| 9 | Storefront/app embed requires it | `SHOPIFY_LIVE_CHAT` → `shopify_storefront_widget` | `shopify-entitlement-boundary.test.ts` | App embed live only post-approval | 17 |
| 10 | Order actions require it | `ORDER_ACTION` mapping; all writes | `shopify-capability-matrix.test.ts` "every mutation requires order_actions" | Run the action through approvals | 19 |
| 11 | OAuth alone grants nothing | `purpose: "data"` vs `"install"`; `grantsAccess` copied | `shopify-connector-state.test.ts` "OAuth alone is never 'active'" | Authorized-but-unpaid state | 9, 9b |
| 12 | URL params / browser state grant nothing | `presentConnector` takes only the snapshot | `shopify-connector-state.test.ts` "no state is inferred from the browser" | Append `?shopify=active`; nothing changes | — |
| 13 | Verification is server-side, not the return URL | `provider-subscription.service` changes entitlements only after `fetchSubscription()` | `shopify-billing-flow.integration.test.ts` | Active state appears only after verification | 13 |
| 14 | Cancellation removes Shopify, keeps Core | `revokeShopifyEntitlements` deletes only `SHOPIFY_SUBSCRIPTION` rows | `shopify-authorization.test.ts` "cancellation leaves Core alone" | Cancel; Core and WhatsApp keep working | 20 |
| 15 | Queued work re-checks at execution | approval dispatch re-enters `executeAdapterTool` → gated `loadConnection` | `shopify-connection-gate.test.ts` | Queue an action, cancel, execute | — |
| 16 | Unknown plan grants nothing new, revokes nothing | state `UNKNOWN_PLAN`; UI follows `grantsAccess` | `shopify-connector-state.test.ts` both combinations | Operator-only | — |
| 17 | Missing catalog must not mass-revoke | revocation only on confirmed non-paying status | `shopify-unknown-plan-and-boot.integration.test.ts` | Operator-only | — |
| 18 | Grandfather only for eligible pre-publication merchants | `shopify-grandfather.service`; cutoff required | existing billing suite | Confirm cutoff set before granting | — |
| 19 | No credential in errors, logs or metadata | `ShopifyConnectorRequiredError` carries no token/shop/sub id | `shopify-authorization.test.ts` "carries no credential…" | grep production logs post-deploy | — |
| 20 | Billing UI shows both subscriptions and their billers | Billing page Core card + `ShopifyConnectorSection` | `billing-core-and-connector.test.tsx` | Open Billing | 15, 20 |
| 21 | Connector management routes to Shopify | server-supplied URL only | `ShopifyConnectorSection.test.tsx` "never to GOTCHA checkout" | Click through to Shopify | 10 |
| 22 | Core upgrade uses GOTCHA billing, claims no Shopify | `/settings/billing/plan`; no Shopify URL on the page | `billing-core-and-connector.test.tsx` | Open the Core upgrade path | — |
| 23 | Non-embedded | `embedded = false`; top-level app | n/a | Dashboard row 1; URL bar in the recording | 4 |

## Cannot be proven until deployed

These are honest gaps. Nothing below is tested in CI, and none of it should be
claimed as verified in the submission.

1. **The end-to-end flow against real Shopify** — install, OAuth, claim, hosted
   pricing, approval, server-side verification, activation. Every part is
   unit-tested in isolation; the joined-up path has never run against production
   Shopify with the new enforcement.
2. **That a real merchant with a verified Connector keeps working.** Today
   production has **0 tenants with a Shopify entitlement**, so this has never
   been observed with enforcement on.
3. **That the one connected store is not locked out** — see
   `05-deployment-checklist.md` §2.
4. **Initial synchronization under enforcement** (timing, volume, partial sync).
5. **The storefront app embed** serving from the published theme extension with
   the entitlement gate live.
6. **Production log hygiene** (row 19) — asserted in tests, but only a real log
   sweep proves it for the real code path.
7. **Dashboard ↔ repository agreement** (all of `06-dashboard-checklist.md`).
8. **Screencast timings** — the shot numbers are placeholders until recorded.
9. **Real-page visual QA of the Billing screen — MANDATORY BEFORE RECORDING.**
   The screenshots use the real production CSS but render the section in
   isolation, not the running app. An attempt to run the app locally was
   abandoned deliberately: it would have depended on another team's checkout,
   containers, ports and `node_modules`, which breaks the isolation this work
   is required to keep. It needs either a dedicated environment or an agreed
   slot on the dev stack. Until then, layout, navigation, responsiveness,
   console cleanliness and live CTA behaviour are UNVERIFIED.
