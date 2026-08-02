# Compliance Gap Report

Internal document. Date: July 18, 2026.

This report lists the remaining implementation gaps that stand between GOTCHA and full GDPR
readiness, plus the operational items required by the Google, Meta, and Shopify review
programs. Every item below was verified against the codebase during the audit that produced
the documents in this directory; nothing here is speculative. Items are ordered by priority.
ISO 27001-style recommendations are excluded unless they directly improve GDPR compliance or
platform trust.

## P0: must fix before relying on the published documents

1. **The live public pages contradict the implementation and contain placeholders.**
   `frontend/src/app/privacy-policy/page.tsx` claims "securely hashed passwords" (GOTCHA stores
   none), promises 30/90-day deletion automation that does not exist, and the Hebrew version
   still contains a placeholder contact email. `frontend/src/app/terms/page.tsx` has
   `[Company Name]`, `[Jurisdiction]` and similar placeholders. Replace both pages with the
   content of `en/he privacy-policy.md`, `terms-of-service.md`, and `cookie-policy.md`, and add
   a public subprocessors page. Until then, the site overstates compliance.

2. **No legal entity identity anywhere.** The documents deliberately say only "GOTCHA, the
   operator of gotcha.co.il" because no registered company name, company number, or registered
   address exists in the repository or was provided. A privacy policy and ToS are legally
   incomplete without the controller's identity, and Google OAuth verification, Meta App
   Review, and Shopify all require identifying the developer entity. Provide the legal entity
   details and update the "Who we are" sections in both languages.

3. **Erasure does not delete uploaded media files.** User, contact, and tenant erasure
   hard-delete database rows and purge Qdrant vectors, but files in the local `uploads` volume
   (for example WhatsApp images and documents) are not removed; message rows referencing them
   are deleted while the files remain on disk and in the nightly uploads backup until
   overwritten. Implement file deletion in the erasure paths (delete files referenced by the
   erased messages/contacts/tenant) so Art. 17 erasure is complete.

4. **Retention purge never runs on its own.** `runRetentionPurge()` exists and works, but
   nothing schedules it: no cron, worker, or repeatable job invokes it, so tenant-configured
   retention policies have no effect unless someone calls the internal endpoint manually.
   Add a scheduled invocation (the BullMQ infrastructure already used elsewhere is sufficient).
   Related: the retention API accepts the categories `billing_webhook_events` and
   `reasoner_shadow_evals` but the purge engine silently skips them; either implement those
   categories or reject them at the API.

## P1: needed for defensible GDPR operations

5. **No default retention limits.** All conversation and platform data is retained indefinitely
   unless a tenant explicitly configures a policy. GDPR's storage-limitation principle expects
   defined limits. Decide and implement sensible defaults (or at minimum ship recommended
   policies during onboarding), especially for messages and audit logs.

6. **Consent is recorded only via admin API.** `ConsentRecord` exists, but there is no frontend
   surface that captures consent and no automatic recording of end-customer consent anywhere in
   the message flow. If any tenant relies on consent as a legal basis (for example marketing
   messages), the platform currently gives them no operational way to capture it at the point
   of interaction. Build a consent-capture path (or clearly scope the feature as an
   admin-recorded register).

7. **Access tokens live in browser localStorage.** Self-documented XSS exposure in
   `AuthContext`. The durable fix (backend-for-frontend with HttpOnly cookies) is already noted
   in the architecture docs. This is a real data-protection risk for account takeover and is
   the kind of finding platform reviews look for.

8. **No incident-response / breach-notification procedure.** The DPA now commits to notifying
   customers without undue delay (72 hours where feasible), but there is no internal runbook,
   no severity classification, and no tooling to identify affected tenants. Write the runbook
   and test it once; the DPA commitment is otherwise unbacked.

9. **Disk-level encryption at rest is unverified.** Postgres runs on a stock image with no
   database-level encryption, and the Terraform does not explicitly enable EBS volume
   encryption. Field-level AES-256-GCM covers credentials only, not message content. Enable
   EBS encryption (a one-line Terraform change on the volume) so the "encryption at rest"
   answer in security questionnaires becomes a yes; until then the documents deliberately do
   not claim it.

10. **User-level export omits authored content.** The user export returns profile fields,
    consent records, and a conversation count, but not message content authored by that user.
    For an Art. 15/20 request from a staff user, this is arguably incomplete. Extend the export
    or document the position (content belongs to the tenant's business records).

## P2: trust and review-program items

11. **DSR tracking is dead code.** `DataSubjectRequest.status` supports PENDING/FAILED and the
    `DSR_*_REQUESTED` audit actions exist, but everything completes synchronously and nothing
    tracks deadlines. A minimal request log with dates would let GOTCHA evidence the one-month
    commitment in the rights procedure.

12. **No audit-log viewer or export.** Audit logs are written but there is no admin-facing way
    to view or export them, so they cannot currently serve as customer-facing compliance
    evidence. A read endpoint plus CSV/JSON export would close this.

13. **Review-program operational prerequisites** (not code gaps, but required):
    - Google: publish the privacy policy on the verified domain, link it on the OAuth consent
      screen, and prepare for restricted-scope verification (the Gmail scopes
      `gmail.readonly`/`gmail.send`/`gmail.modify` are restricted and will require a security
      assessment; `drive.readonly` is sensitive). The Limited Use statement now exists in the
      privacy policy as required.
    - Meta: App Review requires the live privacy policy URL and demonstration of each
      permission in use; the permission list in the code (WhatsApp, Instagram, Messenger,
      pages) matches what the documents disclose.
    - Shopify: Protected Customer Data review requires declaring data use in the Partner
      Dashboard (already encountered in practice: order/customer access was blocked until PCD
      approval) plus the published privacy policy; the data-minimization language it expects
      is now in the privacy policy, section 7e.

14. **No legal hold.** Erasure and purges have no preservation override. Acceptable at current
    scale (the retention policy says preservation requests are handled manually), but any
    litigation or authority preservation order would require immediate manual intervention:
    document the manual procedure owner.

## Explicitly not recommended now

- ISO 27001 certification, SOC 2, formal DPO appointment, and EU representative designation
  are out of scope per the mission. Note only: if EEA-resident data subjects are targeted at
  scale, an Art. 27 EU representative may become required; revisit when EU customers sign.

Contact: privacy@gotcha.co.il
