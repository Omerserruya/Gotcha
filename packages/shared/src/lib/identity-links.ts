import { randomUUID } from "crypto";
import { prisma } from "./prisma";

/**
 * Linking two contacts as one person - automatically on strong evidence,
 * as a suggestion on weak evidence, and always reversibly (2026-10-11).
 *
 * A LINK sets the same `personId` on both contacts. Both rows stay; no field
 * is overwritten; the Customers list already groups by personId. It is a
 * display fact: the order-access guard (services/ai customer-access-guard)
 * reads only the conversation's OWN contact and never follows personId, so a
 * link can never let one customer see another's orders.
 *
 * Every link and suggestion is recorded as one TenantSetting row per pair,
 * key "identity:link:<a>:<b>" (ids sorted) - the same store and shape as the
 * "not the same" marks, so no migration. The record keeps both contacts'
 * PREVIOUS personId, so `unlinkContacts` restores exactly what was there.
 */

export const IDENTITY_LINK = "identity:link:";
/** Same prefix as services/conversation lib/not-same.ts (pinned by a test). */
export const NOT_SAME_PREFIX = "identity:not-same:";

export type LinkSignal =
  | "shared_identifier" // a phone/email typed in a conversation equals another contact's channel-proven id
  | "shopify_customer" // an ownership-checked order resolved to a Shopify customer another contact already has
  | "same_name" // the same name on another channel (suggestion only)
  | "unproven_identifier" // a typed phone/email equal to another contact's unproven value (suggestion only)
  | "accepted_suggestion"; // a person accepted a suggestion

export interface LinkRecord {
  status: "APPLIED" | "PENDING" | "REJECTED";
  signal: LinkSignal;
  contactIds: [string, string];
  /** The contact that moved onto the other's personId (APPLIED only). */
  sourceContactId?: string;
  /** personId each contact had before the link, for an exact unlink. */
  previousPersonIds?: Record<string, string | null>;
  identifier?: { type: string; value: string } | null;
  at: string;
  by: string;
}

export function pairKey(prefix: string, a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `${prefix}${x}:${y}`;
}

type Db = any;

async function readPair(db: Db, tenantId: string, a: string, b: string) {
  const [link, notSame] = await Promise.all([
    db.tenantSetting.findFirst({ where: { tenantId, key: pairKey(IDENTITY_LINK, a, b) }, select: { value: true } }),
    db.tenantSetting.findFirst({ where: { tenantId, key: pairKey(NOT_SAME_PREFIX, a, b) }, select: { key: true } }),
  ]);
  return { link: (link?.value ?? null) as LinkRecord | null, notSame: !!notSame };
}

async function writeRecord(db: Db, tenantId: string, record: LinkRecord) {
  const [a, b] = record.contactIds;
  const key = pairKey(IDENTITY_LINK, a, b);
  await db.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value: record as any, updatedBy: record.by },
    update: { value: record as any, updatedBy: record.by },
  });
}

export type LinkOutcome = "linked" | "already_same_person" | "not_same" | "rejected_before" | "missing";

/**
 * Link `sourceContactId` to `targetContactId` as one person. The source moves
 * onto the target's personId (the target keeps its own, or gets a new one if
 * it had none). Refuses a pair marked "not the same", and a pair whose link
 * was undone before - an undo is never silently redone.
 */
export async function linkContacts(args: {
  tenantId: string;
  sourceContactId: string;
  targetContactId: string;
  signal: LinkSignal;
  identifier?: { type: string; value: string } | null;
  by: string;
  db?: Db;
}): Promise<LinkOutcome> {
  const db = args.db ?? prisma;
  const { tenantId, sourceContactId, targetContactId } = args;
  if (sourceContactId === targetContactId) return "already_same_person";
  const contacts = await db.contact.findMany({
    where: { tenantId, id: { in: [sourceContactId, targetContactId] }, mergedIntoId: null },
    select: { id: true, personId: true },
  });
  const source = contacts.find((c: any) => c.id === sourceContactId);
  const target = contacts.find((c: any) => c.id === targetContactId);
  if (!source || !target) return "missing";
  if (source.personId && source.personId === target.personId) return "already_same_person";
  const { link, notSame } = await readPair(db, tenantId, sourceContactId, targetContactId);
  if (notSame) return "not_same";
  if (link?.status === "REJECTED") return "rejected_before";

  const personId = target.personId ?? `person_${randomUUID()}`;
  const record: LinkRecord = {
    status: "APPLIED",
    signal: args.signal,
    contactIds: [sourceContactId, targetContactId].sort() as [string, string],
    sourceContactId,
    previousPersonIds: { [sourceContactId]: source.personId ?? null, [targetContactId]: target.personId ?? null },
    identifier: args.identifier ?? null,
    at: new Date().toISOString(),
    by: args.by,
  };
  const run = async (tx: Db) => {
    await tx.contact.update({ where: { id: sourceContactId }, data: { personId } });
    if (!target.personId) await tx.contact.update({ where: { id: targetContactId }, data: { personId } });
    await writeRecord(tx, tenantId, record);
  };
  if (typeof db.$transaction === "function") await db.$transaction(run);
  else await run(db);
  return "linked";
}

