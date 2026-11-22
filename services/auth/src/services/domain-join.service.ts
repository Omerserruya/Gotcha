/**
 * Join by email domain.
 *
 * An organization's admin may switch on ONE domain: the domain of the admin's
 * own email, never a typed one and never a public mail domain. From then on a
 * new address at that domain that fills the public sign-up form joins that
 * organization as an agent instead of opening an organization of its own.
 *
 * Two rules everything here rests on:
 *   - a domain belongs to at most one organization. The claim is checked and
 *     written under a database lock on the domain, so two admins of two
 *     organizations cannot both win;
 *   - the form proves nothing about who typed the address. The person is
 *     admitted the way any invitee is: a membership with no password, and a
 *     set-password link mailed to the address. Only its owner can use it.
 *
 * The setting is a durable setting on the organization (no table of its own);
 * this file reads it from the database, never from the cache, because a stale
 * "on" here admits a person.
 */
import crypto from "crypto";
import {
  prisma,
  withCrossTenantAccess,
  writeDurableSetting,
  writeAudit,
  AuditAction,
  emailDomain,
  isPublicEmailDomain,
  JOIN_BY_DOMAIN_KEY,
  parseJoinByDomain,
  assertWithinLimit,
  EntitlementDeniedError,
  notificationsQueue,
  type JoinByDomain,
} from "@chatcenter/shared";
import { inviteUser, InviteRefused } from "./invitation.service";
import { resolveInviteRoleStrict, ensureRoleAssignment } from "./invite-role.service";

/** The notification the organization's admins get when somebody joins this way. */
export const MEMBER_JOINED_EVENT = "member.joined_by_domain";

/** What the settings screen reads and gets back. */
export interface JoinDomainView {
  /** The domain of the admin who is asking. The only one they may switch on. */
  domain: string;
  /** True when the organization's domain is on AND it is this admin's own. */
  joinByDomain: boolean;
  /** True when the admin's own domain is public mail, so it can never be on. */
  publicDomain: boolean;
  /**
   * The domain that is on for the organization, whoever switched it on. It
   * differs from `domain` when another admin, at another domain, did.
   */
  activeDomain: string | null;
}

type Db = Pick<typeof prisma, "tenantSetting">;

/** Every organization whose setting names this domain, oldest switch-on first. */
async function holdersOf(domain: string, db: Db = prisma): Promise<Array<{ tenantId: string; setting: JoinByDomain }>> {
  const rows = await db.tenantSetting.findMany({
    where: { key: JOIN_BY_DOMAIN_KEY, value: { path: ["domain"], equals: domain } },
    select: { tenantId: true, value: true },
  });
  const out: Array<{ tenantId: string; setting: JoinByDomain }> = [];
  for (const row of rows) {
    // Read strictly and compared again here: the query narrows, this decides.
    const setting = parseJoinByDomain(row.value);
    if (setting && setting.domain === domain) out.push({ tenantId: row.tenantId, setting });
  }
  return out.sort((a, b) => a.setting.enabledAt.localeCompare(b.setting.enabledAt) || a.tenantId.localeCompare(b.tenantId));
}

/** The organization's own stored setting, from the database. */
async function storedFor(tenantId: string): Promise<JoinByDomain | null> {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: JOIN_BY_DOMAIN_KEY } },
    select: { value: true },
  });
  return row ? parseJoinByDomain(row.value) : null;
}

function viewOf(domain: string, stored: JoinByDomain | null): JoinDomainView {
  const publicDomain = isPublicEmailDomain(domain);
  return {
    domain,
    publicDomain,
    joinByDomain: !publicDomain && stored?.domain === domain,
    activeDomain: stored?.domain ?? null,
  };
}

/** Null when the admin's own address has no usable domain. */
export async function joinDomainView(tenantId: string, adminEmail: string): Promise<JoinDomainView | null> {
  const domain = emailDomain(adminEmail);
  if (!domain) return null;
  return viewOf(domain, await storedFor(tenantId));
}

export type SetJoinDomainResult =
  | { ok: true; view: JoinDomainView }
  | { ok: false; status: 409; error: "public_domain" | "domain_taken" | "no_domain" };

/**
 * Switch the organization's domain on or off.
 *
 * On: the domain is the admin's own, and it replaces whatever domain the
 * organization had (there is one). Off: the organization's domain is removed,
 * whoever switched it on.
 */
