/**
 * Shared audit-logging primitive.
 *
 * ONE implementation for every service (auth, conversation, ai, billing, …) so
 * audit coverage is consistent and no service re-invents a divergent shape.
 * Writes to the `AuditLog` model. FAIL-SAFE: never throws - a logging miss must
 * never break the business operation it is recording.
 *
 * Records WHO (actor) did WHAT (action) to WHICH thing (target), per tenant.
 * This is distinct from usage/billing metering - it is the security &
 * compliance trail (ISO 27001 A.8.15, GDPR Art. 30 accountability).
 *
 * The `AuditAction` catalog below is the canonical list of security-relevant
 * events the platform mandates coverage for (user/tenant lifecycle, role &
 * permission changes, credential changes, invites, auth/MFA events, and the
 * GDPR data-subject actions). Use a catalog constant rather than a free string
 * so dashboards/alerts can key off a stable vocabulary.
 */

import { prisma } from "./prisma";

export type AuditActorType = "user" | "ai" | "system";

export interface AuditEventInput {
  tenantId: string;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, any> | null;
  /** Override the timestamp (defaults to now). */
  at?: Date;
}

/**
 * Canonical security-relevant audit actions. Extend this list rather than
 * inventing ad-hoc strings so monitoring can rely on a stable vocabulary.
 */