/**
 * Record a suggestion for a person to decide. Never links. A pair that is
 * already linked, decided, or marked "not the same" is left alone.
 */
export async function suggestLink(args: {
  tenantId: string;
  contactIds: [string, string];
  signal: LinkSignal;
  identifier?: { type: string; value: string } | null;
  by: string;
  db?: Db;
}): Promise<"suggested" | "exists" | "not_same" | "already_same_person"> {
  const db = args.db ?? prisma;
  const [a, b] = args.contactIds;
  if (a === b) return "already_same_person";
  const contacts = await db.contact.findMany({ where: { tenantId: args.tenantId, id: { in: [a, b] } }, select: { id: true, personId: true } });
  if (contacts.length === 2 && contacts[0].personId && contacts[0].personId === contacts[1].personId) return "already_same_person";
  const { link, notSame } = await readPair(db, args.tenantId, a, b);
  if (notSame) return "not_same";
  if (link) return "exists";
  await writeRecord(db, args.tenantId, {
    status: "PENDING",
    signal: args.signal,
    contactIds: [a, b].sort() as [string, string],
    identifier: args.identifier ?? null,
    at: new Date().toISOString(),
    by: args.by,
  });
  return "suggested";
}

/**
 * Undo a link exactly: each contact gets back the personId it had before -
 * but only a contact still on the link's personId (one moved since is left
 * where a person put it). The pair is then marked REJECTED and "not the same",
 * so no signal links it again.
 */
export async function unlinkContacts(args: {
  tenantId: string;
  contactIds: [string, string];
  by: string;
  db?: Db;
}): Promise<"unlinked" | "not_linked"> {
  const db = args.db ?? prisma;
  const [a, b] = args.contactIds;
  const { link } = await readPair(db, args.tenantId, a, b);
  if (!link || link.status !== "APPLIED" || !link.previousPersonIds) return "not_linked";
  const contacts = await db.contact.findMany({ where: { tenantId: args.tenantId, id: { in: [a, b] } }, select: { id: true, personId: true } });
  const linkedPersonId = contacts.find((c: any) => c.id !== link.sourceContactId)?.personId ?? null;
  const run = async (tx: Db) => {
    for (const c of contacts) {
      const prev = link.previousPersonIds![c.id];
      if (prev === undefined) continue;
      if (c.personId === linkedPersonId && c.personId !== prev) {
        await tx.contact.update({ where: { id: c.id }, data: { personId: prev } });
      }
    }
    await writeRecord(tx, args.tenantId, { ...link, status: "REJECTED", at: new Date().toISOString(), by: args.by });
    const key = pairKey(NOT_SAME_PREFIX, a, b);
    const [x, y] = [a, b].sort();
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: args.tenantId, key } },
      create: { tenantId: args.tenantId, key, value: { contactIds: [x, y], markedAt: new Date().toISOString(), markedBy: args.by } as any, updatedBy: args.by },
      update: {},
    });
  };
  if (typeof db.$transaction === "function") await db.$transaction(run);
  else await run(db);
  return "unlinked";
}

/** Digits only: "+972 54-111-1111" and "972541111111" are the same number. */
function digits(v: string): string {
  return v.replace(/\D/g, "");
}

/** Channels whose external id IS the customer's phone or address, proven by the channel itself. */
const PHONE_CHANNELS = ["WHATSAPP", "VOICE"];
const EMAIL_CHANNELS = ["EMAIL", "GMAIL", "OUTLOOK"];

