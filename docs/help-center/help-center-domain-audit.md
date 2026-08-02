# Help Center audit

Source: `frontend/src/app/help/content/*.ts` — 22 articles across 7 categories,
each bilingual (English, Hebrew). Served at `/help`, published as
`help.gotcha.co.il`.

**Not published.** Changes are prepared in the repository and need approval.

## Domain findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `HelpKit.tsx:196` — the **public** Help Center's login button pointed at `https://dev.gotcha.co.il/login`. Every visitor who clicked it was sent to an environment they have no account on. | **high** | fixed |
| 2 | Article bodies contain no hardcoded application URLs. | — | verified by test |
| 3 | No article referenced a non-production host. | — | verified by test |

Finding 1 was in the Help Center **chrome**, not article text, which is why a
content review would not have caught it.

## Article verification matrix

Verified against the actual route or UI, not by text search. "Impl verified"
means the described flow was checked against the code that implements it.

| # | Article | Route / feature | Impl verified | Status | Action |
|---|---|---|---|---|---|
| 1 | getting-started / what-is-gotcha | conceptual | n/a | CURRENT | — |
| 2 | getting-started / onboarding-walkthrough | `/setup` | partial | **UPDATE** | en-dashes fixed; screenshots stale |
| 3 | getting-started / first-day-checklist | `/getting-started` | partial | CURRENT | — |
| 4 | getting-started / sign-in | Authentik at `auth.gotcha.co.il` | **no** | **UPDATE REQUIRED** | must state the app is `app.gotcha.co.il` and login is on `auth.` |
| 5 | channels / connect-whatsapp-waba | Meta embedded signup | **no** | **UPDATE REQUIRED** | callback host changes; screenshots stale |
| 6 | channels / connect-instagram | Instagram login | **no** | **UPDATE REQUIRED** | as above |
| 7 | channels / connect-messenger | Messenger | **no** | **UPDATE REQUIRED** | as above |
| 8 | channels / connect-email | Gmail/Outlook OAuth | **no** | **UPDATE REQUIRED** | redirect URI host changes |
| 9 | integrations / source-of-truth | Settings → Integrations | yes | CURRENT | — |
| 10 | integrations / connect-fireberry | API-token connector | yes | CURRENT | — |
| 11 | integrations / connect-airtable | OAuth2 + PKCE | partial | **UPDATE** | redirect URI host; verify PKCE re-registration |
| 12 | **integrations / connect-shopify** | Settings → Integrations | **yes** | **REWRITTEN** | see below |
| 13 | knowledge / teach-from-website | KB ingest | partial | CURRENT | — |
| 14 | knowledge / upload-files | KB upload | partial | CURRENT | — |
| 15 | knowledge / google-drive-sync | Google OAuth | **no** | **UPDATE REQUIRED** | redirect URI host changes |
| 16 | ai-employees / what-they-do | AI Studio | partial | CURRENT | — |
| 17 | ai-employees / tune-your-employee | AI Studio | partial | CURRENT | — |
| 18 | ai-employees / approvals-handoff | HITL approvals | partial | **UPDATE** | should state approval links now land on `app.` |
| 19 | billing / how-credits-work | Settings → Billing | partial | CURRENT | — |
| 20 | billing / usage-alerts | Settings → Billing | partial | CURRENT | — |
| 21 | billing / plans-topups-pilots | Settings → Billing | partial | CURRENT | — |
| 22 | account / invite-team | invitation flow | **no** | **UPDATE REQUIRED** | invitation links now `app.`; this is the flow that was mailing localhost |
| 23 | account / security-privacy | MFA, data rights | partial | **UPDATE** | MFA lives on `auth.` |

**MISSING** articles, worth adding but not blocking this migration:

- how to reconnect a Shopify store, and what reconnecting does and does not change
- integration connection health: what "connected but no tools" means
- what happens when a tool is disabled, from the customer's side

**REMOVE**: none. **DUPLICATE**: none.

## The Shopify article was materially wrong

The previous version described **reads only**: order lookup, product questions,
customer recognition. It said nothing about actions, nothing about approvals,
nothing about reconnecting, and nothing about limitations.

That is not merely incomplete. A merchant reading it would reasonably conclude
the AI cannot cancel an order (it can, with approval), and would have no way to
know that coupons are unsupported, or that reconnecting does not re-enable a
tool they switched off. Both are the kind of thing discovered mid-conversation
with a customer.

Rewritten to state, in both languages:

- what the AI answers, and what it can **do** when allowed
- that money-moving and irreversible actions wait for a human, and that the
  customer is told what actually happened afterwards
- when a reconnect is needed, and that **tools switched off stay off**
- that connection health is visible, and a green connection alone does not mean
  the AI can act
- the unsupported list: customer coupons, tax invoices without an invoicing
  provider, address changes after fulfillment, exchange-after-fulfillment going
  through a return, returns depending on provider capability, a disconnected
  store doing nothing, disabled tools staying disabled
- troubleshooting for the three things that actually happen

Every claim is traceable to the readiness work in
`docs/qa/shopify-customer-readiness-2026-07-31.md`.

## Screenshots requiring replacement

None can be verified from the repository — they are external assets. Every
screenshot showing a browser address bar, an OAuth consent screen, or a provider
dashboard callback field will show the old host.

| Article | What the screenshot shows | Why it is stale |
|---|---|---|
| getting-started / onboarding-walkthrough | `/setup` wizard | address bar |
| getting-started / sign-in | login screen | address bar; `auth.` vs `app.` |
| channels / connect-whatsapp-waba | Meta embedded signup | consent screen shows callback host |
| channels / connect-instagram | Instagram login | as above |
| channels / connect-messenger | Messenger setup | as above |
| channels / connect-email | Google/Microsoft consent | consent screen names the redirect host |
| integrations / connect-shopify | Shopify install approval | install screen shows the app URL |
| integrations / connect-airtable | Airtable OAuth consent | as above |
| knowledge / google-drive-sync | Google consent | as above |
| account / invite-team | invitation email | the link in the email |

Re-shoot **after** the cutover, against `app.gotcha.co.il`, or they will
document a state that no longer exists.

## Automated checks

`frontend/src/app/help/__tests__/help-content.test.ts` — 9 tests:

- no non-production hostname in any article
- no application path on the marketing host
- no localhost URL
- the Shopify article exists in both languages, and the Hebrew is actually Hebrew
- it states that actions wait for a human
- it states that disabled tools stay disabled after reconnect
- it names the unsupported capabilities
- it does not promise coupon creation
- no em-dash or en-dash in customer-facing copy

The last one caught four pre-existing violations in
`getting-started.ts` (`30–60 seconds`, `## 6–7`), now fixed.

## Publish checklist

1. [ ] Review the rewritten Shopify article for factual accuracy against the product
2. [ ] Review the Hebrew translation with a native speaker
3. [ ] Update the eight articles marked UPDATE REQUIRED with the new hosts
4. [ ] Re-shoot the ten screenshots **after** cutover
5. [ ] Run `npx vitest run frontend/src/app/help/__tests__/help-content.test.ts`
6. [ ] Run `npm run check:domains`
7. [ ] Verify `help.gotcha.co.il` serves the built content
8. [ ] Verify the login button lands on `app.gotcha.co.il/login`
9. [ ] Obtain approval to publish
