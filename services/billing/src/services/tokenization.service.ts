/**
 * Storing a customer's card, and knowing it actually happened.
 *
 * The flow is three steps, and the middle one is where the honesty lives:
 *
 *   1. Record which card tokens the provider ALREADY holds for this customer.
 *   2. Send them to the hosted page.
 *   3. Pull the tokens again and look for one that is NEW.
 *
 * Step 1 is what makes step 3 mean anything. Checking only that "this customer
 * has a stored card" would accept a card they saved months ago, or a session
 * someone replayed, as proof that this session stored one. Comparing against a
 * baseline turns an existence check into a change check.
 *
 * Nothing here treats the browser as evidence. A customer landing on the
 * success URL proves they came back, and people close tabs, lose signal and
 * bookmark redirect URLs. The only accepted proof is the provider's own answer.
 */
import { createHash, randomBytes } from "crypto";
import { prisma, encryptPaymentToken, CURRENT_PAYMENT_TOKEN_KEY_VERSION } from "@chatcenter/shared";
import type { TokenizationSession } from "@prisma/client";
import { icountProvider } from "../providers/icount.provider";
import { icountPaymentPageId } from "../providers/icount-config";
import type { StoredCard } from "../providers/provider";

/** A session outlives a slow checkout but not an abandoned one. */
export const SESSION_TTL_MS = 60 * 60 * 1000;

/** Enough polls to cover provider lag; few enough to stop asking eventually. */
export const MAX_VERIFICATION_ATTEMPTS = 30;

export class TokenizationRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] tokenization refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "TokenizationRefused";
  }
}

/**
 * A stable, non-reversible identifier for a card token.
 *
 * Used everywhere a token would otherwise be compared or logged. Storing the
 * token in a second table would double the number of places a card reference
 * can leak from, and comparing hashes answers the only question we actually
 * have: is this the same card as before, or a different one.
 */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** An opaque customer reference of our own. Never an email or a tenant id. */
export function newCustomClientId(): string {
  return `gtok_${randomBytes(18).toString("base64url")}`;
}

export interface StartSessionInput {
  tenantId: string;
  checkoutId?: string | null;
  providerClientId?: string | null;
  customerName?: string;
  customerEmail?: string;
  successUrl?: string;
  failureUrl?: string;
  now?: Date;
}

export interface StartSessionResult {
  session: TokenizationSession;
  /** Where to send the customer. Not a secret, but server-generated. */
  saleUrl: string;
}

/**
 * Begin tokenization.
 *
 * The baseline is captured BEFORE the hosted session is created, so there is no
 * window in which a card could be stored and then counted as pre-existing.
 */
