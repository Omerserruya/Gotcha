/**
 * Conversations whose channel account was deleted (prod 2026-11-14).
 *
 * Removing a WhatsApp number deletes its channel_accounts row
 * (auth whatsapp/health.service.ts), and conversations.channel_account_id is
 * ON DELETE SET NULL so the record of what was said survives. Re-onboarding
 * the same number creates a NEW row, and nothing pointed the old
 * conversations at it. Inbound still landed (it matches tenant, channel and
 * customer) and the bot still replied (it sends on the inbound job's
 * account), but every inbox send read conversation.channelAccount and got
 * 400 "Channel not configured for this tenant": GOTCHA, 237 open WhatsApp
 * conversations.
 *
 * The rule everywhere here: a detached conversation is re-pointed only to
 * the tenant's ONE active account on that channel. With none or several the
 * choice is not ours to guess, and nothing changes.
 */

type Db = {
  channelAccount: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  conversation: { updateMany: (args: any) => Promise<{ count: number }> };
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
};

const ACTIVE = { isActive: true, connectionStatus: "CONNECTED" } as const;

/** The tenant's single active, connected account on a channel, or null when there is none or more than one. */
export async function singleActiveChannelAccountId(db: Db, tenantId: string, channel: string): Promise<string | null> {
  const rows = await db.channelAccount.findMany({
    where: { tenantId, channel, ...ACTIVE },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * A (re)connected account adopts the tenant's detached conversations on its
 * channel, when no OTHER active account of that tenant is on the channel.
 * The new account itself may still be PENDING (onboarding proves it later),
 * so it is excluded from the count rather than required to be CONNECTED.
 *
 * Detached rows only (channel_account_id IS NULL): a conversation that
 * belongs to another account is never moved.
 */
export async function adoptDetachedConversations(
  db: Db,
  args: { tenantId: string; channel: string; channelAccountId: string },
): Promise<number> {
  const others = await db.channelAccount.findMany({
    where: { tenantId: args.tenantId, channel: args.channel, isActive: true, id: { not: args.channelAccountId } },
    select: { id: true },
    take: 1,
  });
  if (others.length > 0) return 0;
  // Raw SQL on purpose: Prisma's @updatedAt would stamp every adopted row,
  // and a reconnect would lift hundreds of old conversations to the top of
  // the inbox. Re-pointing the account is not activity; updated_at stays.
  // (No trigger touches conversations.updated_at; it is Prisma-side only.)
  return db.$executeRaw`
    UPDATE conversations SET channel_account_id = ${args.channelAccountId}
    WHERE tenant_id = ${args.tenantId} AND channel::text = ${args.channel} AND channel_account_id IS NULL`;
}

/**
 * One detached conversation takes the account it is being used through:
 * inbound passes the account the message arrived on; a send passes the
 * tenant's single active account. Guarded on NULL, so a concurrent attach
 * is never overwritten.
 */
export async function attachConversationAccount(
  db: Db,
  args: { tenantId: string; conversationId: string; channelAccountId: string },
): Promise<boolean> {
  const r = await db.conversation.updateMany({
    where: { id: args.conversationId, tenantId: args.tenantId, channelAccountId: null },
    data: { channelAccountId: args.channelAccountId },
  });
  return r.count === 1;
}

/**
 * Which open conversations a message on `channelAccountId` may land in
 * (prod GOTCHA 2026-11-16). Two WhatsApp numbers on one tenant shared
 * conversations: a customer writing to the NEW number landed in the thread of
 * the OLD one, and the inbox replied from the old number. A conversation is a
 * (tenant, channel, ACCOUNT, customer) thing whenever the tenant has more than
 * one account of that channel.
 *
 * - No account on the message (old jobs, channels without accounts): {} (as before).
 * - No OTHER active account of that channel on the tenant: {} (as before, so
 *   detached rows still match and are re-attached by the caller).
 * - Another active account exists: only this account's conversations. A
 *   detached (NULL) row is never guessed into one of several numbers.
 *
 * Spread the result into the conversation `where`.
 */
export async function conversationAccountScope(
  db: Pick<Db, "channelAccount">,
  args: { tenantId: string; channel: string; channelAccountId?: string | null },
): Promise<{ channelAccountId?: string }> {
  if (!args.channelAccountId) return {};
  try {
    const others = await db.channelAccount.findMany({
      where: { tenantId: args.tenantId, channel: args.channel, isActive: true, id: { not: args.channelAccountId } },
      select: { id: true },
      take: 1,
    });
    return others.length > 0 ? { channelAccountId: args.channelAccountId } : {};
  } catch (err) {
    // Unreadable accounts: the lookup stays as it was before this rule, never lost.
    console.warn("[channel-account] scope read failed, unscoped lookup:", (err as Error)?.message);
    return {};
  }
}
