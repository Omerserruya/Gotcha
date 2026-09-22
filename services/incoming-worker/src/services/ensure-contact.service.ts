/**
 * Create a Contact from the channel the customer is talking through.
 *
 * A customer never had to type an identifier for us to have one. A WhatsApp
 * message carries a phone number by definition; an Instagram DM carries an
 * account. The envelope always had it - `tryLinkIdentifierFromInbound` was
 * scanning the message BODY for an email or phone while the identity sat in
 * the sender field. So contacts only existed for the few customers who happened
 * to type one: 89 conversations, 2 contacts.
 *
 * WHY THIS IS NOT IN `resolveContactByChannelId`.
 * That resolver is shared and has six callers, three of which must never create
 * anything: the outgoing-worker's scheduled send, historical import, and the AI
 * identity stage. A resolver that creates would mint customer records from an
 * OUTBOUND message and from imported history - conversations that, by the
 * schema's own words, were "never routed, never assigned, never answered".
 * Creation belongs on the inbound path only. The resolver stays a read.
 *
 * DUPLICATION IS STRUCTURALLY IMPOSSIBLE, not defended against.
 * `Contact` has @@unique([tenantId, channel, externalId]) and this upserts on
 * it, so two inbound messages racing for a new sender produce one row.
 *
 * MERGES ARE HONOURED BY DOING NOTHING SPECIAL. `resolveContactByChannelId`
 * already follows `mergedIntoId`, so a merged-away sender resolves to the
 * surviving target and never reaches the create. Only a genuine null - no row
 * at all for that identifier - creates.
 *
 * IT CANNOT FAIL THE MESSAGE. Every error is caught and null returned, leaving
 * the caller in exactly the state it had before contacts existed. An inbound
 * message that is not stored because a CRM row could not be written is a
 * catastrophic trade for a customer record.
 *
 * Awaited, unlike the `lastInteractionAt` write, because the caller uses the
 * result immediately for display name and avatar. Fire-and-forget would leave
 * this message referencing a contact that does not exist yet.
 */
import { prisma, resolveContactByChannelId } from "@chatcenter/shared";
import type { Contact, ChannelType } from "@prisma/client";

/**
 * `phone` is populated for WHATSAPP only, because there the externalId IS the
 * phone number - leaving the column empty when the value is sitting in the
 * identifier is the same defect as a count that ignores what it can see.
 *
 * `phoneVerified` stays false: the customer messaged us, they did not prove the
 * number to us.
 *
 * For MESSENGER and INSTAGRAM the externalId is an opaque page-scoped id, not a
 * contact method. Writing it into `phone` would put an unusable string in a
 * column that other code dials and matches on.
 */
function channelPhone(channel: ChannelType, externalId: string): string | null {
  return channel === "WHATSAPP" ? externalId : null;
}

export async function ensureContactForInbound(args: {
  tenantId: string;
  channel: ChannelType;
  externalId: string;
  displayName?: string | null;
}): Promise<Contact | null> {
  const { tenantId, channel, externalId } = args;
  if (!tenantId || !channel || !externalId) return null;

  try {
    // The read that already happened here, unchanged - including its
    // merge-following behaviour.
    const existing = await resolveContactByChannelId(tenantId, channel, externalId);
    if (existing) return existing;

    const displayName = args.displayName?.trim() || null;

    return await prisma.contact.upsert({
      where: { tenantId_channel_externalId: { tenantId, channel, externalId } },
      create: {
        tenantId,
        channel,
        externalId,
        displayName,
        phone: channelPhone(channel, externalId),
        // Names the path that created it, so a contact that appeared because
        // someone messaged is distinguishable from one typed in or imported.
        source: `inbound:${String(channel).toLowerCase()}`,
        // The message being processed IS an interaction. Without this the row
        // is created with a null sort key and the customer list places a
        // brand-new contact last until their second message.
        lastInteractionAt: new Date(),
      },
      // Lost the race to a concurrent inbound: take the row that won rather
      // than overwrite anything it set.
      update: {},
    });
  } catch (err: unknown) {
    console.warn(
      "[incoming] contact provisioning failed (message unaffected):",
      (err as { message?: string })?.message ?? err,
    );
    return null;
  }
}
