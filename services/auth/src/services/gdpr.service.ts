/**
 * GDPR data-lifecycle for USERS and TENANTS (auth service owns both domains).
 *
 * Provides Right of access/portability (Art. 15/20) and Right to erasure
 * (Art. 17), across all stores that hold the subject's personal data:
 *   - Postgres (GOTCHA app DB) - deleted here in a transaction
 *   - Authentik (the IdP) - identity deleted via the shared admin client
 *   - Qdrant (vectors) - purged for a tenant via the ai-service internal endpoint
 *
 * Every operation records a DataSubjectRequest row (Art. 30 accountability) and
 * writes an audit event. Contact/end-customer erasure lives in the conversation
 * service (it owns the Contact domain); this module covers users and tenants.
 */

import {
  prisma,
  getInternalServiceKey,
  writeAudit,
  AuditAction,
} from "@chatcenter/shared";
import { eraseUserIdentity } from "./invitation.service";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

async function purgeTenantVectors(tenantId: string): Promise<boolean> {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/gdpr-internal/purge-tenant-vectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": getInternalServiceKey() },
      body: JSON.stringify({ tenantId }),
    });
    return res.ok;
  } catch (err: any) {
    console.error("[gdpr] Qdrant purge call failed:", err?.message ?? err);
    return false;
  }
}

// ─── USER ──────────────────────────────────────────────────────

/** Export one user's personal data (Art. 15/20). Tenant-scoped. */
export async function exportUser(tenantId: string, userId: string, requestedBy?: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: {
      id: true, email: true, name: true, role: true, isActive: true,
      phoneNumber: true, locale: true, authentikSubject: true,
      createdAt: true, updatedAt: true,
    },
  });
  if (!user) return null;

  const [assignedConversations, consents] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, assignedAgentId: userId } }),
    prisma.consentRecord.findMany({
      where: { tenantId, subjectType: "user", subjectId: userId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const result = {
    exportedAt: new Date().toISOString(),
    subjectType: "user" as const,
    user,
    stats: { assignedConversations },
    consents,
  };

  await prisma.dataSubjectRequest.create({
    data: {
      tenantId, requestType: "export", subjectType: "user", subjectId: userId,
      status: "COMPLETED", requestedBy: requestedBy ?? null,
      result: { assignedConversations, consents: consents.length } as any,
      completedAt: new Date(),
    },
  });
  await writeAudit({
    tenantId, actorType: requestedBy ? "user" : "system", actorId: requestedBy,
    action: AuditAction.DSR_EXPORT_COMPLETED, targetType: "user", targetId: userId,
  });
  return result;
}

/**
 * Erase one user (Art. 17): delete the GOTCHA row AND the Authentik identity,
 * unless the same identity is still referenced by another tenant's user row
 * (identities can be legitimately shared) - in that case only this tenant's row
 * is removed and the identity is preserved.
 */
export async function eraseUser(tenantId: string, userId: string, requestedBy?: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, name: true, authentikSubject: true, role: true },
  });
  if (!user) return null;
  if (user.role === "SYSTEM_ADMIN") {
    throw new Error("cannot_erase_system_admin");
  }

  // Is the identity shared with another account (any tenant)?
  let identityDeleted = false;
  if (user.authentikSubject) {
    const others = await prisma.user.count({
      where: { authentikSubject: user.authentikSubject, id: { not: userId } },
    });
    if (others === 0) {
      identityDeleted = await eraseUserIdentity(user.authentikSubject);
    }
  }

  // Remove the app row + this user's consent records.
  await prisma.$transaction([
    prisma.consentRecord.deleteMany({ where: { tenantId, subjectType: "user", subjectId: userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);

  await prisma.dataSubjectRequest.create({
    data: {
      tenantId, requestType: "erasure", subjectType: "user", subjectId: userId,
      status: "COMPLETED", requestedBy: requestedBy ?? null,
      result: { identityDeleted } as any, completedAt: new Date(),
    },
  });
  await writeAudit({
    tenantId, actorType: requestedBy ? "user" : "system", actorId: requestedBy,
    action: AuditAction.DSR_ERASURE_COMPLETED, targetType: "user", targetId: userId,
    metadata: { identityDeleted, name: user.name },
  });
  return { deleted: true, identityDeleted };
}

// ─── TENANT ────────────────────────────────────────────────────

/** Export a whole tenant's personal-data footprint (Art. 15/20 / off-boarding). */
export async function exportTenant(tenantId: string, requestedBy?: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return null;

  const [users, contacts, conversations, messages, consents] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId },
      select: { id: true, email: true, name: true, role: true, phoneNumber: true, locale: true, createdAt: true },
    }),
    prisma.contact.findMany({ where: { tenantId } }),
    prisma.conversation.count({ where: { tenantId } }),
    prisma.message.count({ where: { tenantId } }),
    prisma.consentRecord.findMany({ where: { tenantId } }),
  ]);

  const result = {
    exportedAt: new Date().toISOString(),
    subjectType: "tenant" as const,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, createdAt: tenant.createdAt },
    users,
    contacts,
    stats: { conversations, messages },
    consents,
  };

  await prisma.dataSubjectRequest.create({
    data: {
      tenantId, requestType: "export", subjectType: "tenant", subjectId: tenantId,
      status: "COMPLETED", requestedBy: requestedBy ?? null,
      result: { users: users.length, contacts: contacts.length, conversations, messages } as any,
      completedAt: new Date(),
    },
  });
  await writeAudit({
    tenantId, actorType: requestedBy ? "user" : "system", actorId: requestedBy,
    action: AuditAction.DSR_EXPORT_COMPLETED, targetType: "tenant", targetId: tenantId,
  });
  return result;
}