/**
 * A customer typed a phone or email in a conversation. If another contact's
 * CHANNEL-PROVEN id equals it (a WhatsApp/voice number, an email channel's
 * address), link them. If it only equals a value typed somewhere before
 * (unproven), suggest. Anyone can type a stranger's number, which is why an
 * unproven match is never linked.
 */
export async function autoLinkByIdentifier(args: {
  tenantId: string;
  senderContactId: string;
  identifier: { type: "email" | "phone"; value: string };
  db?: Db;
}): Promise<{ outcome: LinkOutcome | "suggested" | "exists" | "no_match" | "not_same" | "already_same_person"; targetContactId?: string }> {
  const db = args.db ?? prisma;
  const { tenantId, senderContactId, identifier } = args;
  const value = identifier.type === "email" ? identifier.value.trim().toLowerCase() : identifier.value.trim();
  const proven =
    identifier.type === "email"
      ? await db.contact.findFirst({ where: { tenantId, channel: { in: EMAIL_CHANNELS }, externalId: { equals: value, mode: "insensitive" }, mergedIntoId: null, id: { not: senderContactId } }, select: { id: true } })
      : (await db.contact.findMany({ where: { tenantId, channel: { in: PHONE_CHANNELS }, mergedIntoId: null, id: { not: senderContactId }, externalId: { endsWith: digits(value).slice(-9) } }, select: { id: true, externalId: true } }))
          .find((c: any) => digits(c.externalId) === digits(value)) ?? null;
  if (proven) {
    const outcome = await linkContacts({ tenantId, sourceContactId: senderContactId, targetContactId: proven.id, signal: "shared_identifier", identifier: { type: identifier.type, value }, by: "auto:shared_identifier", db });
    return { outcome, targetContactId: proven.id };
  }
  const unproven = await db.contact.findFirst({
    where: { tenantId, mergedIntoId: null, id: { not: senderContactId }, ...(identifier.type === "email" ? { email: { equals: value, mode: "insensitive" } } : { phone: value }) },
    select: { id: true },
  });
  if (!unproven) return { outcome: "no_match" };
  const outcome = await suggestLink({ tenantId, contactIds: [senderContactId, unproven.id], signal: "unproven_identifier", identifier: { type: identifier.type, value }, by: "auto:unproven_identifier", db });
  return { outcome, targetContactId: unproven.id };
}

/**
 * An order looked up from a conversation (ownership-checked) resolved to
 * Shopify customer C. If another contact already carries C, they are the same
 * customer: link.
 */
export async function autoLinkByShopifyCustomer(args: {
  tenantId: string;
  contactId: string;
  shopifyCustomerId: string;
  db?: Db;
}): Promise<{ outcome: LinkOutcome | "no_match"; targetContactId?: string }> {
  const db = args.db ?? prisma;
  const other = await db.contact.findFirst({
    where: { tenantId: args.tenantId, id: { not: args.contactId }, mergedIntoId: null, metadata: { path: ["shopifyCustomerId"], equals: String(args.shopifyCustomerId) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!other) return { outcome: "no_match" };
  const outcome = await linkContacts({ tenantId: args.tenantId, sourceContactId: args.contactId, targetContactId: other.id, signal: "shopify_customer", identifier: { type: "shopify_customer", value: String(args.shopifyCustomerId) }, by: "auto:shopify_customer", db });
  return { outcome, targetContactId: other.id };
}

/** Same name, other channel: a suggestion only, never a link. */
export async function suggestBySameName(args: {
  tenantId: string;
  contactId: string;
  displayName: string;
  channel: string;
  db?: Db;
}): Promise<{ suggested: number }> {
  const db = args.db ?? prisma;
  const name = args.displayName.trim().replace(/\s+/g, " ");
  // A handle or a single letter is not a name worth matching on.
  if (name.length < 3 || name.startsWith("@") || !/\s/.test(name)) return { suggested: 0 };
  const others = await db.contact.findMany({
    where: { tenantId: args.tenantId, id: { not: args.contactId }, mergedIntoId: null, channel: { not: args.channel }, displayName: { equals: name, mode: "insensitive" } },
    select: { id: true },
    take: 5,
  });
  let suggested = 0;
  for (const o of others) {
    const r = await suggestLink({ tenantId: args.tenantId, contactIds: [args.contactId, o.id], signal: "same_name", by: "auto:same_name", db });
    if (r === "suggested") suggested++;
  }
  return { suggested };
}
