/**
 * What a hand mark did to its sender (2026-11-22): the `senderRule` field of PUT /conversations/:id/relevance.
 *
 * The rule itself is the ai's (services/ai conversation-relevance.service.ts, senderMarkedPersonal): a new
 * conversation comes in as personal when the newest hand mark on the same sender (same tenant, channel and
 * sender id) is "personal". The inbox draws a line under a mark only when this field says so, and that line
 * promises something about the person's later conversations. So the field is said only where the rule really
 * reads the mark, and it is left out in every other case.
 *
 * This file mirrors the three conditions of that read. A change to one of them there is a change here.
 */
import { relevanceChannel } from "@chatcenter/shared/src/lib/conversation-relevance";

export type SenderRuleEffect = "applied" | "lifted";

/** The rule stays out of email: one address is not one person there (a form mailer, a relay, a shared mailbox). */
const EMAIL_CHANNEL = /^(?:EMAIL|GMAIL|OUTLOOK)$/i;

/** The sender's id as a channel may have stored it: a number with and without the leading "+". */
export function senderIds(externalId: unknown): string[] {
  const raw = String(externalId ?? "").trim();
  const bare = raw.replace(/^\+/, "");
  if (!bare) return [];
  return /^\d+$/.test(bare) ? [bare, `+${bare}`] : [raw];
}

/**
 * Does the rule read marks on this conversation's sender at all? A channel the relevance filter applies to,
 * not email, a sender id, and the channel account's filter not switched off (off: nothing on that account is
 * labelled, so a mark changes nothing for the sender's later conversations).
 */
export function senderRuleReads(c: { channel?: unknown; customerExternalId?: unknown; channelAccount?: { relevanceFilterEnabled?: boolean | null } | null }): boolean {
  const channel = String(c.channel ?? "");
  if (!relevanceChannel(channel) || EMAIL_CHANNEL.test(channel)) return false;
  if (c.channelAccount?.relevanceFilterEnabled === false) return false;
  return senderIds(c.customerExternalId).length > 0;
}

/**
 * The effect of one mark. `newestBefore` is the sender's newest hand mark before this one, on any of the sender's
 * conversations on this channel (this conversation's own earlier mark included): what the rule went by until now.
 *  - "personal": the rule now labels this sender's new conversations personal ("applied").
 *  - "business" over a newest mark of "personal": the rule stops doing that ("lifted").
 *  - anything else (a first business mark, a business mark over a business mark): nothing changed, nothing said.
 */
export function senderRuleEffect(category: string, reads: boolean, newestBefore: string | null | undefined): SenderRuleEffect | undefined {
  if (!reads) return undefined;
  if (category === "personal") return "applied";
  if (category === "business" && newestBefore === "personal") return "lifted";
  return undefined;
}
