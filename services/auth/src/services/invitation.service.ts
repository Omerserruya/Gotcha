import {
  prisma,
  withCrossTenantAccess,
  ensureIdentity,
  createRecoveryLink,
  setIdentityActive,
  deleteIdentity,
  updateIdentity,
  findIdentityBySubject,
  getUserLastLogin,
  terminateAllUserSessions,
} from "@chatcenter/shared";
import { sendTeamInviteEmail } from "./notification.service";

/**
 * User provisioning.
 *
 * Registration is closed: there is no public signup. A GOTCHA user comes into
 * existence exactly one way - someone with authority invites them. This module
 * is that path.
 *
 * The split matters:
 *   - Authentik gets the IDENTITY (who this person is, how they prove it).
 *   - GOTCHA gets the MEMBERSHIP (which tenant, which role, which department).
 * The two are joined through the local `Identity` row (keyed by the OIDC
 * subject), and no credential ever touches GOTCHA - the invitee sets their
 * password inside Authentik's recovery flow.
 *
 * One person, many tenants: inviting an email that already has an identity
 * (because another tenant invited them first) does NOT fail - it creates a new
 * MEMBERSHIP for the same identity. The person signs in once and picks the
 * workspace.
 */

export interface InviteResult {
  user: { id: string; email: string; name: string; role: string; tenantId: string };
  /**
   * One-time Authentik link where the invitee sets their password. Null when
   * the identity has already completed setup (an existing user of another
   * tenant) - there is no credential left to set, they just sign in.
   */
  setupLink: string | null;
  /** True when this invite attached an EXISTING identity to a new tenant. */
  existingIdentity: boolean;
}

/**
 * Resolve-or-create the local Identity row for an Authentik identity.
 * Keyed by subject first (the immutable anchor), then by email (an invited-
 * but-never-provisioned row), creating fresh when neither exists.
 */
async function ensureLocalIdentity(authentik: { subject: string; email: string }, name: string) {
  const email = authentik.email.toLowerCase();
  const bySubject = await prisma.identity.findUnique({ where: { authentikSubject: authentik.subject } });
  if (bySubject) return bySubject;
  const byEmail = await prisma.identity.findUnique({ where: { email } });
  if (byEmail) {
    // Row existed without a subject (pre-provisioning) - bind it now.
    if (!byEmail.authentikSubject) {
      return prisma.identity.update({
        where: { id: byEmail.id },
        data: { authentikSubject: authentik.subject },
      });
    }
    // Same email, different subject: the email was re-provisioned in Authentik.
    // Trust the live subject - it is what tokens will carry.
    return prisma.identity.update({
      where: { id: byEmail.id },
      data: { authentikSubject: authentik.subject },
    });
  }
  return prisma.identity.create({
    data: { authentikSubject: authentik.subject, email, name },
  });
}

export async function inviteUser(
  tenantId: string,
  email: string,
  name: string,
  role: "ADMIN" | "AGENT" = "AGENT",
): Promise<InviteResult> {
  const existing = await prisma.user.findFirst({ where: { tenantId, email } });
  if (existing) throw new Error("User with this email already exists for this tenant");

  // Create the identity FIRST. If this fails we must not leave a GOTCHA user
  // row with no way to authenticate - better to surface the error and have the
  // owner retry than to create an account nobody can ever log into.
  const authentik = await ensureIdentity(email, name);
  const identity = await ensureLocalIdentity(authentik, name);

  // One membership per identity per tenant. (The email check above already
  // covers the common case; this covers an email-changed identity.)
  const already = await prisma.user.findUnique({
    where: { tenantId_identityId: { tenantId, identityId: identity.id } },
    select: { id: true },
  });
  if (already) throw new Error("This person is already a member of this tenant");

  const user = await prisma.user.create({
    data: {
      tenantId,
      identityId: identity.id,
      email,
      name,
      role: role as any,
    },
    select: { id: true, email: true, name: true, role: true, tenantId: true },
  });

  // An identity that has signed in before needs NO setup link - their password
  // already exists. Minting one anyway would email an existing user a "set
  // your password" link, which reads like a phish and can lock them out.
  const hasLoggedIn = await getUserLastLogin(authentik.pk).then((v) => v != null).catch(() => false);
  const setupLink = hasLoggedIn ? null : await createRecoveryLink(authentik.pk);

  // Email the invitee. Fire-and-forget: the invite must not fail on an SMTP
  // blip - the admin still gets the link back in the UI and can share it by
  // hand.
  void (async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const target = tenant?.name || "your team";
    const link = setupLink ?? `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}/`;
    await sendTeamInviteEmail(email, name, target, link);
  })().catch((err) => console.warn("[invitation] invite email failed:", err?.message ?? err));

  return { user, setupLink, existingIdentity: hasLoggedIn };
}

/**
 * The identity behind a membership, or null when it was never provisioned.
 */
async function identityOfUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { identityId: true, identity: { select: { id: true, authentikSubject: true } } },
  });
  return user?.identity ?? null;
}

/** Does this identity still have an ACTIVE membership besides `exceptUserId`?
 *  Cross-tenant by definition (the person's own rows, keyed by identityId). */
