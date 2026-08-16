import { prisma } from "./prisma";

/**
 * Numbers the owner keeps on their own phone.
 *
 * A WhatsApp number running in Coexistence delivers EVERY conversation to us,
 * including the ones that were never meant for the shared inbox - the
 * accountant, a supplier, family using the business line. Without a way to say
 * "that one is mine", the only choices were letting private threads into a
 * team inbox or not connecting Coexistence at all.
 *
 * An exclusion is enforced at ingest, before any Conversation, Contact or
 * Message row exists. That is the whole point: filtering later would already
 * have created the thread, notified an agent, and possibly answered with a bot.
 */

/**
 * Reduce a phone number to the digits that identify it.
 *
 * Channels are inconsistent about formatting - WhatsApp sends `972541111111`,
 * a person types `+972-54-111-1111` or `054-111-1111` - and a rule that only
 * matched one spelling would look broken at random. Digits only, so the
 * comparison cannot miss on punctuation.
 *
 * Leading zeros are preserved rather than guessed at: `0541111111` and
 * `972541111111` are stored as written. Turning a local number into E.164
 * requires knowing the country, we do not reliably know it here, and guessing
 * wrong would silently exclude a DIFFERENT customer - a worse failure than
 * asking the owner to enter the number the way the channel reports it.
 */
export function normalizeExclusionValue(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

/** A human-readable label for a rule, falling back to the normalized digits. */
export function exclusionDisplayValue(raw: string): string {
  const trimmed = (raw || "").trim();
  return trimmed.slice(0, 40) || normalizeExclusionValue(raw);
}

export interface ExclusionLookup {
  tenantId: string;
  channel: string;
  /** The customer's id as the channel reported it. Normalized here. */
  customerExternalId: string;
  /** Which account received it. Used to honour account-scoped rules. */
  channelAccountId?: string | null;
}

/**
 * True when this sender must not enter the system.
 *
 * A rule with `channelAccountId: null` covers every account on the channel; a
 * rule naming an account covers only that one. A tenant with two WhatsApp
 * numbers usually wants the exclusion on the one that runs in the app, and a
 * rule that leaked onto the other number would silently drop real customers.
 */
export async function isInboundExcluded(lookup: ExclusionLookup): Promise<boolean> {
  const normalized = normalizeExclusionValue(lookup.customerExternalId);
  // An empty id cannot be matched against anything. Returning false rather
  // than "no rows, therefore excluded" keeps the failure open, which is the
  // right direction here: dropping a real customer is worse than admitting one
  // the owner wanted kept out, and the latter is visible while the former is not.
  if (!normalized) return false;

  const rule = await prisma.inboundExclusion.findFirst({
    where: {
      tenantId: lookup.tenantId,
      channel: lookup.channel as any,
      customerExternalId: normalized,
      OR: [
        { channelAccountId: null },
        ...(lookup.channelAccountId ? [{ channelAccountId: lookup.channelAccountId }] : []),
      ],
    },
    select: { id: true },
  });
  return !!rule;
}
