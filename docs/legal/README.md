# GOTCHA Legal & Privacy Documentation

This directory holds GOTCHA's legal and privacy documentation, generated from and verified
against the actual implementation of the platform (code, infrastructure, identity, security,
and GDPR machinery). Nothing in these documents describes a capability that does not exist in
the codebase; where a capability is missing, it is either omitted or listed in the
[compliance gap report](./compliance-gap-report.md).

Every document exists in English (`en/`) and Hebrew (`he/`), with the same information in both.

Effective date of the current set: July 18, 2026.

## The documents

| Document | Audience | Purpose |
|---|---|---|
| `privacy-policy.md` | Public | The primary disclosure document: who we are, what we collect (account, end-customer, technical, AI, files, voice, cookies), why, legal bases, sharing, subprocessors, international transfers, security, retention, rights, contact. Written to satisfy GDPR Art. 13/14 and the disclosure expectations of Google (including the Limited Use statement for Google user data), Meta Platform Terms, and Shopify Protected Customer Data requirements. |
| `terms-of-service.md` | Public / contractual | Service description, customer responsibilities, acceptable use, AI limitations, availability (no invented SLA), intellectual property, payments (iCount), suspension, termination and deletion, liability, governing law (Israel, Tel Aviv courts). |
| `cookie-policy.md` | Public | Honest cookie inventory: GOTCHA sets no cookies of its own; the self-hosted sign-in service sets strictly necessary session/CSRF cookies; there are no analytics or marketing cookies at all; browser localStorage usage is disclosed in a table. |
| `dpa.md` | Contractual (customers) | Data Processing Agreement: controller/processor roles, documented instructions, verified security measures, subprocessor authorization (by reference to `subprocessors.md`), DSR assistance, deletion/return at termination (including the 90-day backup expiry), breach notification commitment, audits, international transfers (Israel adequacy; OpenAI/US under provider terms). |
| `ropa.md` | Internal | Record of Processing Activities (GDPR Art. 30): ten processing activities, each with purpose, data categories, data subjects, legal basis, recipients, retention, storage, deletion path, and subprocessors. |
| `data-retention-policy.md` | Internal | Retention and deletion per data type (users, tenants, conversations, AI context, audit logs, billing, voice, knowledge base, embeddings, uploads, backups), including honest notes where automation is missing. States plainly that no legal-hold mechanism exists. |
| `data-subject-rights-procedure.md` | Internal | Operational procedure for access, export, correction, deletion, restriction, and portability requests: intake channels, mapping of each right to the platform's built-in admin tools, manual identity verification, one-month response target, escalation, and processor-redirect handling. |
| `subprocessors.md` | Public | The authoritative subprocessor list (provider, purpose, data, region), clearly separated from tenant-controlled integrations (which activate only when a customer connects them) and from self-hosted components (Authentik, Qdrant, Postgres, Redis) that are not subprocessors. |

## How the documents relate

- The privacy policy references the cookie policy and the subprocessor list; keep the three in
  sync when anything changes.
- The DPA incorporates `subprocessors.md` as its subprocessor annex and the Terms of Service as
  the parent agreement.
- `ropa.md`, `data-retention-policy.md`, and `data-subject-rights-procedure.md` are internal:
  do not publish them, but keep them current, since they are the evidence base for the public
  claims.

## Deployment notes

- The public pages currently served by the frontend (`frontend/src/app/privacy-policy/page.tsx`
  and `frontend/src/app/terms/page.tsx`) predate this set and contain placeholders and claims
  that contradict the implementation. They should be replaced with the content of
  `privacy-policy.md`, `terms-of-service.md`, and `cookie-policy.md` (see gap report, item 1).
- Google OAuth verification requires the privacy policy to be hosted on the app's verified
  domain and linked from the OAuth consent screen; Meta App Review and Shopify Protected
  Customer Data review both require a live privacy policy URL. Publish before submitting.

## Updating

When the implementation changes in a way that affects any statement here (a new subprocessor,
a new data category, a change to retention or backups, a new integration category), update the
affected documents in BOTH languages and bump the effective date. The subprocessor page must be
updated BEFORE a new subprocessor starts processing customer data, per the DPA notice
commitment.

Contact: privacy@gotcha.co.il
