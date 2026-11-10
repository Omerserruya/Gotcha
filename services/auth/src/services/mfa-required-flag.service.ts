/**
 * Option B (Omer, 2026-11-09): Authentik enforces MFA at login only for users
 * GOTCHA requires it of. The login flow's required-MFA validation stage
 * (bootstrap.mjs ensureRequiredMfaEnforcement) keys on the Authentik user
 * attribute "gotcha_mfa_required"; this keeps it in step with
 * mfaRequirementFor.
 *
 * Required for an IDENTITY when any of its active memberships requires it
 * (SYSTEM_ADMIN always; ADMIN / AGENT by their workspace's policy): one login,
 * one answer.
 *
 * When it is synced:
 *   - every verdict the server gate computes (observeMfaRequirement, below):
 *     each user's first request after a change, at the latest their next
 *     /api/auth/me. Deduplicated in memory, so Authentik is asked at most once
 *     per identity per CACHE_MS unless the answer changes;
 *   - at once, for the people a change touches: a workspace's MFA policy
 *     (tenant-security PUT) and a role change (role-guard);
 *   - by the backfill (scripts/mfa-required-backfill.ts).
 * The server gate stays the authority; this only lets Authentik ask at login.
 */
import { prisma, mfaRequirementFor, findIdentityBySubject, setMfaRequiredAttribute, observeMfaRequirement, withCrossTenantAccess } from "@chatcenter/shared";

const CACHE_MS = 10 * 60_000;
const synced = new Map<string, { at: number; required: boolean }>();
const inFlight = new Map<string, Promise<boolean | null>>();

export function resetMfaFlagCache(): void { synced.clear(); inFlight.clear(); }

/** Whether any active membership of this identity requires MFA. */
export async function mfaRequiredForIdentity(identityId: string): Promise<boolean> {
  // An identity's memberships span workspaces: deliberately cross-tenant.
  const users = await withCrossTenantAccess(() => prisma.user.findMany({
    where: { identityId, isActive: true },
    select: { role: true, tenant: { select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true } } },
  }));
  return users.some((u: any) => mfaRequirementFor(u.role, {
    mfaRequiredForAdmins: !!u.tenant?.mfaRequiredForAdmins,
    mfaRequiredForAllUsers: !!u.tenant?.mfaRequiredForAllUsers,
  }).required);
}

/**
 * Set Authentik's marker for this identity to what GOTCHA requires. Returns the
 * value written/confirmed, or null when it could not be (no subject, IdP down).
 */
export async function syncMfaRequiredFlag(identityId: string, opts: { force?: boolean } = {}): Promise<boolean | null> {
  const running = inFlight.get(identityId);
  if (running && !opts.force) return running;
  const job = (async () => {
    const required = await mfaRequiredForIdentity(identityId);
    const hit = synced.get(identityId);
    if (!opts.force && hit && hit.required === required && Date.now() - hit.at < CACHE_MS) return required;
    const identity = await prisma.identity.findUnique({ where: { id: identityId }, select: { authentikSubject: true } });
    if (!identity?.authentikSubject) return null;
    const who = await findIdentityBySubject(identity.authentikSubject);
    if (!who) return null;
    const changed = await setMfaRequiredAttribute(who.pk, required);
    synced.set(identityId, { at: Date.now(), required });
    if (synced.size > 10_000) synced.clear();
    if (changed) console.log(`[mfa-flag] identity=${identityId} gotcha_mfa_required=${required}`);
    return required;
  })().catch((err: any) => {
    console.warn(`[mfa-flag] sync failed for identity=${identityId}: ${err?.message ?? err}`);
    return null;
  }).finally(() => inFlight.delete(identityId));
  inFlight.set(identityId, job);
  return job;
}

/** Sync every identity with a membership in this workspace (its MFA policy changed). */
export async function syncMfaRequiredFlagsForTenant(tenantId: string): Promise<void> {
  const rows = await prisma.user.findMany({ where: { tenantId }, select: { identityId: true } });
  for (const id of [...new Set(rows.map((r: any) => r.identityId).filter(Boolean))]) {
    await syncMfaRequiredFlag(id as string, { force: true });
  }
}

/** Sync the identity behind one user (its role changed). */
export async function syncMfaRequiredFlagForUser(userId: string): Promise<void> {
  const u = await withCrossTenantAccess(() => prisma.user.findUnique({ where: { id: userId }, select: { identityId: true } }));
  if (u?.identityId) await syncMfaRequiredFlag(u.identityId, { force: true });
}

/** Wire the server gate's verdicts to the sync (auth service start-up only). */
export function startMfaRequiredFlagSync(): void {
  observeMfaRequirement((identityId) => { void syncMfaRequiredFlag(identityId); });
}