export async function startTokenizationSession(input: StartSessionInput): Promise<StartSessionResult> {
  const now = input.now ?? new Date();
  const pageId = icountPaymentPageId();
  if (!pageId) throw new TokenizationRefused("payment_page_not_configured");

  const customClientId = newCustomClientId();

  // Baseline first. Doing this after creating the session would leave a window
  // where a card stored in between looks like it was always there.
  const existing = await listCards({ clientId: input.providerClientId, customClientId });
  const baseline = existing.map((c) => fingerprint(c.token));

  const start = await icountProvider.startTokenization!({
    pageId,
    customClientId,
    clientName: input.customerName,
    email: input.customerEmail,
    successUrl: input.successUrl,
    failureUrl: input.failureUrl,
  });

  const session = await prisma.tokenizationSession.create({
    data: {
      tenantId: input.tenantId,
      checkoutId: input.checkoutId ?? null,
      customClientId,
      providerClientId: input.providerClientId ?? null,
      pageId,
      status: "AWAITING_RETURN",
      baselineFingerprints: baseline,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
  });

  return { session, saleUrl: start.saleUrl };
}

export type VerifyOutcome =
  | { verified: true; session: TokenizationSession; paymentMethodId: string; isNewCard: boolean }
  | { verified: false; session: TokenizationSession; reason: "no_new_card_yet" | "expired" | "exhausted" | "already_failed" };

/**
 * Ask the provider whether a new card exists, and store it if so.
 *
 * Safe to call repeatedly - the customer's browser polls this while they finish
 * on the hosted page. Already-verified sessions short-circuit rather than
 * storing a second copy.
 */
export async function verifyTokenizationSession(
  sessionId: string,
  opts: { now?: Date } = {},
): Promise<VerifyOutcome> {
  const now = opts.now ?? new Date();
  const session = await prisma.tokenizationSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new TokenizationRefused("session_not_found");

  if (session.status === "VERIFIED" && session.paymentMethodId) {
    return { verified: true, session, paymentMethodId: session.paymentMethodId, isNewCard: false };
  }
  if (session.status === "FAILED" || session.status === "ABANDONED") {
    return { verified: false, session, reason: "already_failed" };
  }
  if (session.expiresAt <= now) {
    const expired = await fail(session.id, "EXPIRED", "session_expired");
    return { verified: false, session: expired, reason: "expired" };
  }
  if (session.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    // Stop asking. A session that never produced a card is abandoned, not
    // failed - the customer simply did not finish, and calling that a failure
    // would show them an error for something they chose.
    const done = await fail(session.id, "ABANDONED", "verification_attempts_exhausted");
    return { verified: false, session: done, reason: "exhausted" };
  }

  await prisma.tokenizationSession.update({
    where: { id: session.id },
    data: { verificationAttempts: { increment: 1 }, lastVerifiedAt: now },
  });

  const cards = await listCards({
    clientId: session.providerClientId,
    customClientId: session.customClientId,
  });

  // The change check. A card that was already in the baseline proves nothing
  // about this session.
  const baseline = new Set(session.baselineFingerprints);
  const fresh = cards.find((c) => !baseline.has(fingerprint(c.token)));
  if (!fresh) {
    const current = await prisma.tokenizationSession.findUnique({ where: { id: session.id } });
    return { verified: false, session: current!, reason: "no_new_card_yet" };
  }

  const paymentMethodId = await storeCard(session, fresh);

  // Conditional, so two concurrent polls cannot both claim the session. The
  // loser reads back the winner's result rather than storing a second card.
  const claimed = await prisma.tokenizationSession.updateMany({
    where: { id: session.id, status: { in: ["AWAITING_RETURN", "PENDING"] } },
    data: {
      status: "VERIFIED",
      resolvedFingerprint: fingerprint(fresh.token),
      paymentMethodId,
      lastVerifiedAt: now,
    },
  });

  const updated = await prisma.tokenizationSession.findUnique({ where: { id: session.id } });
  if (claimed.count !== 1) {
    // Someone else won. Drop the duplicate we just created.
    await prisma.paymentMethod.delete({ where: { id: paymentMethodId } }).catch(() => {});
    return {
      verified: true,
      session: updated!,
      paymentMethodId: updated!.paymentMethodId ?? paymentMethodId,
      isNewCard: false,
    };
  }

  return { verified: true, session: updated!, paymentMethodId, isNewCard: true };
}

/**
 * Persist the card.
 *
 * The token is encrypted with the dedicated payment-token key, and the key
 * version is recorded alongside it so rotation does not orphan existing rows.
 * Everything else kept is card metadata a customer would recognize - brand and
 * last four - and never anything that could reconstruct a number.
 */
async function storeCard(session: TokenizationSession, card: StoredCard): Promise<string> {
  const profile = await resolveBillingProfile(session.tenantId);

  const encrypted = encryptPaymentToken(card.token);
  const created = await prisma.paymentMethod.create({
    data: {
      billingProfileId: profile,
      provider: "ICOUNT",
      token: encrypted.ciphertext,
      tokenKeyVersion: encrypted.keyVersion ?? CURRENT_PAYMENT_TOKEN_KEY_VERSION,
      brand: card.brand ?? null,
      last4: card.last4 ?? null,
      expMonth: card.expMonth ?? null,
      expYear: card.expYear ?? null,
      status: "ACTIVE",
      isDefault: true,
    },
  });

  // Exactly one default. Two would make "which card gets charged at renewal"
  // depend on query order.
  await prisma.paymentMethod.updateMany({
    where: { billingProfileId: profile, id: { not: created.id }, isDefault: true },
    data: { isDefault: false },
  });

  return created.id;
}

async function resolveBillingProfile(tenantId: string): Promise<string> {
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId } });
  if (!link) throw new TokenizationRefused("no_billable_entity");

  const existing = await prisma.billingProfile.findFirst({
    where: { billableEntityId: link.billableEntityId },
  });
  if (existing) return existing.id;

  const created = await prisma.billingProfile.create({
    data: { billableEntityId: link.billableEntityId },
  });
  return created.id;
}

async function listCards(query: { clientId?: string | null; customClientId?: string | null }): Promise<StoredCard[]> {
  if (!icountProvider.listStoredCards) return [];
  if (!query.clientId && !query.customClientId) return [];
  try {
    return await icountProvider.listStoredCards({
      clientId: query.clientId ?? undefined,
      customClientId: query.customClientId ?? undefined,
    });
  } catch {
    // A failed lookup means we do not know, which is exactly "no new card yet".
    // Treating it as failure would abandon a customer whose card was stored.
    return [];
  }
}

async function fail(
  id: string,
  status: "FAILED" | "EXPIRED" | "ABANDONED",
  reason: string,
): Promise<TokenizationSession> {
  return prisma.tokenizationSession.update({
    where: { id },
    data: { status, failureReason: reason },
  });
}

/** Sweep sessions nobody finished. Expiry is still enforced on read. */
export async function expireStaleSessions(now: Date = new Date()): Promise<number> {
  const res = await prisma.tokenizationSession.updateMany({
    where: { status: { in: ["PENDING", "AWAITING_RETURN"] }, expiresAt: { lte: now } },
    data: { status: "EXPIRED", failureReason: "session_expired" },
  });
  return res.count;
}

/** The live session for a checkout, if one is still open. */
export async function sessionForCheckout(
  checkoutId: string,
  now: Date = new Date(),
): Promise<TokenizationSession | null> {
  return prisma.tokenizationSession.findFirst({
    where: {
      checkoutId,
      status: { in: ["PENDING", "AWAITING_RETURN", "VERIFIED"] },
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
}
