/**
 * Finding a customer for the assistant (Home chat and Ctrl+K).
 *
 * "יש שיחה מעומר צרויה?" found nothing: the search was ONE `contains` on the
 * whole string, and the customer is "Omer Serruya" (2026-10-08). Now:
 *   - several spellings in one call (`queries`): the model passes the name as
 *     typed, in the other script, and the first name alone;
 *   - word by word: every word of a spelling must match the name, the email or
 *     the phone (any order, any case);
 *   - phones as digits: 054-..., +972 54..., 97254... are the same number;
 *   - a miss on ONE spelling is not "not found": the result asks for the
 *     other spellings first.
 *
 * What the caller sees is what the app shows them:
 *   - customers: tenant-wide with crm:contacts:read (or ADMIN), as on the
 *     customers screen; without it, only customers they can see a
 *     conversation with;
 *   - conversations: the inbox's visibility rule (visibilityClause);
 *   - private numbers (InboundExclusion, Omer's ruling): a contact under a
 *     channel-wide rule, and a conversation under any rule, are hidden, also
 *     rows that existed before the rule.
 */
import { prisma, REAL_CONVERSATION, visibilityClause, type Viewer } from "@chatcenter/shared";
import { privateNumbers, contactIsPrivate, conversationIsPrivate } from "../lib/private-numbers";
import { channelName, whenText } from "./system-tools.service";
import { tenantTimeZone, LIST_SHOWN_AS, NO_CARD, cardsOf, customerDisplayName, type RecordListItem } from "./assistant-query.service";

type Locale = "he" | "en";

export interface CustomerCtx {
  tenantId: string;
  viewer?: Viewer;
  locale: Locale;
  nextId: (kind: "b" | "s") => string;
  /** crm:contacts:read or ADMIN: every customer, as on the customers screen. */
  canReadContacts: boolean;
}

export interface FoundCustomer {
  /** The contact the link opens (the person's most recent one). */
  contactId: string;
  name: string;
  channels: string[];
  email: string | null;
  phone: string | null;
  openConversations: number;
  conversations: number;
  lastContactAt: Date | null;
  /** Every contact of the person (personId), for the tools that follow. */
  contactIds: string[];
  tags: string[];
}

const MAX_VARIANTS = 4;
const CANDIDATES = 40;
const MAX_RESULTS = 10;

/** The words of a spelling: letters and digits, at least 2 characters. */
export function wordsOf(q: string): string[] {
  // A phone typed with spaces ("054 540 1686") is one number, not three words.
  if (/^[+\d\s()-]{7,}$/.test(q.trim())) return [q.trim()];
  return (q.toLowerCase().match(/[\p{L}\p{N}@._+-]{2,}/gu) ?? []).map((w) => w.replace(/^[._+-]+|[._+-]+$/g, "")).filter((w) => w.length >= 2);
}

/** A phone as the digits that identify it, without a country or trunk prefix: "0541111111", "+972 54-111-1111" → "541111111". */
export function phoneCore(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("972")) return d.slice(3);
  if (d.startsWith("0")) return d.slice(1);
  return d;
}

/** One word against the name, the email, the phone and the channel id. */
function wordClause(w: string): Record<string, unknown> {
  const or: Record<string, unknown>[] = [
    { displayName: { contains: w, mode: "insensitive" } },
    { email: { contains: w, mode: "insensitive" } },
  ];
  const core = phoneCore(w);
  if (/^\+?[\d\s()-]{6,}$/.test(w) && core.length >= 6) {
    or.push({ phone: { contains: core } }, { externalId: { contains: core } });
  }
  return { OR: or };
}

interface ContactRow { id: string; channel: string; externalId: string; displayName: string | null; email: string | null; phone: string | null; personId: string | null; updatedAt: Date; tags?: unknown }
const CONTACT_SELECT = { id: true, channel: true, externalId: true, displayName: true, email: true, phone: true, personId: true, updatedAt: true, tags: true } as const;

/**
 * The customers matching any of the spellings, as the caller may see them,
 * one row per person, best match first.
 */
