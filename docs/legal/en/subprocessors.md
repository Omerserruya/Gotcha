# Subprocessors

GOTCHA, the operator of gotcha.co.il, uses a small number of third-party service providers (subprocessors) to deliver the platform. A subprocessor is a provider that GOTCHA itself engages and that may process customer personal data on GOTCHA's behalf as part of running the service. This page lists all of them.

We keep this page up to date. When we add or replace a subprocessor, we update this page before the change takes effect. To receive notice of changes by email, write to privacy@gotcha.co.il and ask to be added to the subprocessor notification list.

## Subprocessor list

| Provider | Purpose | Data | Region |
|---|---|---|---|
| Amazon Web Services (AWS) | Hosting, storage, backups | All platform data | il-central-1 (Israel) |
| Cloudflare | DNS, TLS, DDoS protection, network tunnel | Traffic metadata; content in transit | Global edge |
| OpenAI | AI text generation and embeddings | Conversation text, knowledge-base text, business profile text | United States |
| iCount | Payment processing and invoicing | Billing contact details, payment metadata (tokenized cards) | Israel |
| Email delivery provider (SMTP; currently Gmail/Google Workspace) | Transactional email | Recipient address, email content | Global (Google) |
| Deepgram (optional, only if configured for a tenant's voice channel) | Speech-to-text | Call audio | United States |
| Google Cloud Speech (optional, same) | Speech-to-text | Call audio | Per Google Cloud config |

Notes:

- OpenAI is the only AI provider. Content sent to it is the conversation text needed for the reply or summary, knowledge-base text for embeddings, and business-profile text during onboarding. No audio is sent to OpenAI.
- Deepgram and Google Cloud Speech are optional: they process call audio only if the voice channel is enabled for a tenant and that specific provider is configured for it. In the default configuration, call audio is sent to no speech-to-text provider.
- Telegram is used only for GOTCHA's own internal operational alerts about new waitlist signups. Those alerts carry the lead's name and contact details from the public waitlist form. Telegram is not used for customer data processing at the tenant level.

## Tenant-controlled integrations

The following services are not subprocessors chosen by GOTCHA. They are integrations that each customer may choose to connect, and data flows to or from them only when, and only because, the customer connects them. They act as data sources and recipients under the customer's instruction:

- Messaging channels: Meta WhatsApp Cloud API, Instagram, Facebook Messenger; Microsoft Outlook (email); Gmail (email channel); Slack.
- CRM and commerce connectors: HubSpot, Salesforce, Zoho CRM, monday, Fireberry, Airtable, Shopify, WooCommerce, Stripe, PayPal, ReturnGo, plus customer-provided databases (Postgres, MongoDB, AWS RDS) and custom APIs.
- Scheduling: Google Calendar, Calendly.
- Knowledge sources: Google Drive, Confluence.
- Voice telephony: Twilio, using the customer's own Twilio account and credentials. Call recordings, when enabled, reside with Twilio.

Each of these providers processes data under its own terms and the customer's own agreement with it. Customers should review those terms before connecting an integration.

## Self-hosted components

Some components that would often be third-party services are self-hosted on GOTCHA's own infrastructure and are therefore not subprocessors: Authentik (identity and sign-in, including passwords, MFA, and sessions), Qdrant (vector search for knowledge-base retrieval), PostgreSQL (databases), and Redis (queues and cache). Data in these components does not leave GOTCHA-managed infrastructure in AWS il-central-1.

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
