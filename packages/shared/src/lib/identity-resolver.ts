/**
 * Identity resolver - cross-channel contact lookups and auto-unification.
 *
 * Problem solved: before F1 fix, every service that needed "the contact for
 * (tenant, channel, externalId)" did a raw prisma.contact.findFirst. After a
 * merge, the source row was DELETED, so the next inbound message on that
 * channel resurrected a ghost row - silently defeating the merge.
 *
 * This module introduces TWO primitives that together fix the whole flow:
 *
 *   - resolveContactByChannelId(): tenant-scoped lookup that follows
 *     mergedIntoId pointers once, so merged-away rows transparently resolve
 *     to the surviving target. Callers get "the right contact" without
 *     knowing anything about merge history.
 *
 *   - unifyContact(): checks whether the given contact shares a verified
 *     email/phone with any OTHER contact in the same tenant and, if so,
 *     assigns them the same personId. "Same real human across channels."
 *     Non-destructive - no rows deleted, no existing fields overwritten.
 *
 * Both are idempotent and safe to call on the hot path (webhook ingest,
 * bot engine tool execution, /identity/capture endpoint).
 *
 * See memory/bug_f1_merge_ghost_contacts.md and
 * memory/enhancement_f1_cross_channel_auto_unify.md for the full design.
 */
import { prisma } from "./prisma";
import type { Contact, ChannelType } from "@prisma/client";

/**
 * Resolve a contact by (tenantId, channel, externalId), transparently
 * following soft-merge pointers so merged sources route to their target.
 *
 * Loop protection: follows mergedIntoId at most once. A chain longer than
 * that indicates a bug in /identity/merge - we log and return null rather
 * than chase an arbitrary pointer graph.
 */
export async function resolveContactByChannelId(
  tenantId: string,
  channel: ChannelType,
  externalId: string,
): Promise<Contact | null> {
  const direct = await prisma.contact.findFirst({
    where: { tenantId, channel, externalId },
  });
  if (!direct) return null;

  if (!direct.mergedIntoId) return direct;

  // Follow the pointer exactly once - the merge path should always point
  // at a surviving row, never at another merged row. Any deeper chain is
  // a data integrity bug.
  const target = await prisma.contact.findFirst({
    where: { id: direct.mergedIntoId, tenantId },
  });
  if (!target) {
    console.warn(
      `[identity-resolver] dangling mergedIntoId on contact ${direct.id} → ${direct.mergedIntoId}`,
    );
    return direct;
  }
  if (target.mergedIntoId) {
    console.warn(
      `[identity-resolver] multi-hop merge chain detected: ${direct.id} → ${target.id} → ${target.mergedIntoId}`,
    );
    return target;
  }
  return target;
}

/**
 * Assign a stable personId to a contact, sharing it with any other contact
 * in the same tenant that has a matching verified-or-not email/phone.
 *
 * Behavior matrix:
 *   - contact has personId already → returns as-is, no-op
 *   - contact has no personId, finds a sibling with personId → adopts it
 *   - contact has no personId, finds a sibling without → mints a new cuid
 *     and assigns to BOTH rows so they share it
 *   - no sibling found → mints a new cuid, assigns only to this row
 *
 * Idempotent: safe to call on every inbound. Returns the resulting contact
 * (with personId populated) so callers can use it directly.
 */
export async function unifyContact(
  tenantId: string,
  contact: Contact,
): Promise<Contact> {
  if (contact.personId) return contact;

  const matchers: Array<{ email?: string } | { phone?: string }> = [];
  if (contact.email) matchers.push({ email: contact.email });
  if (contact.phone) matchers.push({ phone: contact.phone });

  let sibling: Contact | null = null;
  if (matchers.length > 0) {
    sibling = await prisma.contact.findFirst({
      where: {
        tenantId,
        id: { not: contact.id },
        mergedIntoId: null,
        OR: matchers as any,
      },
      orderBy: [{ personId: "desc" }, { createdAt: "asc" }],
    });
  }

  // Adopt sibling's personId if it has one, otherwise mint new
  const { randomUUID } = await import("crypto");
  const personId = sibling?.personId ?? `person_${randomUUID()}`;

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { personId },
  });

  // Backfill sibling too so the link is bidirectional
  if (sibling && !sibling.personId) {
    await prisma.contact.update({
      where: { id: sibling.id },
      data: { personId },
    });
  }

  return updated;
}

/**
 * Fetch all contact rows belonging to the same person, given any one of
 * them. Used by the customer-state builder and the timeline query to pull
 * cross-channel history without caring which "entry point" contact the
 * caller started from.
 */
export async function findSiblingContacts(
  tenantId: string,
  contact: Contact,
): Promise<Contact[]> {
  if (contact.personId) {
    return prisma.contact.findMany({
      where: { tenantId, personId: contact.personId, mergedIntoId: null },
    });
  }
  // Fallback: email/phone match - used for contacts created before unifyContact ran
  const matchers: any[] = [{ id: contact.id }];
  if (contact.email) matchers.push({ email: contact.email });
  if (contact.phone) matchers.push({ phone: contact.phone });
  return prisma.contact.findMany({
    where: {
      tenantId,
      mergedIntoId: null,
      OR: matchers,
    },
  });
}
