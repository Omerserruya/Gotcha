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
import { defaultProvider } from "../providers";
import { icountPaymentPageId } from "../providers/icount-config";
import { assertTokenizationPage } from "../providers/icount-paypage";
import type { StoredCard } from "../providers/provider";

/**
 * The configured provider, resolved per call.
 *
 * Not a direct import of the iCount adapter. The provider interface exists so
 * that swapping providers is a config change rather than a rewrite, and a
 * service reaching past it for a named implementation makes that claim quietly
 * untrue - which is how an abstraction becomes decoration while still being
 * described in its own header.
 *
 * Resolved at CALL time so tests and runtime configuration are honoured.
 */
function provider() {
  return defaultProvider();
}

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

/**
 * How long a page is trusted after it checks out.
 *
 * Short enough that a page changed in iCount stops being used fairly quickly,
 * long enough that a busy checkout does not query the provider on every click.
 */
const PAGE_CHECK_TTL_MS = 10 * 60 * 1000;

/** Only successes are cached - see assertPageStoresCards. */
const pageChecked = new Map<string, number>();

/**
 * Refuse to send anyone to a page that would charge them.
 *
 * The check existed and nothing called it, which made it decoration. The risk
 * it describes is concrete: a page of type `invrec` charges the customer
 * immediately instead of storing their card, and an `hk_page` standing order
 * makes iCount a second renewal owner billing the same customer every month
 * alongside us.
 *
 * A FAILED check is deliberately not cached, so fixing the configuration in
 * iCount takes effect immediately rather than after a timeout.
 */
async function assertPageStoresCards(pageId: string): Promise<void> {
  const seen = pageChecked.get(pageId);
  if (seen && Date.now() - seen < PAGE_CHECK_TTL_MS) return;
  // Bound once: resolving twice would let the guard and the call disagree about
  // which provider they are talking to.
  const p = provider();
  if (!p.describePaymentPage) return;

  let page;
  try {
    page = await p.describePaymentPage(pageId);
  } catch (err) {
    // Could not ask. Fail closed: sending someone to a page we cannot verify is
    // how an unintended charge happens, and a delayed checkout is recoverable.
    throw new TokenizationRefused("payment_page_unverified", (err as Error)?.message);
  }

  try {
    assertTokenizationPage(page as any);
  } catch (err) {
    throw new TokenizationRefused("payment_page_misconfigured", (err as Error)?.message);
  }

  pageChecked.set(pageId, Date.now());
}