export async function setJoinDomain(
  tenantId: string,
  admin: { userId: string; email: string },
  on: boolean,
  now: Date = new Date(),
): Promise<SetJoinDomainResult> {
  const domain = emailDomain(admin.email);
  if (!domain) return { ok: false, status: 409, error: "no_domain" };
  const before = await storedFor(tenantId);

  if (!on) {
    await writeDurableSetting(tenantId, JOIN_BY_DOMAIN_KEY, null, admin.userId);
    // The shared writer logs a failed delete and returns. "Off" that is still
    // on keeps admitting people, so it is read back before it is reported.
    if (await storedFor(tenantId)) throw new Error("join-by-domain: the setting was not removed");
    if (before) audit(tenantId, admin.userId, { on: false, domain: before.domain });
    return { ok: true, view: viewOf(domain, null) };
  }

  if (isPublicEmailDomain(domain)) return { ok: false, status: 409, error: "public_domain" };
  // Already on, with this domain: nothing to claim and nothing to rewrite.
  if (before?.domain === domain) return { ok: true, view: viewOf(domain, before) };

  const setting: JoinByDomain = { domain, enabledBy: admin.userId, enabledAt: now.toISOString() };
  const taken = await prisma.$transaction(async (tx) => {
    // One claim at a time per domain. The lock is held until this transaction
    // ends, and the write below has been committed by then.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`joinByDomain:${domain}`}))`;
    const others = (await holdersOf(domain, tx)).filter((h) => h.tenantId !== tenantId);
    if (others.length > 0) return true;
    await writeDurableSetting(tenantId, JOIN_BY_DOMAIN_KEY, JSON.stringify(setting), admin.userId);
    return false;
  });
  if (taken) return { ok: false, status: 409, error: "domain_taken" };

  audit(tenantId, admin.userId, { on: true, domain, previousDomain: before?.domain ?? null });
  return { ok: true, view: viewOf(domain, setting) };
}

function audit(tenantId: string, actorId: string, metadata: Record<string, unknown>): void {
  void writeAudit({
    tenantId,
    actorType: "user",
    actorId,
    action: AuditAction.JOIN_BY_DOMAIN_CHANGED,
    targetType: "tenant",
    targetId: tenantId,
    metadata,
  });
}

// ── At sign-up ───────────────────────────────────────────────────────────────

export interface JoinOrganization {
  tenantId: string;
  domain: string;
  /** False when the organization is switched off or suspended: nobody joins it. */
  open: boolean;
}

/**
 * The organization a new address at this domain joins, or null when no
 * organization holds the domain (the person then opens their own).
 *
 * An organization that is switched off or suspended still HOLDS its domain:
 * the answer is that organization with `open: false`, so its people do not
 * end up with organizations of their own while it is away.
 */
export async function organizationHolding(email: string): Promise<JoinOrganization | null> {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return null;
  const holder = (await holdersOf(domain))[0];
  if (!holder) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: holder.tenantId },
    select: { id: true, status: true, isActive: true },
  });
  if (!tenant) return null;
  return { tenantId: tenant.id, domain, open: tenant.isActive && tenant.status !== "SUSPENDED" };
}

export type AdmitOutcome =
  | { kind: "joined"; tenantId: string; userId: string }
  /** Nothing was created and nobody was mailed. */
  | { kind: "not_joined"; tenantId: string; reason: "organization_closed" | "seats_full" | "already_member" | "email_taken" };

/**
 * Admit a new person into the organization that holds their domain, as an
 * agent, through the same steps an admin's invitation takes: the seat check,
 * the membership with its setup-link email, and the agent role.
 */
export async function admitByDomain(
  org: JoinOrganization,
  person: { email: string; name: string },
): Promise<AdmitOutcome> {
  const { tenantId } = org;
  if (!org.open) return { kind: "not_joined", tenantId, reason: "organization_closed" };

  // The organization's plan decides how many people it may have. A full
  // organization is not grown by a form anyone can fill.
  const seats = await withCrossTenantAccess(() => prisma.user.count({ where: { tenantId, isActive: true } }));
  try {
    await assertWithinLimit(tenantId, "limit:users", seats);
  } catch (err) {
    if (err instanceof EntitlementDeniedError) return { kind: "not_joined", tenantId, reason: "seats_full" };
    throw err;
  }

  const role = await resolveInviteRoleStrict(tenantId, "AGENT");
  let userId: string;
  try {
    userId = (await inviteUser(tenantId, person.email, person.name, "AGENT")).user.id;
  } catch (err) {
    if (err instanceof InviteRefused) {
      return { kind: "not_joined", tenantId, reason: err.code === "USER_EXISTS" ? "already_member" : "email_taken" };
    }
    throw err;
  }
  await ensureRoleAssignment(userId, role?.tenantRoleId ?? null, null);

  void writeAudit({
    tenantId,
    actorType: "system",
    actorId: null,
    action: AuditAction.MEMBER_JOINED_BY_DOMAIN,
    targetType: "user",
    targetId: userId,
    metadata: { email: person.email, domain: org.domain, role: "AGENT", roleId: role?.tenantRoleId ?? null },
  });

  // One notice to the organization's admins, in the app. A queue that is down
  // must not undo the join: the person is in, and the audit line says so.
  notificationsQueue
    .add(
      "system-event",
      {
        id: crypto.randomUUID(),
        type: MEMBER_JOINED_EVENT,
        tenantId,
        data: { userId, name: person.name, email: person.email, domain: org.domain },
        metadata: { timestamp: new Date().toISOString() },
      },
      { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
    )
    .catch((err: unknown) => console.warn("[domain-join] the admins' notice was not queued:", (err as Error)?.message ?? err));

  return { kind: "joined", tenantId, userId };
}
