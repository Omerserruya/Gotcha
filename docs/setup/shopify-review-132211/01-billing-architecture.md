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

**Pre-publication customers.** A small number of merchants who subscribed before
publication may hold an explicit, auditable grandfather grant, consistent with
the policy guidance Shopify Support previously confirmed. A grant is a recorded
entitlement with a date and a reason; it is never inferred from acquisition
source, installation date or plan.

*Context only: App Review submission 132211, and Shopify Support ticket
69897769.*

---

## Notes for whoever pastes this

- Do **not** add a request for an exemption. None is being sought; this
  describes what the app does.
- Do **not** soften "does not provide Shopify connectivity". It is the single
  sentence that answers the 1.2.1 finding.
- Keep the two paragraphs about what cannot grant access. They are the part a
  reviewer can verify by trying it.
