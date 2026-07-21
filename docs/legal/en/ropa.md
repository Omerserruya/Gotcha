# Record of Processing Activities (RoPA)

Internal document

This record is maintained by GOTCHA, the operator of gotcha.co.il, in the spirit of Article 30 GDPR. It describes the ten processing activities carried out on the GOTCHA platform. GOTCHA acts as data controller for platform account data (tenant staff users, waitlist entries, billing contacts) and as data processor for the end-customer data of its business customers (tenants), who are the controllers of that data.

Shared infrastructure facts that apply to every activity below:

- Primary storage: PostgreSQL database and a local uploads volume on GOTCHA-managed infrastructure in AWS region il-central-1 (Israel). Vector data is stored in a self-hosted Qdrant instance in the same environment.
- Cloudflare sits in front of the platform for DNS, TLS termination, and DDoS protection; it handles traffic metadata and content in transit at its global edge.
- Backups: nightly database dumps and an uploads tarball to S3 in the same AWS account, moved to Infrequent Access at 30 days and deleted at 90 days; EBS snapshots kept 7 days. Deleted production data therefore leaves backups within at most 90 days. There is no mechanism to delete individual records from backups before they age out.
- Erasure everywhere is hard-delete. No anonymization or pseudonymization is applied on erasure.
- Retention purges (where a per-tenant retention policy exists) are executed by a purge routine that is triggered manually through an internal endpoint. No scheduler currently invokes it automatically.

## Activity 1: Platform account management

- Purpose: creating and administering tenant workspaces and staff user accounts, invitations, role assignment, MFA policy enforcement, account settings.
- Data categories: staff user email, name, phone number, role, locale, identity-provider subject reference, MFA enrollment timestamp; tenant name and settings; invite tokens and invitee emails.
- Data subjects: tenant staff users (agents, admins), invitees.
- Legal basis: performance of contract with the tenant (Art. 6(1)(b)).
- Recipients: none outside GOTCHA infrastructure. Authentication credentials (passwords, MFA secrets, sessions) are held exclusively by the self-hosted Authentik identity service on GOTCHA infrastructure; the GOTCHA application stores no passwords.
- Retention: life of the account. No fixed default retention period.
- Storage location: PostgreSQL in AWS il-central-1; Authentik has its own PostgreSQL database on the same infrastructure.
- Deletion path: admin-initiated user erasure endpoint (hard-deletes the user row and consent records; also deletes the Authentik identity where it is not shared across tenants); tenant erasure cascade deletes all users of a tenant.
- Subprocessors: AWS (hosting), Cloudflare (transit).

## Activity 2: End-customer conversation processing