export async function findCustomers(ctx: CustomerCtx, queries: string[]): Promise<FoundCustomer[]> {
  const spellings = [...new Set(queries.map((q) => String(q ?? "").trim()).filter(Boolean))].slice(0, MAX_VARIANTS);
  const rules = await privateNumbers(ctx.tenantId);
  const score = new Map<string, number>();
  const rows = new Map<string, ContactRow>();
  for (const [i, q] of spellings.entries()) {
    const words = wordsOf(q);
    if (!words.length) continue;
    const found = (await prisma.contact.findMany({
      where: { tenantId: ctx.tenantId, mergedIntoId: null, AND: words.map(wordClause) } as any,
      select: CONTACT_SELECT,
      orderBy: { updatedAt: "desc" },
      take: CANDIDATES,
    })) as ContactRow[];
    for (const c of found) {
      if (contactIsPrivate(c, rules)) continue;
      rows.set(c.id, c);
      // An earlier spelling (as typed) and more words matched rank higher.
      score.set(c.id, Math.max(score.get(c.id) ?? 0, words.length * 10 - i));
    }
  }
  if (!rows.size) return [];
  return (await describeCustomers(ctx, [...rows.values()], rules, score)).slice(0, MAX_RESULTS);
}

/**
 * One customer by a contact id, as this caller may see them (the same rules as
 * the search), or null: missing, another workspace's, private, or (without
 * the contacts permission) without a conversation the caller can see.
 */
export async function visibleCustomer(ctx: CustomerCtx, contactId: string): Promise<FoundCustomer | null> {
  const rules = await privateNumbers(ctx.tenantId);
  const rows = ((await prisma.contact.findMany({ where: { tenantId: ctx.tenantId, id: contactId, mergedIntoId: null } as any, select: CONTACT_SELECT })) as ContactRow[]).filter((c) => !contactIsPrivate(c, rules));
  if (!rows.length) return null;
  return (await describeCustomers(ctx, rows, rules, new Map()))[0] ?? null;
}

/** Contacts as customers: one per person, their visible conversations counted, best first. */
async function describeCustomers(ctx: CustomerCtx, rows: ContactRow[], rules: Awaited<ReturnType<typeof privateNumbers>>, score: Map<string, number>): Promise<FoundCustomer[]> {
  // One row per person: the contacts sharing a personId are one customer.
  const personIds = [...new Set(rows.map((c) => c.personId).filter(Boolean))] as string[];
  const siblings = personIds.length
    ? ((await prisma.contact.findMany({ where: { tenantId: ctx.tenantId, mergedIntoId: null, personId: { in: personIds } } as any, select: CONTACT_SELECT })) as ContactRow[]).filter((c) => !contactIsPrivate(c, rules))
    : [];
  const groups = new Map<string, ContactRow[]>();
  for (const c of [...rows, ...siblings]) {
    const key = c.personId ?? c.id;
    const g = groups.get(key) ?? [];
    if (!g.some((x) => x.id === c.id)) g.push(c);
    groups.set(key, g);
  }

  // Their conversations, as this caller may see them.
  const clause = ctx.viewer ? visibilityClause(ctx.viewer) : null;
  const all = [...groups.values()].flat();
  const convs = await prisma.conversation.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...REAL_CONVERSATION,
      OR: all.map((c) => ({ channel: c.channel, customerExternalId: c.externalId })),
      ...(clause ? { AND: [{ OR: clause }] } : {}),
    } as any,
    select: { channel: true, customerExternalId: true, channelAccountId: true, status: true, lastMessageAt: true, createdAt: true },
  });
  const visible = convs.filter((c: any) => !conversationIsPrivate(c, rules));

  const out: Array<FoundCustomer & { rank: number }> = [];
  for (const group of groups.values()) {
    const mine = visible.filter((v: any) => group.some((c) => c.channel === v.channel && c.externalId === v.customerExternalId));
    // Without the contacts permission, a customer is found only through a conversation the caller can see.
    if (!ctx.canReadContacts && mine.length === 0) continue;
    const primary = [...group].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
    const last = mine.reduce<Date | null>((m, v: any) => { const t = v.lastMessageAt ?? v.createdAt; return !m || t > m ? t : m; }, null);
    out.push({
      contactId: primary.id,
      name: customerDisplayName(group.map((c) => c.displayName).find(Boolean) ?? primary.email ?? primary.phone ?? null, primary.externalId, ctx.locale),
      channels: [...new Set(group.map((c) => c.channel))],
      email: group.map((c) => c.email).find(Boolean) ?? null,
      phone: group.map((c) => c.phone).find(Boolean) ?? null,
      openConversations: mine.filter((v: any) => v.status === "OPEN").length,
      conversations: mine.length,
      lastContactAt: last,
      contactIds: group.map((c) => c.id),
      tags: [...new Set(group.flatMap((c) => (Array.isArray(c.tags) ? c.tags : []).map(String)))].slice(0, 20),
      rank: Math.max(...group.map((c) => score.get(c.id) ?? 0)),
    });
  }
  return out
    .sort((a, b) => b.rank - a.rank || (b.lastContactAt?.getTime() ?? 0) - (a.lastContactAt?.getTime() ?? 0))
    .map(({ rank: _r, ...c }) => c);
}

