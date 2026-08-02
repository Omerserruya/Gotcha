# Data Retention Policy

Internal document

This policy records how long GOTCHA, the operator of gotcha.co.il, retains each category of data, how that data is deleted, and where automation does not yet exist. It is written to reflect the platform as actually built. Where enforcement is manual, this document says so.

## General principles

1. There is no fixed default retention period on platform data. Data is retained for the life of the account unless a tenant-configured retention policy applies or an erasure request is executed.
2. Tenants may configure per-category retention policies (retention in days, per category). A purge routine hard-deletes records older than the configured cutoff and records an audit entry.
3. The purge routine is triggered manually through an internal endpoint. No cron job, scheduler, or worker invokes it automatically. Retention enforcement therefore depends on an operator running the purge. This is a known gap.
4. Only three categories are actually implemented in the purge engine: messages, usage_logs, and audit_logs. The policy API also accepts billing_webhook_events and reasoner_shadow_evals, but the purge engine has no logic for them; such policies are silently skipped and never enforced. This is a known gap.
5. All deletion on the platform is hard-delete. No anonymization or pseudonymization is applied.
6. Backups age out automatically: S3 lifecycle moves nightly dumps to Infrequent Access at 30 days and deletes them at 90 days; EBS snapshots are kept 7 days. Deleted production data leaves all backups within at most 90 days. Individual records cannot be selectively removed from existing backups.

## Retention table

| Data type | Retention period | Deletion mechanism | Automation notes |
|---|---|---|---|
| Staff users (accounts, profiles, consent records) | Life of the account | Admin-initiated user erasure endpoint (hard-delete, transaction; deletes unshared Authentik identity); tenant erasure cascade | Erasure is on-demand only; no automated expiry |
| Tenants (org record, settings, invites) | Life of the account | System-admin tenant erasure endpoint; database cascade deletes users, conversations, messages, contacts, channels | On-demand only |
| Conversations and messages (full content, contact records) | Life of the account, or tenant-configured "messages" policy | Contact erasure endpoint (hard-deletes messages, matched conversations, consent records, contact rows including merged contacts); tenant erasure cascade; retention purge for messages | Purge exists but is manually triggered; no scheduler runs it |
| AI context: usage logs | Life of the account, or tenant-configured "usage_logs" policy | Retention purge; tenant erasure | Usage logs store token counts and cost, not prompt/response text; purge manual |
| AI context: customer profiles, opportunities, intelligence facts, briefs | Life of the account | Tenant erasure cascade; contact erasure covers conversation-linked content | No per-category retention policy exists for these |
| Audit logs | Life of the account, or tenant-configured "audit_logs" policy | Retention purge; tenant erasure hard-deletes all audit rows | Purge manual; audit writer swallows write errors, so the log is not guaranteed complete |
| Billing records (profiles, subscriptions, invoices, charges, webhook events) | Life of the account; invoicing data at iCount is subject to statutory bookkeeping retention | Tenant erasure cascade for platform-side rows | billing_webhook_events policy is accepted by the API but never purged (no purge logic); known gap |
| Voice sessions and call analyses (session metadata, phone numbers, transcript frames, summaries, recording references) | Life of the account | Tenant erasure cascade | Recording audio resides with the tenant's Twilio account and must be deleted there; GOTCHA stores only the reference |
| Knowledge base and embeddings (documents, chunks, Qdrant vectors) | Life of the account or until the tenant deletes the content | Product-level deletion; tenant erasure triggers a Qdrant vector purge plus database cascade | Qdrant purge runs as part of tenant erasure via an internal endpoint |
| Uploads and media files (local uploads volume, including downloaded WhatsApp media) | Life of the account | Backed up nightly; no dedicated deletion path | Known gap: media files are NOT covered by the erasure cascade; erasure removes database references but the files remain on disk until manually removed |
| Notification logs (recipient, subject, body per email sent) | Life of the account | Tenant erasure cascade | No retention-policy category exists for notification logs |
| Waitlist entries (name, email, phone, company, notes) | Until manually removed | Manual deletion on request | No automated purge; GOTCHA is controller for this data |
| Backups (nightly DB dumps, Authentik dump, uploads tarball; EBS snapshots) | Dumps: 90 days maximum (IA at 30 days, delete at 90); snapshots: 7 days | S3 lifecycle rules and snapshot retention (automatic) | The only fully automated retention on the platform; no selective per-subject deletion from backups is possible |
| Redis (queues, cache, Authentik sessions) | Ephemeral | No persistence volume; not backed up | Contents are transient by design |

## Termination of a customer account

On termination, the tenant may export its data first (built-in export endpoints), after which tenant erasure hard-deletes the tenant and all dependent data. Backup copies age out automatically within at most 90 days after deletion.

## Legal hold

No legal hold or litigation hold mechanism exists on the platform. There is no model, flag, or exemption that prevents erasure or retention purges from deleting data. If GOTCHA receives a request or obligation requiring preservation of specific data, it is handled manually: the operator must refrain from running erasure or purge operations against the affected records, and must export the affected data before any deletion. This is an organizational control only; the system will not enforce it.

## Review

This policy is reviewed when the retention machinery changes, and at least annually. Priority follow-ups recorded here: schedule the retention purge automatically, implement purge logic for the accepted but unenforced categories, and bring uploaded media files under the erasure cascade.

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
