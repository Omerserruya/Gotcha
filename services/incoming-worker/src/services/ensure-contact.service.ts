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
import { prisma, resolveContactByChannelId, unifyContact } from "@chatcenter/shared";
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

/**
 * Give the new contact a `personId`, matching on PHONE ONLY.
 *
 * `Contact.personId` is what the customer view collapses on to show one human
 * rather than one row per channel. Two routes write it - `/identity/merge` and
 * `/identity/capture` - and both need a person to act, so on a tenant where
 * nobody has used them it is null everywhere and the collapse silently never
 * fires. This is the automatic path it was missing.
 *
 * WHY PHONE AND NOT EMAIL, and the reason is structural rather than a policy we
 * chose to follow. An identifier can reach `Contact` three ways:
 *
 *   channel-asserted  the WhatsApp sender number, from Meta's envelope. The
 *                     customer did not claim it; the platform asserted it.
 *   staff-asserted    /identity/capture and contacts CRUD. A human decided.
 *   customer-typed    historical-intelligence parsing an identifier out of
 *                     message text. Nobody confirmed anything.
 *
 * Merging strangers is only possible from the third. And the function that
 * parses message text, `discoverIdentifiers` in historical-intelligence/
 * identity.stage.ts, RETURNS `{ email?, instagram? }` - it has no phone in its
 * return type at all. So customer-typed input structurally cannot reach the
 * column matched on here. That holds even if someone later forgets why, which
 * is a better guarantee than remembering not to match email.
 *
 * THE GUARD IS FAIL-CLOSED. It requires a phone AND the absence of an email,
 * because `unifyContact` matches on every identifier the contact has: if this
 * path ever starts populating `email`, unification stops firing rather than
 * silently widening to the one axis that can merge two strangers. A caller that
 * goes quiet is a bug someone reports; one that quietly matches more is not.
 *
 * NOT called for an existing contact. `unifyContact` returns early once
 * `personId` is set, but reaching that early return still costs a query on
 * every inbound message forever, and the answer cannot change between messages.
 *
 * What this does NOT do: join WhatsApp to Instagram. An Instagram contact's
 * externalId is an opaque page-scoped id, so it has no phone and nothing here
 * can match it. That is the case the customer view advertises, and it stays
 * unsolved - there is no automatically-derived identifier the two channels
 * share. Anything claiming otherwise on a screen is claiming more than this.
 */
async function unifyOnChannelPhone(tenantId: string, contact: Contact): Promise<Contact> {
  if (!contact.phone || contact.email) return contact;
  try {
    return await unifyContact(tenantId, contact);
  } catch (err: unknown) {
    // Same rule as the create: an identity nicety may not cost us the message.
    console.warn("[incoming] unify failed (contact kept):", (err as { message?: string })?.message ?? err);
    return contact;
  }
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

    const created = await prisma.contact.upsert({
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

    return await unifyOnChannelPhone(tenantId, created);
  } catch (err: unknown) {
    console.warn(
      "[incoming] contact provisioning failed (message unaffected):",
      (err as { message?: string })?.message ?? err,
    );
    return null;
  }
}
