# Data Retention Policy

Internal document

This policy records how long GOTCHA by Omer Serruya, the operator of gotcha.co.il, retains each category of data, how that data is deleted, and where automation does not yet exist. It is written to reflect the platform as actually built. Where enforcement is manual or incomplete, this document says so.

## General principles

1. There is no fixed default retention period applied to platform data in the current deployment. Data is retained for the life of the account unless a tenant-configured retention policy applies or an erasure request is executed. The purge engine does support platform-wide defaults through `RETENTION_DEFAULT_<CATEGORY>_DAYS` environment variables, applied in addition to tenant policies, but no such variable is set today, so no platform-wide default is in force.
2. Tenants may configure per-category retention policies (retention in days, per category). A purge routine hard-deletes records older than the configured cutoff and records an audit entry.
3. The purge routine runs automatically. It is registered as a repeatable BullMQ job by `startRetentionScheduler` in the AI service, on the `RETENTION_PURGE_CRON` schedule (default `30 3 * * *`, daily at 03:30). It is enabled by default and must be switched off explicitly with `RETENTION_PURGE_ENABLED=false`. The internal endpoint remains available for running a purge on demand. Retention enforcement therefore no longer depends on an operator remembering to run it.
4. All five categories the policy API accepts are implemented in the purge engine: messages, usage_logs, audit_logs, billing_webhook_events, and reasoner_shadow_evals. An unrecognized category raises rather than being skipped, so a policy can no longer be accepted and then silently ignored.
5. All deletion on the platform is hard-delete. No anonymization or pseudonymization is applied.
6. Backups age out automatically: S3 lifecycle moves nightly dumps to Infrequent Access at 30 days and deletes them at 90 days; EBS snapshots are kept 7 days. Deleted production data leaves all backups within at most 90 days. Individual records cannot be selectively removed from existing backups.

## Retention table

| Data type | Retention period | Deletion mechanism | Automation notes |
|---|---|---|---|
| Staff users (accounts, profiles, consent records) | Life of the account | Admin-initiated user erasure endpoint (hard-delete, transaction; deletes unshared Authentik identity); tenant erasure cascade | Erasure is on-demand only; no automated expiry |
| Tenants (org record, settings, invites) | Life of the account | System-admin tenant erasure endpoint; database cascade deletes users, conversations, messages, contacts, channels | On-demand only |
| Conversations and messages (full content, contact records) | Life of the account, or tenant-configured "messages" policy | Contact erasure endpoint (hard-deletes messages, matched conversations, consent records, contact rows including merged contacts); tenant erasure cascade; retention purge for messages | Purge runs on the daily scheduler |
| AI context: usage logs | Life of the account, or tenant-configured "usage_logs" policy | Retention purge; tenant erasure | Usage logs store token counts and cost, not prompt/response text; purge runs on the daily scheduler |
| AI context: customer profiles, opportunities, intelligence facts, briefs | Life of the account | Tenant erasure cascade; contact erasure covers conversation-linked content | No per-category retention policy exists for these |
| Audit logs | Life of the account, or tenant-configured "audit_logs" policy | Retention purge; tenant erasure hard-deletes all audit rows | Purge runs on the daily scheduler. Open caveat: writeAudit catches and logs write failures rather than throwing (deliberate, so auditing cannot break business logic), so the log is not guaranteed complete |
| Billing records (profiles, subscriptions, invoices, charges, webhook events) | Life of the account; invoicing data at iCount is subject to statutory bookkeeping retention | Tenant erasure cascade for platform-side rows | billing_webhook_events is now implemented in the purge engine and enforced on the daily scheduler |
| Voice sessions and call analyses (session metadata, phone numbers, transcript frames, summaries, recording references) | Life of the account | Tenant erasure cascade | Recording audio resides with the tenant's Twilio account and must be deleted there; GOTCHA stores only the reference |
| Knowledge base and embeddings (documents, chunks, Qdrant vectors) | Life of the account or until the tenant deletes the content | Product-level deletion; tenant erasure triggers a Qdrant vector purge plus database cascade | Qdrant purge runs as part of tenant erasure via an internal endpoint |
| Uploads and media files (local uploads volume, including downloaded WhatsApp media) | Life of the account | Backed up nightly; no dedicated deletion path | Known gap: media files are NOT covered by the erasure cascade; erasure removes database references but the files remain on disk until manually removed |
| Notification logs (recipient, subject, body per email sent) | Life of the account | Tenant erasure cascade | No retention-policy category exists for notification logs |
| Waitlist entries (name, email, phone, company, notes) | Until manually removed | Manual deletion on request | No automated purge; GOTCHA is controller for this data |
| Backups (nightly DB dumps, Authentik dump, uploads tarball; EBS snapshots) | Dumps: 90 days maximum (IA at 30 days, delete at 90); snapshots: 7 days | S3 lifecycle rules and snapshot retention (automatic) | Fully automated, alongside the scheduled retention purge; no selective per-subject deletion from backups is possible |
| Redis (queues, cache, Authentik sessions) | Ephemeral | No persistence volume; not backed up | Contents are transient by design |

## Termination of a customer account

On termination, the tenant may export its data first (built-in export endpoints), after which tenant erasure hard-deletes the tenant and all dependent data. Backup copies age out automatically within at most 90 days after deletion.

## Legal hold

No legal hold or litigation hold mechanism exists on the platform. There is no model, flag, or exemption that prevents erasure or retention purges from deleting data. If GOTCHA receives a request or obligation requiring preservation of specific data, it is handled manually: the operator must refrain from running erasure or purge operations against the affected records, and must export the affected data before any deletion. This is an organizational control only; the system will not enforce it.

## Review

This policy is reviewed when the retention machinery changes, and at least annually. Follow-ups previously recorded here are now closed: the retention purge is scheduled automatically, and every category the policy API accepts is implemented in the purge engine. One priority follow-up remains open: bring uploaded media files under the erasure cascade, so that erasing a tenant or a contact removes the stored files and not only the database references.

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
