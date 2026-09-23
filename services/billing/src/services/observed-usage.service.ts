/**
 * What this tenant's conversations have ACTUALLY cost, from the ledger.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT IN packages/shared/src/lib/billing/estimation.ts
 *
 * That module is the PUBLIC COMMERCIAL estimate - the ratio an operator typed
 * in, which decides what a pricing page says and what a plan promises. Its
 * header states the invariant plainly: it is never derived from actual usage,
 * "nothing in this file reads those tables, and nothing may". That rule exists
 * because a commercial promise derived from live usage would quietly rewrite
 * itself as customers behaved differently.
 *
 * This is a different number for a different question. Not "what does GOTCHA
 * sell" but "at the rate THIS tenant has actually been burning credits, how
 * much runway is left". It belongs on their own usage screen, never on a
 * pricing page, and the two must never be substituted for one another - so the
 * response carries both, each labelled with its basis.
 *
 * ── The window is trailing, not the billing period ──
 *
 * A rate needs a sample. The billing period resets, and the morning after a
 * reset it holds a handful of conversations, which is exactly when a
 * projection is least reliable and most likely to be believed. A trailing
 * 30-day window always has the same amount of evidence behind it.
 *
 * ── The numerator is ALL consumption, deliberately ──
 *
 * 817 of the 1,078 CONSUME entries on this database name a conversation in
 * `referenceId` (tenant-consistent - zero name another tenant's), so a
 * conversation-only numerator is available. It is the wrong one. The rest of
 * the burn is embeddings, knowledge resolution and retries that conversations
 * CAUSE without being tagged with, and excluding it would quote a cheaper
 * conversation than the tenant really has, so the credits would run out before
 * the screen said they would. All-in burn over conversations errs the other
 * way: a shorter runway than reality, which is the safe direction to be wrong
 * about money.
 *
 * The cost of that choice is named in the response: `conversationAttributedPct`
 * says how much of the burn actually names a conversation, so a tenant whose
 * spend is mostly voice can be shown a caveat rather than a confident wrong
 * number.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@chatcenter/shared";

/**
 * Below this many conversations there is no rate worth extrapolating - one
 * long conversation moves the average enough to change the answer materially.
 */
export const MIN_SAMPLE_CONVERSATIONS = 20;

/** How far back the rate is measured. */
export const OBSERVED_WINDOW_DAYS = 30;

export type ObservedReason = "not_enough_conversations" | "no_consumption_recorded";

export interface ObservedUsage {
  /** Credits this tenant burns per conversation, measured. Null when unknown. */
  creditsPerConversation: number | null;
  reason: ObservedReason | null;
  sample: {
    conversations: number;
    creditsConsumed: number;
    windowStart: string;
    windowEnd: string;
    /**
     * Share of the consumed credits whose ledger entry names a conversation.
     * Low means most of the burn is something else - voice, setup, background
     * work - and a per-conversation figure describes less of the bill than it
     * appears to.
     */
    conversationAttributedPct: number;
  };
}

/**
 * Measure the tenant's own credits-per-conversation over the trailing window.
 *
 * Never throws: this decorates a billing screen that must still render its
 * authoritative balance if the measurement fails.
 */
export async function observedConversationCost(
  tenantId: string,
  now = new Date(),
): Promise<ObservedUsage> {
  const windowStart = new Date(now.getTime() - OBSERVED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const empty = (reason: ObservedReason, conversations = 0, creditsConsumed = 0, pct = 0): ObservedUsage => ({
    creditsPerConversation: null,
    reason,
    sample: {
      conversations,
      creditsConsumed,
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      conversationAttributedPct: pct,
    },
  });

  try {
    const [entries, conversations] = await Promise.all([
      prisma.aiUnitLedgerEntry.findMany({
        where: {
          tenantId,
          entryType: "CONSUME",
          createdAt: { gte: windowStart, lte: now },
        },
        select: { units: true, referenceId: true },
      }),
      // The same billable population the allowance bar counts, so "conversations
      // used" and "credits per conversation" cannot disagree about what a
      // conversation is. Sandbox rows carry isTest=false, which is why the
      // external-id prefix is required and isTest alone is not enough.
      prisma.conversation.findMany({
        where: {
          tenantId,
          isTest: false,
          NOT: { customerExternalId: { startsWith: "sandbox:" } },
          createdAt: { gte: windowStart, lte: now },
        },
        select: { id: true },
      }),
    ]);

    // CONSUME units are stored negative. Absolute value is the spend.
    const credits = (v: unknown) => Math.abs(Number(v));
    const creditsConsumed = entries.reduce((sum, e) => sum + credits(e.units), 0);

    // Attribution is checked against this tenant's conversations AT LARGE, not
    // against the ones created inside the window. A conversation opened before
    // the window can still be burning credits inside it, and matching only
    // in-window conversations would report that spend as unattributed - making
    // the coverage figure look worse the longer a customer's conversations run.
    const referenced = [...new Set(entries.map((e) => e.referenceId).filter((r): r is string => !!r))];
    const known = referenced.length
      ? new Set(
          (
            await prisma.conversation.findMany({
              where: { tenantId, id: { in: referenced } },
              select: { id: true },
            })
          ).map((c) => c.id),
        )
      : new Set<string>();
    const attributed = entries.reduce(
      (sum, e) => (e.referenceId && known.has(e.referenceId) ? sum + credits(e.units) : sum),
      0,
    );
    const pct = creditsConsumed > 0 ? Math.round((attributed / creditsConsumed) * 100) : 0;

    if (creditsConsumed <= 0) return empty("no_consumption_recorded", conversations.length, 0, 0);
    if (conversations.length < MIN_SAMPLE_CONVERSATIONS) {
      return empty("not_enough_conversations", conversations.length, round2(creditsConsumed), pct);
    }

    return {
      creditsPerConversation: round2(creditsConsumed / conversations.length),
      reason: null,
      sample: {
        conversations: conversations.length,
        creditsConsumed: round2(creditsConsumed),
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString(),
        conversationAttributedPct: pct,
      },
    };
  } catch (err: any) {
    console.error("[billing/observed-usage] measurement failed:", err?.message ?? err);
    return empty("no_consumption_recorded");
  }
}

/**
 * How many more conversations the remaining credits buy at the tenant's own
 * measured rate. Null whenever the rate is unknown - the caller then shows the
 * plan-ratio estimate instead, labelled as such, rather than silently
 * presenting one as the other.
 */
export function remainingAtObservedRate(
  remainingCredits: number,
  observed: ObservedUsage,
): number | null {
  const per = observed.creditsPerConversation;
  if (per === null || !(per > 0) || !(remainingCredits > 0)) return null;
  return Math.floor(remainingCredits / per);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
