/**
 * Setup links: a GOTCHA-owned capability to START setting a password.
 *
 * The problem this solves, from a real production incident on 2026-08-06:
 *
 *   Authentik's `POST /core/users/{pk}/recovery/` mints a FlowToken with no
 *   explicit expiry, so it inherits the Authentik tenant's
 *   `default_token_duration` - `minutes=30` out of the box. We mailed that
 *   token directly, over copy promising 48 hours. A customer opened their
 *   invitation 61 minutes later and the flow had no pending user, so the
 *   password form rendered anyway and refused only AFTER they typed a
 *   password: "Request has been denied. No user found and can't create new
 *   user." Nothing was broken; the credential window had simply closed while
 *   the email sat in an inbox.
 *
 * The fix is to stop mailing a credential with a clock already running. We mail
 * a token of our own, and mint the Authentik link when the person actually
 * clicks. The IdP's 30-minute window then starts at the only moment it can be
 * spent, and the 48 hours we advertise is a promise this system owns.
 *
 * Security model, mirroring `PaymentContinuationLink` (services/billing):
 *   - Only the SHA-256 of the token is persisted; the raw value exists just
 *     long enough to be put in one email.
 *   - Issuing revokes every other live link for that user, so a resend really
 *     does invalidate the previous email.
 *   - 24 bytes of randomness (2^192), looked up by a single indexed probe on
 *     the unique hash: nothing to enumerate, no timing signal.
 *   - Redeeming does NOT hand over a session. It hands over a link into
 *     Authentik's recovery flow, which is still the only thing that can set a
 *     credential. GOTCHA remains incapable of issuing one.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  prisma,
  withCrossTenantAccess,
  createRecoveryLink,
  ensureIdentity,
  findIdentityBySubject,
  getUserLastLogin,
  resolveAppPublicUrl,
} from "@chatcenter/shared";

/** 24 bytes = 192 bits, base64url-encoded. */
const TOKEN_BYTES = 24;

/**
 * How long an invitation stays usable. Matches the "48 hours" every invitation
 * email has always claimed - the claim was the accurate half of the old bug.
 */
const DEFAULT_TTL_HOURS = Number(process.env.SETUP_LINK_TTL_HOURS || 48);

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The public URL for a raw token. The API route redeems it and redirects. */
export function setupLinkUrl(token: string): string {
  return `${resolveAppPublicUrl(process.env)}/api/auth/setup/${encodeURIComponent(token)}`;
}

export interface IssuedSetupLink {
  /** Raw token. Returned once, for the email-send boundary only. */
  token: string;
  /** The full URL to put in the email. */
  url: string;
  id: string;
  expiresAt: Date;
}

/**
 * Issue a link for a GOTCHA user, revoking any other live link for them.
 *
 * Cross-tenant by necessity: this is called from tenant provisioning and from
 * the unauthenticated redeem path, where there is no tenant context to guard
 * with, and the row is keyed by a user id the caller already holds.
 */
export async function issueSetupLink(
  userId: string,
  opts: { ttlHours?: number } = {},
): Promise<IssuedSetupLink> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashSetupToken(token);
  const expiresAt = new Date(Date.now() + (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000);

  const link = await withCrossTenantAccess(() =>
    prisma.$transaction(async (tx) => {
      await tx.setupLink.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.setupLink.create({ data: { userId, tokenHash, expiresAt } });
    }),
  );

  return { token, url: setupLinkUrl(token), id: link.id, expiresAt: link.expiresAt };
}

export type SetupLinkRejection = "invalid" | "expired" | "revoked";

export interface ResolvedSetupLink {
  id: string;
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  authentikSubject: string | null;
}

export type SetupLinkResolution =
  | { ok: true; link: ResolvedSetupLink }
  | { ok: false; reason: SetupLinkRejection };

/**
 * Resolve a raw token to its user.
 *
 * Every failure returns the same shape and does the same work, so nothing about
 * whether a token ever existed leaks through content or timing.
 */
export async function resolveSetupLink(rawToken: unknown): Promise<SetupLinkResolution> {
  if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 256) {
    return { ok: false, reason: "invalid" };
  }

  const hash = hashSetupToken(rawToken);
  const row = await withCrossTenantAccess(() =>
    prisma.setupLink.findUnique({
      where: { tokenHash: hash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            tenantId: true,
            email: true,
            name: true,
            identity: { select: { authentikSubject: true } },
          },
        },
      },
    }),
  );
  if (!row) return { ok: false, reason: "invalid" };

  // The unique index already matched; this removes any doubt about comparison
  // side channels in the layers underneath.
  if (!constantTimeEquals(hash, hashSetupToken(rawToken))) {
    return { ok: false, reason: "invalid" };
  }

  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    link: {
      id: row.id,
      userId: row.userId,
      tenantId: row.user.tenantId,
      email: row.user.email,
      name: row.user.name,
      authentikSubject: row.user.identity?.authentikSubject ?? null,
    },
  };
}

/**
 * Find the user behind a token WITHOUT caring whether it is still live.
 *
 * This is what makes "that link expired, send me another" work: the dead link
 * in the recipient's hand is itself the proof of who they are, so the resend
 * needs no email address from an anonymous caller and cannot be used to probe
 * whether an address is registered.
 */
export async function ownerOfSetupToken(rawToken: unknown): Promise<{ userId: string; email: string; tenantId: string } | null> {
  if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 256) return null;
  const row = await withCrossTenantAccess(() =>
    prisma.setupLink.findUnique({
      where: { tokenHash: hashSetupToken(rawToken) },
      select: { userId: true, user: { select: { email: true, tenantId: true } } },
    }),
  );
  if (!row) return null;
  return { userId: row.userId, email: row.user.email, tenantId: row.user.tenantId };
}

/** Record first use, for audit. Multi-use: this does not consume the link. */
export async function markSetupLinkUsed(id: string): Promise<void> {
  await withCrossTenantAccess(() =>
    prisma.setupLink.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } }),
  );
}

export type RedeemOutcome =
  | { status: "recovery"; url: string }
  | { status: "already_has_password" }
  | { status: "no_identity" };

/**
 * Exchange a resolved link for a live Authentik recovery URL.
 *
 * Refuses for an identity that has signed in before, for the same reason the
 * invite path does: that person already has a credential, and walking them into
 * a "set your password" flow is how you lock somebody out of an account they
 * were already using.
 */
export async function redeemForRecoveryUrl(link: ResolvedSetupLink): Promise<RedeemOutcome> {
  const identity = link.authentikSubject
    ? await findIdentityBySubject(link.authentikSubject)
    : await ensureIdentity(link.email, link.name);
  if (!identity) return { status: "no_identity" };

  const hasLoggedIn = await getUserLastLogin(identity.pk)
    .then((v) => v != null)
    .catch(() => false);
  if (hasLoggedIn) return { status: "already_has_password" };

  return { status: "recovery", url: await createRecoveryLink(identity.pk) };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