/** The tool's result: what the model reads, the card, the source. */
export async function findCustomersResult(ctx: CustomerCtx, queries: string[]) {
  const spellings = [...new Set(queries.map((q) => String(q ?? "").trim()).filter(Boolean))].slice(0, MAX_VARIANTS);
  if (!spellings.length) return { summary: { ok: false, error: "queries is required" } };
  const found = await findCustomers(ctx, spellings);
  const he = ctx.locale === "he";
  if (!found.length) {
    // One spelling is not a search: the name may be written in the other script.
    return {
      summary: spellings.length === 1
        ? { ok: true, found: 0, retry: "search again in this same call with the name in the other script (Hebrew or Latin letters) and with the first name alone, before saying the customer was not found" }
        : { ok: true, found: 0, notFound: true, tried: spellings },
    };
  }
  const tz = await tenantTimeZone(ctx.tenantId);
  const sId = ctx.nextId("s");
  const items: RecordListItem[] = found.map((c) => ({
    id: c.contactId,
    title: c.name,
    subtitle: [c.channels.map((ch) => channelName(ch, ctx.locale)).join(", "), c.phone ?? c.email].filter(Boolean).join(" · "),
    meta: [
      he ? (c.openConversations === 1 ? "שיחה פתוחה אחת" : `${c.openConversations} שיחות פתוחות`) : `${c.openConversations} open`,
      c.lastContactAt ? (he ? `קשר אחרון ${whenText(c.lastContactAt, "he", tz, false)}` : `last contact ${whenText(c.lastContactAt, "en", tz, false)}`) : null,
    ].filter(Boolean).join(" · "),
    deepLink: `/customers/${c.contactId}`,
  }));
  const blocks = [{
    type: "record_list" as const, id: ctx.nextId("b"), title: he ? "לקוחות שנמצאו" : "Customers found", sourceId: sId,
    kind: "customer" as const, items, total: items.length, hasMore: false, deepLink: null, partial: null,
  }];
  const source = {
    id: sId, kind: "customer" as const, count: items.length, deepLink: null,
    // What was found, never the query as typed ("1 לקוחות: מעומר צרויה").
    label: `${he ? (items.length === 1 ? "לקוח אחד" : `${items.length} לקוחות`) : (items.length === 1 ? "1 customer" : `${items.length} customers`)}: ${found.slice(0, 2).map((c) => c.name).join(", ")}${found.length > 2 ? (he ? " ועוד" : " and more") : ""}`,
    query: { tool: "customers" as const, params: { queries: spellings } },
  };
  return {
    summary: {
      ok: true, cite: sId, found: found.length,
      customers: found.map((c) => ({
        customerId: c.contactId,
        name: c.name,
        channels: c.channels.map((ch) => channelName(ch, ctx.locale)),
        email: c.email,
        phone: c.phone,
        openConversations: c.openConversations,
        conversations: c.conversations,
        lastContact: c.lastContactAt ? whenText(c.lastContactAt, ctx.locale, tz) : null,
      })),
      shownAs: blocks.length ? LIST_SHOWN_AS : NO_CARD,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}
