/**
 * Cleaning up what checkout leaves behind.
 *
 * Taking a payment produces artifacts that stop being useful long before the
 * payment record does: half-finished tokenization sessions, spent one-time
 * links, conversions that were quoted and never charged. Left alone they grow
 * without bound, and two of them hold things worth not keeping - an opaque
 * customer reference the provider files cards under, and hashes of card tokens.
 *
 * The line this file draws, and does not cross: **anything that records money
 * moving is never deleted here.** A consumed quote is the evidence of what a
 * customer was charged and at what rate. Charges, attempts, invoices and
 * subscriptions are financial records with their own retention obligations.
 * This only removes artifacts of payments that did not happen, and identifiers
 * belonging to payments that did but no longer need them.
 *
 * Deliberately in billing rather than the platform retention engine: billing
 * owns these tables, and a purge that reaches across a service boundary is a
 * purge nobody maintaining that boundary will remember exists.
 */
import { prisma } from "@chatcenter/shared";

/** Days before a finished tokenization session is deleted. */
export const SESSION_RETENTION_DAYS = numberFromEnv("BILLING_RETENTION_TOKENIZATION_DAYS", 90);

/** Days before a spent or expired continuation link is deleted. */
export const LINK_RETENTION_DAYS = numberFromEnv("BILLING_RETENTION_CONTINUATION_LINK_DAYS", 90);

/** Days before an unused quote is deleted. Consumed quotes are kept forever. */
export const UNUSED_QUOTE_RETENTION_DAYS = numberFromEnv("BILLING_RETENTION_UNUSED_QUOTE_DAYS", 30);

/** A bound per run, so a first purge on a large table cannot stall the tick. */
export const MAX_PER_RUN = 500;

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface PurgeResult {
  tokenizationSessions: number;
  continuationLinks: number;
  unusedQuotes: number;
}

/**
 * Delete finished artifacts past their retention window.
 *
 * Every deletion below is scoped to a TERMINAL state as well as an age. Age
 * alone would delete a session belonging to a customer who is still on the
 * hosted page - slow, not abandoned - and strand them the same way a lost
 * customer reference does.
 */
export async function purgeSpentCheckoutArtifacts(now: Date = new Date()): Promise<PurgeResult> {
  const result: PurgeResult = { tokenizationSessions: 0, continuationLinks: 0, unusedQuotes: 0 };

  // Sessions that finished, one way or another. The card token itself never
  // lived here - only a hash - but the customer reference does, and it is the
  // handle the provider files stored cards under.
  const sessions = await prisma.tokenizationSession.findMany({
    where: {
      status: { in: ["VERIFIED", "FAILED", "EXPIRED", "ABANDONED"] },
      updatedAt: { lt: daysAgo(SESSION_RETENTION_DAYS, now) },
    },
    select: { id: true },
    take: MAX_PER_RUN,
  });
  if (sessions.length) {
    result.tokenizationSessions = (
      await prisma.tokenizationSession.deleteMany({ where: { id: { in: sessions.map((s) => s.id) } } })
    ).count;
  }

  // Links that can no longer be used. Only a hash is stored, so this is
  // housekeeping rather than a privacy matter - but an unbounded table of
  // credentials-shaped rows is worth not having either.
  const links = await prisma.paymentContinuationLink.findMany({
    where: {
      OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: now } }],
      createdAt: { lt: daysAgo(LINK_RETENTION_DAYS, now) },
    },
    select: { id: true },
    take: MAX_PER_RUN,
  });
  if (links.length) {
    result.continuationLinks = (
      await prisma.paymentContinuationLink.deleteMany({ where: { id: { in: links.map((l) => l.id) } } })
    ).count;
  }

  // Quotes that were frozen and never charged against. A CONSUMED quote is
  // excluded by status, and belt-and-braces by consumedByAttemptId: it is the
  // record of what a customer actually paid and at what rate, and deleting one
  // would make a real charge unexplainable.
  const quotes = await prisma.paymentQuote.findMany({
    where: {
      status: { in: ["EXPIRED", "SUPERSEDED"] },
      consumedByAttemptId: null,
      createdAt: { lt: daysAgo(UNUSED_QUOTE_RETENTION_DAYS, now) },
    },
    select: { id: true },
    take: MAX_PER_RUN,
  });
  if (quotes.length) {
    result.unusedQuotes = (
      await prisma.paymentQuote.deleteMany({
        where: { id: { in: quotes.map((q) => q.id) }, consumedByAttemptId: null },
      })
    ).count;
  }

  return result;
}
