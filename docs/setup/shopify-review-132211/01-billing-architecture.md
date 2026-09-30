# Billing architecture (paste at the top of Test Instructions)

> Copy the block below verbatim into the **Test Instructions** field. It is
> written for a reviewer reading it cold, states the model as implemented, and
> asks for nothing.

---

**GOTCHA Core and the Shopify Connector are two separate subscriptions. They can
be held at the same time and are not alternatives to each other.**

**GOTCHA Core** is a standalone customer-service and AI platform, billed
directly by GOTCHA. It operates independently of Shopify: communication
channels (WhatsApp, Instagram, Messenger, email, voice, web chat), AI and human
agents, the shared Inbox, automations, approvals, analytics, manually managed
knowledge, and supported non-Shopify integrations such as WooCommerce. A
merchant can use GOTCHA Core with no online store at all.

**GOTCHA Core does not provide Shopify connectivity or access to Shopify data.**
No Core plan, at any tier, includes it.

**The Shopify Connector** is a separate subscription, **billed and managed by
Shopify** through Shopify App Pricing. It is required for every Shopify-specific
capability: connecting a Shopify store, Shopify catalogue, product and inventory
data, Shopify customers and orders, Shopify-derived context shown in the Inbox
or used by AI agents, Shopify order actions and writebacks, synchronization, and
the storefront app embed.

**Enforcement is server-side and happens at execution time, not in the UI.**
Every Shopify API call, synchronization job, Shopify-derived context read,
Shopify action and storefront feature is checked against an entitlement that
only an active Shopify-funded subscription can grant. The check runs at the
moment the operation executes, so queued and deferred work is re-checked then
rather than trusting the state it was queued under.

**The following cannot grant Shopify access, by construction:** completing
OAuth, holding valid Shopify credentials, the existence of a store connection,
any URL or query parameter, any browser state, and any GOTCHA Core plan,
tier or paid status.

**Cancelling the Connector removes Shopify access and nothing else.** GOTCHA
Core, the communication channels and non-Shopify integrations keep working, and
the merchant's data is untouched.

**No billing exemption is being requested.** Every Shopify-specific capability
is paid for through Shopify App Pricing. This section describes the app as
implemented and asks for nothing.

*Context only: App Review submission 132211, and Shopify Support ticket
69897769.*

---

## Notes for whoever pastes this

- Do **not** add a request for an exemption. None is being sought; this
  describes what the app does.
- The paragraph about pre-publication grandfather grants was REMOVED on
  2026-09-30. Production has grandfathering switched off
  (`SHOPIFY_ALLOW_GRANDFATHERED=false`), an empty publication cutoff, zero
  grants and zero grandfathered entitlements, so it described a mechanism that
  does not operate. Describing a way merchants might hold Shopify access
  without paying Shopify is the 1.2.1 finding restated, and it is not true of
  this app. Do not put it back unless a grant actually exists.
- Do **not** soften "does not provide Shopify connectivity". It is the single
  sentence that answers the 1.2.1 finding.
- Keep the two paragraphs about what cannot grant access. They are the part a
  reviewer can verify by trying it.