/** Clear the page-validity cache. For tests and for a config change. */
export function forgetPaymentPageChecks(): void {
  pageChecked.clear();
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
  /** Where the customer lands if they abandon the hosted page. */
  cancelUrl?: string;
  /** Checkout reference, echoed to the provider for reconciliation only. */
  orderId?: string;
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

  await assertPageStoresCards(pageId);

  const customClientId = newCustomClientId();

  // Baseline first. Doing this after creating the session would leave a window
  // where a card stored in between looks like it was always there.
  const existing = await listCards({ clientId: input.providerClientId, customClientId });
  const baseline = existing.map((c) => fingerprint(c.token));

  const start = await provider().startTokenization!({
    pageId,
    customClientId,
    clientName: input.customerName,
    email: input.customerEmail,
    successUrl: input.successUrl,
    failureUrl: input.failureUrl,
    cancelUrl: input.cancelUrl,
    orderId: input.orderId,
  });

  const session = await prisma.tokenizationSession.create({
    data: {
      tenantId: input.tenantId,
      checkoutId: input.checkoutId ?? null,
      customClientId,
      // The id the provider just established wins over whatever the caller
      // guessed. Without it the session - and later the billing profile - has
      // no provider-side customer to attribute a charge to.
      providerClientId: start.providerClientId ?? input.providerClientId ?? null,
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
    // Someone else won. Drop the duplicate we just created. It is not the
    // default and never touched any other row, so deleting it leaves the
    // winner's card exactly as the winner left it.
    await prisma.paymentMethod.delete({ where: { id: paymentMethodId } }).catch(() => {});
    return {
      verified: true,
      session: updated!,
      paymentMethodId: updated!.paymentMethodId ?? paymentMethodId,
      isNewCard: false,
    };
  }

  // Only the poll that WON the session promotes its card, and only once the
  // win is settled. Promoting at creation time meant a LOSING poll cleared the
  // winner's flag on its way to deleting its own row, leaving the profile with
  // a card and no default at all.
  await promoteToDefault(paymentMethodId);

  return { verified: true, session: updated!, paymentMethodId, isNewCard: true };
}

/**
 * Make this card the profile's only default.
 *
 * Both statements run in one transaction: a window with two defaults, or none,
 * would make "which card gets charged at renewal" depend on query order.
 */
async function promoteToDefault(paymentMethodId: string): Promise<void> {
  const card = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { billingProfileId: true },
  });
  if (!card) return;

  await prisma.$transaction([
    prisma.paymentMethod.updateMany({
      where: { billingProfileId: card.billingProfileId, id: { not: paymentMethodId }, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.paymentMethod.update({ where: { id: paymentMethodId }, data: { isDefault: true } }),
  ]);
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

  // Carry the provider's customer id onto the profile. The charge path reads
  // it from there, and a profile without one makes every charge unattributable
  // no matter how correctly the card itself was stored.
  //
  // Only filled when empty. Overwriting an existing id would silently move a
  // profile's billing history to a different provider-side customer.
  // Conditional in the WHERE rather than read-then-write, so two sessions
  // finishing at once cannot race one another's id in.
  if (session.providerClientId) {
    await prisma.billingProfile.updateMany({
      where: {
        id: profile,
        OR: [{ providerCustomerId: null }, { providerCustomerId: "" }],
      },
      data: { providerCustomerId: session.providerClientId },
    });
  }

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
      // NOT the default yet. This row may still lose the session claim and be
      // deleted, and a card that is about to be deleted must not be the one
      // renewal would charge. `promoteToDefault` runs once the claim is won.
      isDefault: false,
    },
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

  try {
    const created = await prisma.billingProfile.create({
      data: { billableEntityId: link.billableEntityId },
    });
    return created.id;
  } catch (err: any) {
    // Concurrent verifications race here - the customer's browser polls, and
    // several polls can find no profile at the same moment. The unique index on
    // billableEntityId settles it; the loser reads the winner's row rather than
    // failing a verification that actually succeeded.
    if (err?.code !== "P2002") throw err;
    const raced = await prisma.billingProfile.findFirst({
      where: { billableEntityId: link.billableEntityId },
    });
    if (!raced) throw err;
    return raced.id;
  }
}

async function listCards(query: { clientId?: string | null; customClientId?: string | null }): Promise<StoredCard[]> {
  const p = provider();
  if (!p.listStoredCards) return [];
  if (!query.clientId && !query.customClientId) return [];
  try {
    return await p.listStoredCards({
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

/**
 * Get a fresh hosted-page URL for a session that already exists.
 *
 * Deliberately NOT a new session. The customer reference is what the provider
 * files a stored card under, so a second click that minted a new reference
 * would leave a customer who entered their card against the first one stranded:
 * their card exists, and we would be looking in the wrong place for it.
 *
 * Regenerating against the SAME reference means a card stored via either URL
 * lands where we are watching, and the baseline captured at the start still
 * describes what they had before.
 */
export async function resumeTokenizationSession(
  session: TokenizationSession,
  opts: { successUrl?: string; failureUrl?: string } = {},
): Promise<string> {
  const start = await provider().startTokenization!({
    pageId: session.pageId,
    customClientId: session.customClientId,
    successUrl: opts.successUrl,
    failureUrl: opts.failureUrl,
  });
  await prisma.tokenizationSession.update({
    where: { id: session.id },
    data: { status: "AWAITING_RETURN" },
  });
  return start.saleUrl;
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