- Purpose: providing the shared team inbox: receiving, storing, and sending messages across connected channels; maintaining contact records and cross-channel identity links.
- Data categories: contact identifiers (phone number, email, platform-scoped IDs), display names, avatars, tags, custom metadata, opt-out flags; full message content including media references; conversation metadata and AI summaries; customer profiles, opportunities, intelligence facts (including verbatim evidence snippets), behavioral briefs.
- Data subjects: end-customers of tenants (the tenants' customers and prospects).
- Legal basis: GOTCHA processes as processor on the documented instructions of the tenant (controller). The tenant is responsible for its own legal basis toward its end-customers.
- Recipients: the tenant's connected messaging channels and integrations (Meta WhatsApp/Instagram/Messenger, email, Slack, CRMs, and similar), only where the tenant has connected them.
- Retention: life of the account, unless the tenant configures a retention policy for the "messages" category; such policies are enforced by the manually triggered purge routine (see shared facts above).
- Storage location: PostgreSQL in AWS il-central-1. Inbound WhatsApp media files are downloaded and stored on a local uploads volume on the same host; Messenger/Instagram media is referenced by URL, not downloaded.
- Deletion path: admin-initiated contact erasure endpoint (hard-deletes messages, matched conversations, consent records, and contact rows including merged contacts, in a transaction); tenant erasure cascade. Known gap: uploaded media files on the uploads volume are not covered by the erasure cascade; the database references are deleted but the files themselves require manual removal.
- Subprocessors: AWS, Cloudflare.

## Activity 3: AI reply and summarization processing (OpenAI)

- Purpose: generating AI assistant replies, agent-assist suggestions, conversation summaries, and reasoning over conversations; onboarding chat over the tenant's business profile.
- Data categories: conversation text needed for the reply or summary; business-profile and website text during onboarding; AI usage logs recording model, feature, token counts, and cost (usage logs do not store prompt or response text).
- Data subjects: end-customers of tenants; tenant staff users.
- Legal basis: processor on tenant instructions for end-customer content; performance of contract for tenant-facing features.
- Recipients: OpenAI (United States), the sole AI provider, for chat completions and embeddings. No audio is sent to OpenAI.
- Retention: usage logs retained for the life of the account, unless the tenant configures a "usage_logs" retention policy (manually triggered purge). AI-derived artifacts (summaries, briefs, facts) follow the conversation data lifecycle.
- Storage location: PostgreSQL in AWS il-central-1; transient processing at OpenAI in the United States under OpenAI's data processing terms.
- Deletion path: tenant erasure deletes usage logs and AI-derived records; contact erasure deletes conversation-level content.
- Subprocessors: OpenAI, AWS, Cloudflare.

## Activity 4: Knowledge-base indexing and embeddings

- Purpose: indexing tenant knowledge content so AI assistants can answer from it (retrieval-augmented generation).
- Data categories: knowledge documents and chunk text (may contain personal data if the tenant uploads it); embedding vectors derived from that text; encrypted integration credentials for connected sources.
- Data subjects: whoever appears in the tenant's knowledge content (typically none, but tenant-determined).
- Legal basis: processor on tenant instructions.
- Recipients: OpenAI (embeddings generation, United States). Source content may be pulled from tenant-connected Google Drive or Confluence, under the tenant's instruction.
- Retention: life of the account or until the tenant deletes the knowledge base or document.
- Storage location: document and chunk text in PostgreSQL; vectors in self-hosted Qdrant; both in AWS il-central-1. Uploaded knowledge files are parsed in memory and not persisted as raw files.
- Deletion path: knowledge deletion through the product; tenant erasure triggers a Qdrant vector purge for the tenant plus the database cascade.
- Subprocessors: OpenAI, AWS, Cloudflare.

## Activity 5: Voice call handling and analysis

- Purpose: handling inbound/outbound voice calls on the tenant's own Twilio account, live transcription-derived assistance, and post-call analysis.
- Data categories: caller and agent phone numbers, call session metadata and state, transcript-derived state frames and rolling/final summaries, recording URL references and recording status, encrypted per-tenant Twilio credentials.
- Data subjects: end-customers and tenant staff on calls.
- Legal basis: processor on tenant instructions. The tenant is responsible for call-recording consent obligations.
- Recipients: Twilio (the tenant's own account; tenant-controlled). Call recordings, when enabled, reside with Twilio; GOTCHA stores the recording reference and analysis output, not the audio file. Optional speech-to-text: Deepgram (United States) or Google Cloud Speech, only if the tenant's voice channel is configured to use one; the default configuration sends call audio to no STT provider.
- Retention: life of the account.
- Storage location: PostgreSQL in AWS il-central-1; live transcript reordering happens in memory only.
- Deletion path: tenant erasure cascade. Recordings held by Twilio must be deleted in the tenant's Twilio account.
- Subprocessors: Deepgram or Google Cloud Speech only where configured; AWS, Cloudflare. Twilio is tenant-controlled, not a GOTCHA subprocessor.

## Activity 6: Billing and invoicing (iCount)

- Purpose: charging for the service, issuing Israeli tax invoices, managing subscriptions, entitlements, and AI-unit balances.
- Data categories: billing contact details, payment method metadata (tokenized cards; GOTCHA never stores full card numbers), subscriptions, invoices, charges, billing webhook events.
- Data subjects: billing contacts of tenants.
- Legal basis: performance of contract; legal obligation (tax and accounting records).
- Recipients: iCount (Israel), the payment and invoicing provider.
- Retention: life of the account. Note: the retention-policy API accepts a "billing_webhook_events" category, but the purge engine has no logic for it, so such policies are silently skipped and those records are never purged automatically.
- Storage location: PostgreSQL in AWS il-central-1; payment tokens held by iCount.
- Deletion path: tenant erasure cascade for platform-side records. Invoicing records at iCount are subject to statutory bookkeeping retention.
- Subprocessors: iCount, AWS, Cloudflare.

## Activity 7: Transactional email

- Purpose: sending operational emails: waitlist welcome, onboarding and setup links, team invites, activation confirmations, email-change verification, lifecycle nudges, internal integration-request alerts.
- Data categories: recipient email address, email subject and body; a notification log row storing recipient, subject, body, and type per send.
- Data subjects: tenant staff users, invitees, waitlist subscribers.
- Legal basis: performance of contract; legitimate interest for operational notices.
- Recipients: the configured SMTP provider (currently Gmail/Google Workspace by default). Password-recovery emails are sent by the self-hosted Authentik email stage through the same SMTP path.
- Retention: notification logs retained for the life of the account; no dedicated purge category exists for them.
- Storage location: PostgreSQL in AWS il-central-1; delivery through the SMTP provider (Google, global).
- Deletion path: tenant erasure cascade.
- Subprocessors: the email delivery provider (SMTP; currently Gmail/Google Workspace), AWS, Cloudflare.

## Activity 8: Waitlist and lead intake

- Purpose: capturing interest from the public waitlist form and alerting the GOTCHA team of new signups.
- Data categories: first name, email, phone, company, role, company size, free-text frustration/notes, lead score.
- Data subjects: waitlist subscribers (prospective customers). GOTCHA is the controller.
- Legal basis: consent (submitting the form) and legitimate interest in following up on expressed interest.
- Recipients: Telegram is used only for GOTCHA's own internal operational alerts on new waitlist signups; the alert carries the lead's name and contact details from the public waitlist form. It is not used for tenant-level customer data processing.
- Retention: no fixed period is currently enforced; entries are kept until manually removed.
- Storage location: PostgreSQL in AWS il-central-1.
- Deletion path: manual deletion on request to privacy@gotcha.co.il; no automated purge exists for waitlist entries.
- Subprocessors: Telegram (internal alert scope only), the email delivery provider (welcome email), AWS, Cloudflare.

## Activity 9: Security and audit logging

- Purpose: recording administrative and security-relevant actions (user lifecycle, role and credential changes, GDPR actions, consent grants and withdrawals, retention purges) for accountability and incident investigation.
- Data categories: acting user reference, action type, tenant, timestamp, action metadata (which may contain content fragments).
- Data subjects: tenant staff users; occasionally end-customers where actions concern their records.
- Legal basis: legitimate interest in security and accountability; support for legal obligations.
- Recipients: none external. Note: there is currently no admin-facing viewer or export endpoint for audit logs, and audit logs are not included in GDPR exports. The audit writer is fail-safe: write errors are swallowed, so gaps are possible and silent.
- Retention: life of the account, unless the tenant configures an "audit_logs" retention policy (manually triggered purge).
- Storage location: PostgreSQL in AWS il-central-1.
- Deletion path: tenant erasure hard-deletes all audit rows of the tenant; per-policy purge where configured and manually run.
- Subprocessors: AWS, Cloudflare.

## Activity 10: Backups and disaster recovery

- Purpose: recovering the platform after data loss or infrastructure failure.
- Data categories: full logical dumps of the application database and the Authentik database, and a tarball of the uploads volume; effectively all platform data.
- Data subjects: all of the above.
- Legal basis: legitimate interest in service continuity; support for contractual obligations.
- Recipients: none external; backups stay in GOTCHA's AWS account.
- Retention: nightly dumps to S3, encrypted in transit; S3 lifecycle moves objects to Infrequent Access at 30 days and deletes them at 90 days; daily EBS snapshots kept 7 days. Redis is ephemeral (queues and cache) and is not backed up.
- Storage location: S3 and EBS in AWS il-central-1.
- Deletion path: automatic expiry through the S3 lifecycle and snapshot retention. There is no capability to selectively remove an individual data subject's records from existing backups; erased production data leaves backups within at most 90 days. No backup-purge code exists beyond the lifecycle rules.
- Subprocessors: AWS.

## Known gaps (recorded for internal follow-up)

1. Retention purge is manual: no scheduler triggers the purge routine; enforcement depends on an operator running it.
2. No default retention: data grows unbounded unless a tenant explicitly creates a policy, and only the messages, usage_logs, and audit_logs categories are actually purged.
3. No legal hold mechanism exists; erasure and purges have no hold exemption.
4. Uploaded media files are not deleted by the erasure cascade.
5. Data-subject identity verification is manual and operator-performed; there is no self-service data-subject portal.

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