export const AuditAction = {
  // ── User lifecycle ──
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DELETED: "user.deleted",
  USER_ACTIVATED: "user.activated",
  USER_DEACTIVATED: "user.deactivated",
  // A multi-tenant identity switched its ACTIVE workspace.
  TENANT_SWITCHED: "user.tenant_switched",
  // ── Tenant lifecycle ──
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_DELETED: "tenant.deleted",
  TENANT_ACTIVATED: "tenant.activated",
  TENANT_DEACTIVATED: "tenant.deactivated",
  // ── Paid-tenant provisioning ──
  PAID_TENANT_PROVISIONING_REQUESTED: "billing.paid_tenant_provisioning_requested",
  PAID_TENANT_CREATED: "billing.paid_tenant_created",
  PENDING_CHECKOUT_CREATED: "billing.pending_checkout_created",
  PAYMENT_CONTINUATION_LINK_CREATED: "billing.payment_continuation_link_created",
  PAYMENT_CONTINUATION_LINK_REVOKED: "billing.payment_continuation_link_revoked",
  PAYMENT_CONTINUATION_LINK_RESENT: "billing.payment_continuation_link_resent",
  PAID_TENANT_PROVISIONING_FAILED: "billing.paid_tenant_provisioning_failed",
  BILLING_PROVISIONING_REQUEST_CREATED: "billing.provisioning_request_created",
  BILLING_PROVISIONING_ATTEMPTED: "billing.provisioning_attempted",
  BILLING_PROVISIONING_COMPLETED: "billing.provisioning_completed",
  BILLING_PROVISIONING_FAILED: "billing.provisioning_failed",
  BILLING_PROVISIONING_REPAIRED: "billing.provisioning_repaired",
  PAID_TENANT_EMAIL_SENT: "billing.paid_tenant_email_sent",
  PAID_TENANT_EMAIL_FAILED: "billing.paid_tenant_email_failed",
  MANUAL_CONTRACT_ACTIVATED: "billing.manual_contract_activated",
  // A POC is product given away: who authorised it, how much, until when and
  // with which feature areas is exactly the thing to be able to answer later.
  POC_PROVISIONED: "billing.poc_provisioned",
  // ── Role changes ──
  ROLE_CHANGED: "user.role_changed",
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  ROLE_ASSIGNED: "role.assigned",
  ROLE_UNASSIGNED: "role.unassigned",
  // ── Permission / feature-grant changes ──
  PERMISSION_GRANTED: "permission.granted",
  PERMISSION_REVOKED: "permission.revoked",
  PERMISSION_CHANGED: "permission.changed",
  FEATURE_GRANT_CHANGED: "feature_grant.changed",
  // ── Credential changes (GOTCHA never stores passwords; these are the
  //    identity-adjacent actions it CAN perform) ──
  PASSWORD_RESET_REQUESTED: "credential.password_reset_requested",
  SETUP_LINK_ISSUED: "credential.setup_link_issued",
  // The other two ends of the same link. REDEEMED fires when the recipient
  // clicks and a fresh IdP recovery link is minted for them; REJECTED when the
  // link was already expired, revoked or unknown. Recording the refusal is what
  // makes "why did my invitation not work" answerable without reading logs.
  SETUP_LINK_REDEEMED: "credential.setup_link_redeemed",
  SETUP_LINK_REJECTED: "credential.setup_link_rejected",
  INTEGRATION_CREDENTIAL_UPDATED: "credential.integration_updated",
  INTEGRATION_CREDENTIAL_DELETED: "credential.integration_deleted",
  // ── Invite flow ──
  INVITE_CREATED: "invite.created",
  INVITE_ACCEPTED: "invite.accepted",
  INVITE_REVOKED: "invite.revoked",
  INVITE_RESENT: "invite.resent",
  // ── Authentication / MFA (mirrored from Authentik events where surfaced) ──
  AUTH_LOGIN_SUCCEEDED: "auth.login_succeeded",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  MFA_ENROLLED: "auth.mfa_enrolled",
  MFA_CHALLENGE_FAILED: "auth.mfa_challenge_failed",
  MFA_DEVICE_REMOVED: "auth.mfa_device_removed",
  MFA_POLICY_CHANGED: "auth.mfa_policy_changed",
  SESSION_TERMINATED: "auth.session_terminated",
  ALL_SESSIONS_TERMINATED: "auth.all_sessions_terminated",
  EMAIL_CHANGE_REQUESTED: "auth.email_change_requested",
  EMAIL_CHANGE_CONFIRMED: "auth.email_change_confirmed",
  // ── Business recommendations lifecycle ──
  RECOMMENDATION_COMPLETED: "recommendation.completed",
  RECOMMENDATION_DISMISSED: "recommendation.dismissed",
  RECOMMENDATION_REOPENED: "recommendation.reopened",
  // ── Knowledge Base ingestion ──
  // A website scan rewrites what the AI employee knows, so every sync records
  // what it added, refreshed, preserved and removed. Without this a customer
  // asking "why did the bot start saying 14 days?" has no trail to follow.
  KNOWLEDGE_SCAN_SYNCED: "knowledge.scan_synced",
  KNOWLEDGE_BACKFILL_RUN: "knowledge.backfill_run",
  // A piece of knowledge mined from historical conversations, approved by a
  // human into the live knowledge base. Audited separately from a scan sync
  // because the provenance is different in a way that matters: a scan copies
  // what the business PUBLISHED, this promotes what an employee once SAID to
  // one customer. When somebody later asks "why does the bot say 45 days", the
  // answer has to name the person who approved it and the conversations it came
  // from.
  KNOWLEDGE_HISTORICAL_APPROVED: "knowledge.historical_approved",
  // ── The rate money is charged at ──
  // Platform-level (tenantId "platform"). These decide what every Israeli
  // customer's card is debited, so they are audited separately from pricing:
  // "who changed the price of a plan" and "who changed what a dollar costs" are
  // different questions, and the second one has no per-tenant trail anywhere.
  EXCHANGE_RATE_PROPOSED: "billing.exchange_rate_proposed",
  EXCHANGE_RATE_APPROVED: "billing.exchange_rate_approved",
  EXCHANGE_RATE_RETIRED: "billing.exchange_rate_retired",
  // Money going back out. Audited for the same reason money coming in is: it is
  // an irreversible action on a customer's account taken by an operator.
  REFUND_ISSUED: "billing.refund_issued",
  REFUND_REFUSED: "billing.refund_refused",
  // ── GDPR data-subject actions ──
  DSR_EXPORT_REQUESTED: "gdpr.export_requested",
  DSR_EXPORT_COMPLETED: "gdpr.export_completed",
  DSR_ERASURE_REQUESTED: "gdpr.erasure_requested",
  DSR_ERASURE_COMPLETED: "gdpr.erasure_completed",
  CONSENT_GRANTED: "gdpr.consent_granted",
  CONSENT_WITHDRAWN: "gdpr.consent_withdrawn",
  RETENTION_PURGE_RAN: "gdpr.retention_purge_ran",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Write one audit event. Fire-safe: swallows all errors after logging them,
 * so callers can `void writeAudit(...)` without a try/catch.
 */
export async function writeAudit(event: AuditEventInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        metadata: (event.metadata ?? undefined) as any,
        createdAt: event.at ?? new Date(),
      },
    });
  } catch (err: any) {
    // Never throw - audit logging must not break business logic.
    console.error("[audit] failed to write audit event:", err?.message ?? err);
  }
}

/** Convenience: a user performed an action. */
export function auditUser(
  tenantId: string,
  userId: string | null | undefined,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, any>,
): Promise<void> {
  return writeAudit({
    tenantId,
    actorType: "user",
    actorId: userId ?? null,
    action,
    targetType: target?.type,
    targetId: target?.id,
    metadata,
  });
}

/** Convenience: the system (no human actor) performed an action. */
export function auditSystem(
  tenantId: string,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, any>,
): Promise<void> {
  return writeAudit({
    tenantId,
    actorType: "system",
    action,
    targetType: target?.type,
    targetId: target?.id,
    metadata,
  });
}
