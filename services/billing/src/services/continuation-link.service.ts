/**
 * Continuation links: a short-lived capability to resume one checkout.
 *
 * The security model in one line: the raw token exists only long enough to be
 * put in a single email, and only its SHA-256 hash is ever persisted.
 *
 * Consequences, deliberately:
 *   - A database dump, a log leak or a stolen backup yields hashes, not links.
 *   - The token cannot be re-read or re-sent. Resend issues a NEW one and
 *     revokes the old, so there is never more than one valid link.
 *   - Lookup is a single indexed probe on the unique hash: no scan, no timing
 *     signal from how many rows were examined, and nothing to enumerate. The
 *     token space is 2^192, so guessing is not a threat model.
 *
 * A link grants the right to CONTINUE a checkout. It never activates a tenant,
 * completes a checkout, grants credits or enables entitlements - those live
 * behind activatePaidCheckout, which requires a confirmed PaymentAttempt.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@chatcenter/shared";
import type { PaymentContinuationLink } from "@prisma/client";

/** 24 bytes = 192 bits, base64url-encoded. */
const TOKEN_BYTES = 24;

/** Default lifetime. Long enough to act on an email, short enough to matter. */
const DEFAULT_TTL_HOURS = Number(process.env.PAYMENT_LINK_TTL_HOURS || 72);

export interface IssuedLink {
  /**
   * The raw token. Returned ONCE, for the immediate email-send boundary only.
   * Never persisted, never logged, never returned by any read path.
   */
  token: string;
  id: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issue a link, revoking any other active link for the same checkout.
 *
 * Revoke-then-create in one transaction is what guarantees "at most one valid
 * link": a resend must not leave the previous email still working, or revoking
 * access would require chasing every message ever sent.
 */
export async function issueContinuationLink(args: {
  checkoutId: string;
  tenantId: string;
  createdBy?: string | null;
  ttlHours?: number;
}): Promise<IssuedLink> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + (args.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000);

  const link = await prisma.$transaction(async (tx) => {
    await tx.paymentContinuationLink.updateMany({
      where: { checkoutId: args.checkoutId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.paymentContinuationLink.create({
      data: {
        checkoutId: args.checkoutId,
        tenantId: args.tenantId,
        tokenHash,
        purpose: "PAID_TENANT_ONBOARDING",
        expiresAt,
        createdBy: args.createdBy ?? null,
      },
    });
  });

  return { token, id: link.id, expiresAt: link.expiresAt };
}

export type LinkRejection =
  | "invalid"
  | "expired"
  | "revoked"
  | "checkout_not_resumable";

export type LinkResolution =
  | { ok: true; link: PaymentContinuationLink; checkout: { id: string; reference: string; tenantId: string | null; status: string } }
  | { ok: false; reason: LinkRejection };

/**
 * Resolve a raw token.
 *
 * Every failure returns the same shape and does no extra work, so an attacker
 * learns nothing from response timing or content about whether a token existed.
 */
export async function resolveContinuationLink(rawToken: unknown): Promise<LinkResolution> {
  if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 256) {
    return { ok: false, reason: "invalid" };
  }

  const link = await prisma.paymentContinuationLink.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { checkout: true },
  });
  if (!link) return { ok: false, reason: "invalid" };

  // Constant-time confirmation of the hash we matched on. The unique index
  // already did the work; this removes any doubt about comparison side
  // channels in the layers underneath.
  if (!constantTimeEquals(link.tokenHash, hashToken(rawToken))) {
    return { ok: false, reason: "invalid" };
  }

  if (link.revokedAt) return { ok: false, reason: "revoked" };
  if (link.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  // A completed, expired or cancelled checkout is not resumable, however valid
  // the link is.
  const status = link.checkout.status;
  if (status === "PAID" || status === "EXPIRED" || status === "CANCELED") {
    return { ok: false, reason: "checkout_not_resumable" };
  }

  return {
    ok: true,
    link,
    checkout: {
      id: link.checkout.id,
      reference: link.checkout.reference,
      tenantId: link.checkout.tenantId,
      status,
    },
  };
}

/** Record first use, for audit. Multi-use: this does not consume the link. */
export async function markLinkUsed(id: string): Promise<void> {
  await prisma.paymentContinuationLink.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function revokeLinksForCheckout(checkoutId: string): Promise<number> {
  const res = await prisma.paymentContinuationLink.updateMany({
    where: { checkoutId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Active link count, for the "exactly one valid link" invariant. */
export async function activeLinkCount(checkoutId: string, now: Date = new Date()): Promise<number> {
  return prisma.paymentContinuationLink.count({
    where: { checkoutId, revokedAt: null, expiresAt: { gt: now } },
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