async function hasOtherActiveMembership(identityId: string, exceptUserId?: string): Promise<boolean> {
  const n = await withCrossTenantAccess(() => prisma.user.count({
    where: { identityId, isActive: true, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
  }));
  return n > 0;
}

/**
 * Remove a user's ability to act - IMMEDIATELY.
 *
 * Disables the MEMBERSHIP locally (authorization stops on the next request),
 * and when the person has no other active tenant left, also disables the
 * Authentik identity AND terminates every live IdP session - so an open
 * browser tab dies now, not when its token happens to expire.
 *
 * An identity that still works in ANOTHER tenant keeps authenticating: the
 * disabled tenant is unreachable for them regardless, because principal
 * resolution refuses inactive memberships.
 */
export async function revokeUserAccess(userId: string): Promise<void> {
  const identity = await identityOfUser(userId);

  await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

  if (identity?.authentikSubject) {
    const stillActive = await hasOtherActiveMembership(identity.id, userId);
    if (!stillActive) {
      const authentik = await findIdentityBySubject(identity.authentikSubject);
      if (authentik) {
        await setIdentityActive(authentik.pk, false);
        // Deactivation alone leaves live sessions cookie-valid until expiry.
        await terminateAllUserSessions(authentik.pk).catch(() => 0);
      }
    }
  }
}

/**
 * Enable/disable a MEMBERSHIP in both systems from a single call.
 *
 * The GOTCHA row is the caller's responsibility to write; this mirrors the
 * consequence into Authentik (best-effort, never throws):
 *   - disable: if this was the identity's LAST active membership, disable the
 *     IdP identity and kill its sessions (immediate lockout).
 *   - enable: re-enable the IdP identity (idempotent when already active).
 */
export async function syncMembershipAccess(userId: string, active: boolean): Promise<void> {
  try {
    const identity = await identityOfUser(userId);
    if (!identity?.authentikSubject) return;
    const authentik = await findIdentityBySubject(identity.authentikSubject);
    if (!authentik) return;

    if (active) {
      await setIdentityActive(authentik.pk, true);
      return;
    }
    if (!(await hasOtherActiveMembership(identity.id, userId))) {
      await setIdentityActive(authentik.pk, false);
      await terminateAllUserSessions(authentik.pk).catch(() => 0);
    }
  } catch (err: any) {
    console.warn("[invitation] Authentik active-state sync failed:", err?.message ?? err);
  }
}

/**
 * Keep the Authentik display name in sync after a GOTCHA-side rename.
 * Updates the Identity master + the IdP; per-tenant membership mirrors are the
 * caller's write. Never throws - a rename must not fail because the IdP is
 * briefly unreachable; the sync can be retried on the next edit.
 */
export async function syncIdentityNameByUser(userId: string, name: string): Promise<void> {
  if (!name?.trim()) return;
  try {
    const identity = await identityOfUser(userId);
    if (!identity) return;
    await prisma.identity.update({ where: { id: identity.id }, data: { name: name.trim() } });
    if (identity.authentikSubject) {
      const authentik = await findIdentityBySubject(identity.authentikSubject);
      if (authentik) await updateIdentity(authentik.pk, { name });
    }
  } catch (err: any) {
    console.warn("[invitation] Authentik name sync failed:", err?.message ?? err);
  }
}

/**
 * GDPR erasure of the IdP-side identity (Art. 17).
 *
 * revokeUserAccess only DEACTIVATES the Authentik identity (login blocked,
 * data retained). Erasure must remove the personal data held in the IdP too,
 * so a data-subject erasure is complete across both GOTCHA and Authentik.
 * Callers must confirm no other tenant's membership references the same
 * identity before calling - this deletes the IdP identity unconditionally.
 */
export async function eraseUserIdentity(authentikSubject: string | null): Promise<boolean> {
  if (!authentikSubject) return false;
  const identity = await findIdentityBySubject(authentikSubject);
  if (!identity) return false;
  await deleteIdentity(identity.pk);
  return true;
}

/**
 * Re-issue the password-setup link for someone who never completed setup or
 * lost the email. GOTCHA does not reset the password - it only asks Authentik
 * for a fresh link into Authentik's own recovery flow.
 */
export async function resendSetupLink(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      identity: { select: { authentikSubject: true } },
    },
  });
  if (!user) throw new Error("User not found");

  const identity = user.identity?.authentikSubject
    ? await findIdentityBySubject(user.identity.authentikSubject)
    : await ensureIdentity(user.email, user.name);
  if (!identity) throw new Error("No Authentik identity for this user");

  return createRecoveryLink(identity.pk);
}

/**
 * How a tenant's admin gets into their account.
 *
 * Used at both ends of a paid signup: in the provisioning email, where setting
 * a password is the FIRST thing asked of them, and again after payment, where
 * it is the safety net for an admin whose invoice somebody else settled.
 *
 * The link it mints is a credential, so it may only ever leave here by email.
 * Delivery to the registered address is the whole of the proof that the
 * recipient is who we think.
 *
 * Returns null when the tenant has no admin to send anywhere, which is a
 * misprovisioned tenant rather than an error worth failing a payment over.
 */
export async function tenantAdminEntry(tenantId: string): Promise<{
  user: { id: string; email: string; name: string };
  /** A one-time credential link, or the ordinary way in when one is not needed. */
  actionUrl: string;
  needsPassword: boolean;
} | null> {
  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, identity: { select: { authentikSubject: true } } },
  });
  if (!admin) return null;

  const identity = admin.identity?.authentikSubject
    ? await findIdentityBySubject(admin.identity.authentikSubject)
    : await ensureIdentity(admin.email, admin.name);
  if (!identity) return null;

  // The same rule an invite uses: someone who has signed in already has a
  // password, and mailing them a "set your password" link reads like a phish
  // and can lock them out.
  const hasLoggedIn = await getUserLastLogin(identity.pk).then((v) => v != null).catch(() => false);
  const setupUrl = hasLoggedIn ? null : await createRecoveryLink(identity.pk);

  const frontend = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
  return {
    user: { id: admin.id, email: admin.email, name: admin.name },
    // Both roads end at onboarding; they differ only in whether a credential
    // has to be established on the way.
    actionUrl: setupUrl ?? `${frontend}/login?next=/setup`,
    needsPassword: !hasLoggedIn,
  };
}
