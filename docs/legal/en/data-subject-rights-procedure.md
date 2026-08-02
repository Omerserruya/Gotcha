# Data Subject Rights Procedure

Internal document

This procedure describes how GOTCHA, the operator of gotcha.co.il, handles data subject rights requests (access, rectification, erasure, restriction, portability, objection, consent withdrawal). It reflects the capabilities actually built into the platform. There is no self-service data-subject portal: rights are fulfilled through the tenant administrator's built-in tools or by the operator acting on an email request. Identity verification is performed manually by the operator.

## 1. Roles

- For end-customer data (contacts, conversations, messages, AI-derived profiles), the tenant (our business customer) is the controller and GOTCHA is the processor. Requests from end-customers are redirected to the controller; GOTCHA assists the controller in fulfilling them.
- For platform account data (tenant staff users, waitlist entries, billing contacts), GOTCHA is the controller and handles the request directly.

## 2. Intake channels

1. Tenant administrator tools: tenant admins can execute export, erasure, and consent operations directly through the platform's built-in GDPR endpoints (admin-gated, tenant-scoped).
2. Email: privacy@gotcha.co.il. Any request arriving through support@gotcha.co.il or any other channel is forwarded to privacy@gotcha.co.il and handled under this procedure.

All requests received by email are logged internally with: date received, requester identity as claimed, right invoked, affected tenant, and resolution date.

## 3. Identity verification (manual)

The platform performs no automated data-subject identity verification; all built-in operations are admin-initiated. Before acting on an emailed request, the operator verifies identity manually:

- For platform account holders: the request must come from, or be confirmed through, the email address on the account. If in doubt, the operator asks the requester to confirm from that address or to reference account details only the holder would know.
- For end-customers: verification is performed through the controller. The operator asks the tenant to confirm that the requester is the data subject (for example by matching the phone number or email on the contact record).

No copies of identity documents are requested unless verification is otherwise impossible.

## 4. Mapping rights to built-in capabilities

| Right | How it is fulfilled |
|---|---|
| Access (Art. 15) and portability (Art. 20) | Built-in export endpoints. User export returns the user's profile fields, a count of assigned conversations, and consent records. Contact export is the richest: the contact, its full contact family, full conversations, full messages, and consent records. Tenant export (system admin) returns tenant metadata, users, contacts, counts, and consent records. Exports are JSON, which serves as the structured, machine-readable portable format. Note: user-level export contains counts, not message content; audit logs are not included in any export. |
| Erasure (Art. 17) | Built-in erasure endpoints, all hard-delete: user erasure (blocks self-erasure and system-admin erasure; removes the unshared Authentik identity), contact erasure (messages, conversations, consent records, contact rows including merged contacts), tenant erasure (full cascade plus Qdrant vector purge). Known limitation to disclose when relevant: uploaded media files are not deleted by the cascade and must be removed manually; backup copies age out within at most 90 days. |
| Rectification (Art. 16) | Profile editing by the user (account page) or admin edits to user and contact records. No dedicated rectification endpoint exists; standard editing surfaces are used. |
| Restriction (Art. 18) | Manual handling. No restriction flag exists in the system. The operator restricts processing organizationally (for example by deactivating the account or instructing the tenant to pause processing) and records the measure. |
| Objection (Art. 21) | Manual handling, assessed case by case by the operator. |
| Consent withdrawal | Consent endpoints record withdrawal as a new consent record with granted set to false; contact-level opt-out flags stop marketing on the relevant channels. Withdrawal is logged in the audit trail. |

## 5. Response time

We will respond without undue delay and in any case within one month of receiving the request. Where a request is complex or numerous, this may be extended by up to two further months per GDPR Art. 12(3); the requester is informed of any extension, with reasons, within the first month. These are organizational commitments kept by the operator; the system itself enforces no deadline (built-in operations execute immediately when an admin runs them, and there is no request queue or timer).

## 6. When GOTCHA is the processor

If a data subject contacts GOTCHA directly about data for which a tenant is the controller:

1. Acknowledge receipt and inform the data subject that their request concerns data controlled by the named business, and redirect them to that controller.
2. Notify the controller (the tenant admin) of the request without undue delay.
3. Assist the controller on request: run the relevant export or erasure through the built-in tools, or advise the admin on running them.
4. Do not act unilaterally on controller data except where the controller instructs it or the contract requires it.

## 7. Escalation

Requests that are ambiguous, contested, potentially unfounded or excessive, involve legal claims, or cannot be verified are escalated to the operator founder, who decides the response. Preservation requests are also escalated: no legal hold mechanism exists in the system, so preservation is handled manually (see the Data Retention Policy, ./data-retention-policy.md).

## 8. Record keeping

Completed export and erasure operations are recorded as data subject request rows and audit entries by the platform. Emailed requests and manual steps (verification, restriction measures, extensions, refusals with reasons) are recorded by the operator in the internal request log.

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
