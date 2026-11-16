import { prisma as defaultPrisma, withHistoricalRecords } from "@chatcenter/shared";

/**
 * A new conversation starts human-owned when the owner wrote to this customer
 * from the phone recently (Omer, 2026-11-14).
 *
 * Smoovee prod 2026-11-13, conv cmweyp0940r1wkdj39ue69ui0: the owner talked
 * with a customer from the WhatsApp Business app at 06:47, before the number
 * was connected, so that thread came in only as imported history (CLOSED).
 * The customer answered at 12:37, a fresh live conversation opened, and the
 * bot stepped into a conversation the owner was running. A takeover by echo
 * (outbound-echo.service) cannot catch that: the owner had not written since.
 *
 * "From the phone" is one of:
 *   - an echo of a message sent from the Business app (Coexistence);
 *   - an outbound message in imported history: before the connection, every
 *     business-side message was sent from the app.
 * GOTCHA's own sends (the bot, an agent in the inbox) are not the owner on
 * the phone, so they never count.
 *
 * Only the start is decided here. Once human-owned, the conversation stays so
 * until someone hands it back, as with any takeover: there is no timer.
 */
export const OWNER_RECENT_MS = 24 * 60 * 60 * 1000;

export async function ownerWroteRecently(args: {
  tenantId: string;
  channel: string;
  customerExternalId: string;
  /** With two numbers on the channel, only the owner's writes on THIS number count. */
  accountScope?: { channelAccountId?: string };
  now?: Date;
  db?: typeof defaultPrisma;
}): Promise<boolean> {
  if (args.channel !== "WHATSAPP") return false;
  const db = args.db ?? defaultPrisma;
  const since = new Date((args.now ?? new Date()).getTime() - OWNER_RECENT_MS);
  // History included on purpose: the imported thread is exactly where the
  // owner's last message sits right after a connection.
  const last = await withHistoricalRecords(() => db.message.findFirst({
    where: {
      tenantId: args.tenantId,
      channel: args.channel as any,
      direction: "OUTBOUND",
      createdAt: { gte: since },
      conversation: { customerExternalId: args.customerExternalId, ...(args.accountScope ?? {}) },
      OR: [
        { origin: "HISTORICAL_IMPORT" },
        { metadata: { path: ["source"], equals: "whatsapp_business_app" } },
      ],
    } as any,
    select: { id: true },
  }));
  return !!last;
}
