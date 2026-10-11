import { prisma, getRedis } from "@chatcenter/shared";

/**
 * One inbound message, one conversation, one AI turn - even when the provider
 * delivers it twice.
 *
 * Found 2026-10-11: ONE Instagram DM produced two conversations, two message
 * rows and two AI replies sent to the customer. Meta delivered every event for
 * that account twice, ~400ms apart (two subscriptions on the same account), and
 * two workers raced through the old check-then-write steps:
 *   - `message.findFirst({ externalMessageId })` - both read "none", both wrote;
 *   - `conversation.findFirst(...)` then `create` - both read "none", both
 *     created, 18ms apart.
 * Neither layer had a unique index to fall back on, and adding one is a
 * migration on two of the largest tables. These need none.
 */

/** Long enough to cover a provider's retry window (Meta retries for up to a day). */
const CLAIM_TTL_SECONDS = 3 * 24 * 60 * 60;

function claimKey(tenantId: string, channel: string, externalMessageId: string): string {
  return `inbound:claim:${tenantId}:${channel}:${externalMessageId}`;
}

export type InboundClaim = "claimed" | "duplicate" | "unclaimable";

/**
 * Claim an inbound message before anything else happens to it. The first
 * delivery gets "claimed"; every later one, concurrent or not, gets "duplicate"
 * and must be dropped without a contact, a conversation, a notification or an
 * AI turn.
 *
 * "unclaimable" (no id, or Redis unreachable) means proceed on the database
 * check alone: losing a customer's message is worse than a rare duplicate.
 */
export async function claimInboundMessage(args: {
  tenantId: string;
  channel: string;
  externalMessageId: string | null | undefined;
}): Promise<InboundClaim> {
  if (!args.externalMessageId) return "unclaimable";
  try {
    const set = await getRedis().set(
      claimKey(args.tenantId, args.channel, args.externalMessageId),
      "1",
      "EX",
      CLAIM_TTL_SECONDS,
      "NX",
    );
    return set === "OK" ? "claimed" : "duplicate";
  } catch (err) {
    console.warn("[inbound-dedupe] claim unavailable, falling back to the database check:", (err as Error)?.message);
    return "unclaimable";
  }
}

/**
 * Give a claim back when processing failed, so the job's retry is not mistaken
 * for a duplicate. If the message row was already written, the database check
 * stops the retry instead.
 */
export async function releaseInboundClaim(args: {
  tenantId: string;
  channel: string;
  externalMessageId: string | null | undefined;
}): Promise<void> {
  if (!args.externalMessageId) return;
  try {
    await getRedis().del(claimKey(args.tenantId, args.channel, args.externalMessageId));
  } catch { /* the TTL ends it */ }
}

/**
 * The customer's open conversation on this channel, or a new one, race-safe.
 *
 * The lookup and the create run in one transaction under an advisory lock on
 * (tenant, channel, customer), so two inbound messages from the same customer
 * at the same moment (two deliveries, or two quick messages) cannot both find
 * nothing and both create. The key is the lookup's own: the same rule as
 * before, made atomic. The lock ends with the transaction.
 */
export async function findOrCreateOpenConversation<T extends { id: string }>(args: {
  tenantId: string;
  channel: string;
  customerExternalId: string;
  create: Record<string, unknown>;
}): Promise<{ conversation: T; created: boolean }> {
  const lockKey = `conv:${args.tenantId}:${args.channel}:${args.customerExternalId}`;
  return (prisma as any).$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const existing = await tx.conversation.findFirst({
      where: {
        tenantId: args.tenantId,
        channel: args.channel,
        customerExternalId: args.customerExternalId,
        status: { not: "CLOSED" },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { conversation: existing as T, created: false };
    const conversation = await tx.conversation.create({ data: args.create });
    return { conversation: conversation as T, created: true };
  });
}
