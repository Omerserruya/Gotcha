import {
  prisma,
  ensureIdentity,
  createRecoveryLink,
  deactivateIdentity,
  setIdentityActive,
  deleteIdentity,
  updateIdentity,
  findIdentityBySubject,
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
 *   - GOTCHA gets the ACCOUNT (which tenant, which role, which department).
 * The two are joined by `authentikSubject`, and no credential ever touches
 * GOTCHA - the invitee sets their password inside Authentik's recovery flow.
 */

export interface InviteResult {
  user: { id: string; email: string; name: string; role: string; tenantId: string };
  /** One-time Authentik link where the invitee sets their password. */
  setupLink: string;
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
  const identity = await ensureIdentity(email, name);

  // An identity can legitimately be shared across tenants (the same person
  // working for two customers), but a subject may map to only one user row per
  // our unique constraint. Guard explicitly so the failure is legible rather
  // than a raw Prisma unique-violation.
  const claimed = await prisma.user.findUnique({
    where: { authentikSubject: identity.subject },
    select: { id: true, tenantId: true },
  });
  if (claimed) {
    throw new Error("This identity is already linked to another GOTCHA account");
  }

  const user = await prisma.user.create({
    data: {
      tenantId,
      email,
      name,
      role: role as any,
      authentikSubject: identity.subject,
    },
    select: { id: true, email: true, name: true, role: true, tenantId: true },
  });

  const setupLink = await createRecoveryLink(identity.pk);

  // Email the invitee their setup link. Fire-and-forget: the invite must not
  // fail on an SMTP blip - the admin still gets the link back in the UI and
  // can share it by hand.
  void (async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    await sendTeamInviteEmail(email, name, tenant?.name || "your team", setupLink);
  })().catch((err) => console.warn("[invitation] invite email failed:", err?.message ?? err));

  return { user, setupLink };
}

/**
 * Remove a user's ability to authenticate.
 *
 * Deactivating locally alone is not enough: without disabling the identity the
 * person keeps a valid Authentik session and a working token until it expires.
 * Local deactivation stops authorization; Authentik deactivation stops
 * authentication. Both are needed.
 */
export async function revokeUserAccess(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authentikSubject: true },
  });

  await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

  if (user?.authentikSubject) {
    const identity = await findIdentityBySubject(user.authentikSubject);
    if (identity) await deactivateIdentity(identity.pk);
  }
}

/**
 * Enable/disable a user in BOTH systems from a single call.
 *
 * Fixes the lifecycle inconsistency where a GOTCHA-only `isActive=false` left
 * the Authentik identity active - so a disabled user kept a valid IdP session
 * and token until expiry. Local flag stops authorization; the IdP flag stops
 * authentication. The GOTCHA row is the caller's responsibility to write; this
 * mirrors the change into Authentik (best-effort, never throws).
 */
export async function syncIdentityActive(authentikSubject: string | null, active: boolean): Promise<void> {
  if (!authentikSubject) return;
  try {
    const identity = await findIdentityBySubject(authentikSubject);
    if (identity) await setIdentityActive(identity.pk, active);
  } catch (err: any) {
    console.warn("[invitation] Authentik active-state sync failed:", err?.message ?? err);
  }
}

/**
 * Keep the Authentik display name in sync after a GOTCHA-side rename.
 * Best-effort: resolves the identity by the stored subject and PATCHes its
 * `name`. Never throws - a rename must not fail because the IdP is briefly
 * unreachable; the sync can be retried on the next edit.
 */
export async function syncIdentityName(authentikSubject: string | null, name: string): Promise<void> {
  if (!authentikSubject || !name?.trim()) return;
  try {
    const identity = await findIdentityBySubject(authentikSubject);
    if (identity) await updateIdentity(identity.pk, { name });
  } catch (err: any) {
    console.warn("[invitation] Authentik name sync failed:", err?.message ?? err);
  }
}

/**
 * GDPR erasure of the IdP-side identity (Art. 17).
 *
 * revokeUserAccess only DEACTIVATES the Authentik identity (login blocked, data
 * retained). Erasure must remove the personal data held in the IdP too, so a
 * data-subject erasure is complete across both GOTCHA and Authentik. Safe when
 * an identity is shared across tenants is the caller's concern - this deletes
 * the identity unconditionally, so callers must confirm no other tenant's user
 * row references the same subject before calling.
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
    select: { authentikSubject: true, email: true, name: true },
  });
  if (!user) throw new Error("User not found");

  const identity = user.authentikSubject
    ? await findIdentityBySubject(user.authentikSubject)
    : await ensureIdentity(user.email, user.name);
  if (!identity) throw new Error("No Authentik identity for this user");

  return createRecoveryLink(identity.pk);
}
