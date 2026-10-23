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
  withCrossTenantAccess,
  getInternalServiceKey,
  writeAudit,
  AuditAction,
} from "@chatcenter/shared";
import { eraseUserIdentity } from "./invitation.service";
import { ERASED_EXPLICITLY } from "./tenant-erasure-tables";

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
  const row = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: {
      id: true, email: true, name: true, role: true, isActive: true,
      phoneNumber: true, locale: true, createdAt: true, updatedAt: true,
      identity: { select: { authentikSubject: true, email: true } },
    },
  });
  if (!row) return null;
  const { identity, ...user } = row;
  const subject = { ...user, authentikSubject: identity.authentikSubject };

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
    user: subject,
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
    select: {
      id: true, name: true, role: true, identityId: true,
      identity: { select: { authentikSubject: true } },
    },
  });
  if (!user) return null;
  if (user.role === "SYSTEM_ADMIN") {
    throw new Error("cannot_erase_system_admin");
  }

  // Is the identity shared with a membership in another tenant? Only when this
  // is the LAST membership do we erase the person - in the IdP AND locally.
  const others = await withCrossTenantAccess(() => prisma.user.count({
    where: { identityId: user.identityId, id: { not: userId } },
  }));
  let identityDeleted = false;
  if (others === 0) {
    identityDeleted = await eraseUserIdentity(user.identity.authentikSubject);
  }

  // Remove the membership row + this user's consent records; when it was the
  // last membership, the local Identity row (name/email/subject) goes too -
  // an Art. 17 erasure must not leave the person's identity data behind.
  await prisma.$transaction([
    prisma.consentRecord.deleteMany({ where: { tenantId, subjectType: "user", subjectId: userId } }),
    prisma.user.delete({ where: { id: userId } }),
    ...(others === 0 ? [prisma.identity.delete({ where: { id: user.identityId } })] : []),
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
/** Checkout states that mean the customer could still pay. */
const OPEN_CHECKOUT_STATES = ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"];

/**
 * Why this tenant must not be deleted right now, or null when it may be.
 *
 * Shared by every door into eraseTenant. Beyond the System tenant and the
 * caller's own, each refusal protects money moving after the organization is
 * gone: a subscription that can still charge, a
 * checkout a customer could still complete, or a Shopify subscription that
 * Shopify keeps billing until the app is uninstalled on their side.
 */
export type TenantDeletionRefusalCode =
  | "SYSTEM_TENANT"
  | "OWN_TENANT"
  | "ACTIVE_PAID_SUBSCRIPTION"
  | "OPEN_CHECKOUT"
  | "SHOPIFY_BILLED";

export async function tenantDeletionRefusal(
  tenantId: string,
  opts: { callerTenantId?: string | null } = {},
): Promise<{ code: TenantDeletionRefusalCode; detail?: string } | null> {
  // Erasing the System organization erases every sysadmin's login with it, and
  // erasing your own ends the session doing the erasing. Both doors check this.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (tenant?.slug === "system") return { code: "SYSTEM_TENANT" };
  if (opts.callerTenantId && opts.callerTenantId === tenantId) return { code: "OWN_TENANT" };

  const shopify = await prisma.providerSubscription.findFirst({
    where: { tenantId, billingSource: "SHOPIFY", status: { notIn: ["DECLINED", "EXPIRED"] as any } },
    select: { id: true },
  });
  if (shopify) return { code: "SHOPIFY_BILLED" };

  const links = await prisma.billableEntityTenant.findMany({
    where: { tenantId },
    select: { entity: { select: { subscription: true } } },
  });
  for (const l of links) {
    const sub = l.entity?.subscription;
    if (!sub) continue;
    if (sub.billingSource === "SHOPIFY" && !["CANCELED"].includes(sub.status)) return { code: "SHOPIFY_BILLED" };
    const plan = await prisma.plan.findFirst({ where: { key: sub.planKey, version: sub.planVersion }, select: { kind: true, basePrice: true } });
    const evaluation = plan?.kind === "POC" || plan?.kind === "TRIAL";
    const price = sub.snapshotPrice != null ? Number(sub.snapshotPrice) : plan?.basePrice != null ? Number(plan.basePrice) : 0;
    // "Can still charge", not "is ACTIVE": a plan an operator set by hand with
    // renewal off is ACTIVE and will never take money, and refusing it would
    // make that organization undeletable until its end date.
    const chargeable =
      sub.status === "PAST_DUE" ||
      (!evaluation && price > 0 && sub.status === "TRIALING") ||
      (!evaluation && price > 0 && sub.status === "ACTIVE" && !sub.cancelAtPeriodEnd);
    if (chargeable) return { code: "ACTIVE_PAID_SUBSCRIPTION", detail: sub.status };
  }

  const checkout = await prisma.pendingCheckout.findFirst({
    where: { tenantId, status: { in: OPEN_CHECKOUT_STATES as any } },
    select: { id: true },
  });
  if (checkout) return { code: "OPEN_CHECKOUT" };
  return null;
}

/** A stored upload's file name, from a /api/uploads/<name> URL. Null for anything else. */
function uploadNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8})(?:[?#].*)?$/i.exec(url);
  return m ? m[1]! : null;
}

const CONVERSATION_SERVICE_URL = process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002";

/** Names per purge call: well under the receiving service's 100kb JSON body limit. */
export const PURGE_BATCH = 500;

/**
 * Ask the service that owns the uploads volume to remove these files, in
 * batches. Never throws. `left` holds the names of every batch that did not
 * fully go, so the caller can report exactly those.
 */
async function purgeUploads(files: string[]): Promise<{ ok: boolean; removed: number; missing: number; left: string[] }> {
  let removed = 0;
  let missing = 0;
  const left: string[] = [];
  for (let i = 0; i < files.length; i += PURGE_BATCH) {
    const batch = files.slice(i, i + PURGE_BATCH);
    try {
      const res = await fetch(`${CONVERSATION_SERVICE_URL}/internal/uploads/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": getInternalServiceKey() },
        body: JSON.stringify({ files: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => ({}));
      removed += Number(body?.removed ?? 0);
      missing += Number(body?.missing ?? 0);
      // 207 is a fetch "ok": the body says whether every file actually went.
      if (!(res.ok && body?.ok === true)) left.push(...batch);
    } catch (err: any) {
      console.error("[gdpr] uploads purge call failed:", err?.message ?? err);
      left.push(...batch);
    }
  }
  return { ok: left.length === 0, removed, missing, left };
}

/** What a channel leaves on the provider side when only our rows are removed. */
const CHANNEL_LEFTOVER: Record<string, string> = {
  WHATSAPP: "number stays registered on the WhatsApp Business Account; the app's webhook subscription remains",
  MESSENGER: "page stays subscribed to the app's webhooks until removed in Meta",
  INSTAGRAM: "account stays subscribed to the app's webhooks until removed in Meta",
  GMAIL: "the OAuth grant (and any mailbox watch until it expires) stays at Google until revoked there",
  OUTLOOK: "the OAuth grant stays at Microsoft until revoked there",
  SLACK: "the app stays installed in the Slack workspace",
  VOICE: "the number stays with the voice provider",
  WEBCHAT: "the widget snippet stays on the customer's site (it stops answering)",
  SHOPIFY_LIVE_CHAT: "the chat app stays installed in the store",
};

/**
 * What stays connected on the PROVIDER side after our rows and tokens are gone.
 *
 * Nothing here calls a provider: disconnecting a real WhatsApp number, page or
 * store from our side is irreversible for the customer, and the organization
 * is being deleted, not migrated. The operator is told what is left instead.
 */
async function providerLeftovers(tenantId: string): Promise<string[]> {
  const [channels, integrations, commerce, calendars, knowledge, shopifyChat] = await Promise.all([
    prisma.channelAccount.findMany({ where: { tenantId }, select: { channel: true, displayName: true, externalId: true } }),
    prisma.tenantIntegration.findMany({ where: { tenantId }, select: { status: true, integration: { select: { slug: true } } } }),
    prisma.commerceConnection.findMany({ where: { tenantId }, select: { platform: true, shopDomain: true } }),
    prisma.calendarAccount.findMany({ where: { tenantId }, select: { provider: true } }),
    prisma.knowledgeIntegration.findMany({ where: { tenantId }, select: { provider: true, displayName: true } }),
    prisma.shopifyChatInstallation.findMany({ where: { tenantId }, select: { shopDomain: true } }),
  ]);
  const out: string[] = [];
  for (const c of channels) {
    out.push(`${c.channel}:${c.displayName} (${c.externalId}): ${CHANNEL_LEFTOVER[c.channel] ?? "provider-side connection remains"}`);
  }
  for (const i of integrations) out.push(`integration:${i.integration?.slug ?? "unknown"}: the OAuth grant stays authorized at the provider until revoked there`);
  for (const c of commerce) out.push(`${c.platform}:${c.shopDomain ?? "store"}: app/plugin and its webhooks stay installed in the store`);
  for (const c of calendars) out.push(`calendar:${c.provider}: the OAuth grant stays authorized at the provider until revoked there`);
  for (const k of knowledge) out.push(`knowledge:${k.provider}:${k.displayName}: the OAuth grant stays authorized at the provider until revoked there`);
  for (const s of shopifyChat) out.push(`shopify-chat:${s.shopDomain}: the chat app stays installed until removed in Shopify`);
  return out;
}

export async function eraseTenant(
  tenantId: string,
  requestedBy?: string,
  opts: { reason?: string | null } = {},
) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) return null;

  // Counts and the provider-side picture, read while the rows still exist.
  const [counts, leftovers] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { _count: { select: { users: true, conversations: true, messages: true, channelAccounts: true, contacts: true } } },
    }).then((t) => t?._count ?? {}),
    providerLeftovers(tenantId),
  ]);
  const media = await Promise.all([
    prisma.message.findMany({ where: { tenantId, mediaUrl: { not: null } }, select: { mediaUrl: true } }),
    prisma.scheduledMessage.findMany({ where: { tenantId, mediaUrl: { not: null } }, select: { mediaUrl: true } }),
  ]);
  const uploadFiles = Array.from(new Set(media.flat().map((m) => uploadNameOf(m.mediaUrl)).filter((n): n is string => !!n)));

  // 1. Authentik + local identities. Only erase a person whose ONLY
  //    membership lives in this tenant - an identity that also works in
  //    another tenant survives (just loses this membership via the cascade).
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, identityId: true, identity: { select: { authentikSubject: true } } },
  });
  let identitiesDeleted = 0;
  const orphanIdentityIds: string[] = [];
  for (const u of users) {
    const others = await prisma.user.count({
      where: { identityId: u.identityId, tenantId: { not: tenantId } },
    });
    if (others === 0) {
      orphanIdentityIds.push(u.identityId);
      try {
        if (await eraseUserIdentity(u.identity.authentikSubject)) identitiesDeleted++;
      } catch (err: any) {
        console.error(`[gdpr] Authentik erase failed for user ${u.id}:`, err?.message ?? err);
      }
    }
  }

  // 2. Qdrant vectors.
  const vectorsPurged = await purgeTenantVectors(tenantId);

  const record = {
    deletedTenantId: tenantId,
    slug: tenant.slug,
    name: tenant.name,
    counts,
    identitiesDeleted,
    vectorsPurged,
    userCount: users.length,
    uploadFiles: uploadFiles.length,
    providerLeftovers: leftovers,
    reason: opts.reason ?? null,
  };

  // 3. Postgres, in ONE transaction: the tables the tenant cascade does not
  //    reach (see tenant-erasure-tables.ts), the billing entity's subscription,
  //    the tenant itself, the orphaned identities - and LAST the deletion's own
  //    audit row, after the auditLog deleteMany, so it is the one row about
  //    this tenant that survives.
  await prisma.$transaction(async (tx) => {
    const db = tx as any;

    // A subscription on an entity that funds ONLY this tenant would outlive
    // it with nobody to bill - and the refusal above already guarantees it
    // cannot charge. Close it so no sweep ever picks it up again.
    const links = await tx.billableEntityTenant.findMany({ where: { tenantId }, select: { billableEntityId: true } });
    for (const { billableEntityId } of links) {
      const funded = await tx.billableEntityTenant.count({ where: { billableEntityId } });
      if (funded !== 1) continue;
      const sub = await tx.subscription.findUnique({ where: { billableEntityId } });
      if (!sub) continue;
      await tx.pendingSubscriptionChange.deleteMany({ where: { subscriptionId: sub.id, appliedAt: null } });
      if (sub.status !== "CANCELED") {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", cancelAtPeriodEnd: true, trialEndsAt: null } });
        await tx.subscriptionEvent.create({
          data: { subscriptionId: sub.id, type: "tenant_deleted", fromStatus: sub.status, toStatus: "CANCELED", actor: requestedBy ?? "system", metadata: { tenantId } as any },
        });
      }
    }

    for (const model of ERASED_EXPLICITLY) {
      await db[model].deleteMany({ where: { tenantId } });
    }
    await tx.tenant.delete({ where: { id: tenantId } });
    // Local identity rows whose last membership just cascade-deleted with the
    // tenant. Deleting the Identity would cascade to users, so it must come
    // AFTER the tenant delete.
    if (orphanIdentityIds.length) await tx.identity.deleteMany({ where: { id: { in: orphanIdentityIds } } });

    await tx.auditLog.create({
      data: {
        tenantId, actorType: requestedBy ? "user" : "system", actorId: requestedBy ?? null,
        action: AuditAction.TENANT_DELETED, targetType: "tenant", targetId: tenantId,
        metadata: record as any,
      },
    });
  }, { timeout: 300_000, maxWait: 30_000 });

  // A second record that does not depend on the database at all.
  console.log(`[gdpr] tenant deleted ${JSON.stringify({ ...record, actorId: requestedBy ?? null })}`);

  // 4. Uploads, after the commit: a failed unlink must never leave a half-
  //    deleted organization. On failure the names are logged so they can be
  //    removed by hand, and the response says so.
  const uploads = await purgeUploads(uploadFiles);
  if (!uploads.ok) {
    console.error(`[gdpr] uploads NOT removed for deleted tenant ${tenantId}: ${JSON.stringify(uploads.left)}`);
  }

  return {
    deleted: true,
    tenantId,
    slug: tenant.slug,
    name: tenant.name,
    counts,
    identitiesDeleted,
    vectorsPurged,
    userCount: users.length,
    uploadsRemoved: uploads.ok,
    uploadFiles: uploadFiles.length,
    uploadsLeftBehind: uploads.left,
    providerLeftovers: leftovers,
  };
}