/**
 * Comprehensive tenant off-boarding purge (Art. 17). Unlike the old
 * best-effort cascade, this removes every store the tenant's data lives in:
 *   1. Authentik identities of the tenant's users (unless shared cross-tenant)
 *   2. Qdrant vectors (via the ai-service internal endpoint)
 *   3. Postgres rows the FK cascade does NOT reach (UsageLog, AuditLog written
 *      before the cascade, ConsentRecord, DataRetentionPolicy) plus the tenant
 *      itself (its onDelete: Cascade FKs take the rest).
 * Records a DSR + audit BEFORE deleting the tenant (the audit row is tenant-
 * scoped and would otherwise be cascade-deleted).
 */
export async function eraseTenant(tenantId: string, requestedBy?: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });
  if (!tenant) return null;

  // 1. Authentik identities. Only delete an identity not shared with a user in
  //    another tenant.
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, authentikSubject: true },
  });
  let identitiesDeleted = 0;
  for (const u of users) {
    if (!u.authentikSubject) continue;
    const others = await prisma.user.count({
      where: { authentikSubject: u.authentikSubject, tenantId: { not: tenantId } },
    });
    if (others === 0) {
      try {
        if (await eraseUserIdentity(u.authentikSubject)) identitiesDeleted++;
      } catch (err: any) {
        console.error(`[gdpr] Authentik erase failed for user ${u.id}:`, err?.message ?? err);
      }
    }
  }

  // 2. Qdrant vectors.
  const vectorsPurged = await purgeTenantVectors(tenantId);

  // 3. DSR + audit recorded BEFORE the delete (they are tenant-scoped and the
  //    tenant delete cascade would otherwise remove the DSR row).
  await prisma.dataSubjectRequest.create({
    data: {
      tenantId, requestType: "erasure", subjectType: "tenant", subjectId: tenantId,
      status: "COMPLETED", requestedBy: requestedBy ?? null,
      result: { identitiesDeleted, vectorsPurged, users: users.length } as any,
      completedAt: new Date(),
    },
  });
  await writeAudit({
    tenantId, actorType: requestedBy ? "user" : "system", actorId: requestedBy,
    action: AuditAction.TENANT_DELETED, targetType: "tenant", targetId: tenantId,
    metadata: { name: tenant.name, identitiesDeleted, vectorsPurged, userCount: users.length },
  });

  // 4. Postgres. Delete rows the tenant FK cascade does not own, then the
  //    tenant (its onDelete: Cascade relations remove the rest: users,
  //    conversations, messages, contacts, channels, etc.).
  await prisma.$transaction([
    prisma.usageLog.deleteMany({ where: { tenantId } }),
    prisma.auditLog.deleteMany({ where: { tenantId } }),
    prisma.consentRecord.deleteMany({ where: { tenantId } }),
    prisma.dataRetentionPolicy.deleteMany({ where: { tenantId } }),
    prisma.dataSubjectRequest.deleteMany({ where: { tenantId } }),
    prisma.tenant.delete({ where: { id: tenantId } }),
  ]);

  return { deleted: true, identitiesDeleted, vectorsPurged, userCount: users.length };
}
