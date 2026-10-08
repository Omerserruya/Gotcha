/**
 * Home chat stage 2 (docs/api/assistant-threads-v1.md §9): the query layer.
 *
 * A query computes numbers and turns them into BLOCKS (what the screen draws)
 * and a SOURCE (what was asked, replayable for the full list). The model gets
 * a short summary and the source id to cite; it never writes a number that a
 * block shows. Everything follows the caller's visibility and counts only the
 * business's real conversations (no rehearsals, test rows or imported history).
 */
import { prisma, REAL_CONVERSATION, visibilityClause, readDurableSetting, parseBusinessHours, waitingForPersonClause, type Viewer } from "@chatcenter/shared";
import { privateNumbers, privateConversationsClause } from "../lib/private-numbers";
import { INTENTS, intentLabel } from "./conversation-analysis.service";
import { channelName, whenText } from "./system-tools.service";

type Locale = "he" | "en";

export interface ChartBlock { type: "chart"; id: string; title: string; sourceId: string; kind: "bar" | "line"; x: { kind: "day" | "category"; values: string[] }; series: Array<{ key: string; label: string; values: number[] }>; unit: "count" | "currency" | "percent"; currency: string | null; highlight: string[]; deepLink: string | null; partial: null | { reason: string; cap?: number } }
export interface BreakdownBlock { type: "breakdown"; id: string; title: string; sourceId: string; items: Array<{ key: string; label: string; value: number; share: number }>; total: number; unit: "count"; currency: null; other: { label: string; value: number } | null; coverage: { covered: number; of: number } | null; deepLink: string | null; partial: null }
export interface RecordListItem { id: string; title: string; subtitle: string; meta: string; deepLink: string | null; preview?: string | null }
export interface RecordListBlock { type: "record_list"; id: string; title: string; sourceId: string; kind: "conversation" | "order" | "customer"; items: RecordListItem[]; total: number; hasMore: boolean; deepLink: null; partial: null }
export type Block = ChartBlock | BreakdownBlock | RecordListBlock;
export interface Source { id: string; label: string; kind: "conversations"; count: number | null; deepLink: string | null; query: { tool: "conversations"; params: ConversationQuery } }

export interface ConversationQuery {
  from?: string; // YYYY-MM-DD, workspace days, inclusive (absent with `now`)
  to?: string;
  /**
   * The current state: every conversation in `status` right now, whenever it
   * started (the figure Home's "open" counts). "How many are open", "how many
   * of them are on WhatsApp" are about now; a period would count only the
   * ones that STARTED in it, and said 0 of 17 open (Omer, 2026-10-08).
   */
  now?: true;
  channels?: string[];
  status?: "OPEN" | "WAITING" | "CLOSED";
  groupBy?: "day" | "channel" | "status" | "handler" | "intent" | "sentiment";
  mention?: string;
  /** A customer's conversations: these contacts and every other contact of the same person. */
  customerIds?: string[];
  /** Who handles it: "gotcha", "unassigned", or a person's user id. */
  assignee?: string;
  /** Waiting for a person: the one rule Home and the inbox's queue use. */
  waitingForPerson?: true;
  /** Rows to open (a record_list), not only counts. */
  list?: true;
}

export interface QueryCtx { tenantId: string; viewer?: Viewer; locale: Locale; nextId: (kind: "b" | "s") => string }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const MAX_ROWS = 5000;
const LIST_FIRST_PAGE = 10;
const LIST_PAGE = 25;
// The inbox's channel filter (frontend 579fca8 added Shopify live chat).
const INBOX_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "MESSENGER", "EMAIL", "WEBCHAT", "SHOPIFY_LIVE_CHAT"]);
const CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "MESSENGER", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "VOICE", "WEBCHAT", "SHOPIFY_LIVE_CHAT", "SMS", "TELEGRAM"]);

/** The workspace's timezone (its business hours), else UTC. */
export async function tenantTimeZone(tenantId: string): Promise<string> {
  try {
    return parseBusinessHours(await readDurableSetting(tenantId, "businessHours"))?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

// The workspace's days: one arithmetic for the charts here and the inbox's
// period filter (services/conversation), so a chart's link opens its rows.
export { dayStart, dayOf } from "@chatcenter/shared";
import { dayStart, dayOf } from "@chatcenter/shared";

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end && out.length <= MAX_DAYS) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/** A clean query, or a reason it cannot run. */
export function normalizeQuery(raw: any): ConversationQuery | { error: string } {
  const channels = Array.isArray(raw?.channels) ? [...new Set(raw.channels.map((c: unknown) => String(c).toUpperCase()).filter((c: string) => CHANNELS.has(c)))] as string[] : undefined;
  const status = ["OPEN", "WAITING", "CLOSED"].includes(raw?.status) ? raw.status : undefined;
  const groupBy = ["day", "channel", "status", "handler", "intent", "sentiment"].includes(raw?.groupBy) ? raw.groupBy : undefined;
  const mention = typeof raw?.mention === "string" && raw.mention.trim() ? raw.mention.trim().slice(0, 80) : undefined;
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const customerIds = Array.isArray(raw?.customerIds) ? ([...new Set(raw.customerIds.map(String).filter((id: string) => ID.test(id)))] as string[]).slice(0, 20) : undefined;
  const assignee = typeof raw?.assignee === "string" && ID.test(raw.assignee) ? raw.assignee : undefined;
  const waitingForPerson = raw?.waitingForPerson === true || raw?.waitingForPerson === "true" ? true as const : undefined;
  const list = raw?.list === true || raw?.list === "true" ? true as const : undefined;
  const extra = { ...(customerIds?.length ? { customerIds } : {}), ...(assignee ? { assignee } : {}), ...(waitingForPerson ? { waitingForPerson } : {}), ...(list ? { list } : {}) };
  if (raw?.now === true || raw?.now === "true") {
    // Closed "right now" is every conversation ever closed: not a current
    // state. A customer's conversations, or what waits for a person, are.
    if (status !== "OPEN" && status !== "WAITING" && !customerIds?.length && !waitingForPerson) return { error: "now (the current state) needs status OPEN or WAITING, a customer, or waitingForPerson" };
    if (groupBy === "day") return { error: "the current state has no days: split it by channel, status, handler, intent or sentiment, or ask about a period" };
    if (mention) return { error: "a mention needs a period (what was said in it)" };
    return { now: true, ...(channels?.length ? { channels } : {}), ...(status ? { status } : {}), groupBy: groupBy ?? "channel", ...extra };
  }
  const from = String(raw?.from ?? ""), to = String(raw?.to ?? "");
  if (!DAY.test(from) || !DAY.test(to) || from > to) return { error: "from and to must be YYYY-MM-DD days, from <= to" };
  if (daysBetween(from, to).length > MAX_DAYS) return { error: `at most ${MAX_DAYS} days` };
  return { from, to, ...(channels?.length ? { channels } : {}), ...(status ? { status } : {}), groupBy: groupBy ?? "day", ...(mention ? { mention } : {}), ...extra };
}

/** Every contact of the people these contacts belong to, as conversation keys (tenant-scoped: a foreign id matches nothing). */
async function customerKeys(tenantId: string, contactIds: string[]): Promise<Array<{ channel: string; customerExternalId: string }>> {
  const seeds = await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { channel: true, externalId: true, personId: true } });
  const personIds = [...new Set(seeds.map((c) => c.personId).filter(Boolean))] as string[];
  const siblings = personIds.length ? await prisma.contact.findMany({ where: { tenantId, personId: { in: personIds } }, select: { channel: true, externalId: true, personId: true } }) : [];
  const keys = new Map<string, { channel: string; customerExternalId: string }>();
  for (const c of [...seeds, ...siblings]) keys.set(`${c.channel}:${c.externalId}`, { channel: String(c.channel), customerExternalId: c.externalId });
  return [...keys.values()];
}

/** The conversations a query counts, as a Prisma where (visibility kept in an AND). */
async function whereOf(tenantId: string, q: ConversationQuery, viewer: Viewer | undefined, tz: string) {
  const and: any[] = [];
  const clause = viewer ? visibilityClause(viewer) : null;
  if (clause) and.push({ OR: clause });
  if (q.waitingForPerson) and.push(waitingForPersonClause());
  if (q.customerIds?.length) {
    const keys = await customerKeys(tenantId, q.customerIds);
    and.push(keys.length ? { OR: keys } : { id: "__no_such_conversation__" });
  }
  if (q.assignee) {
    and.push(
      q.assignee === "unassigned" ? { assignedAgentId: null }
      : q.assignee === "gotcha" ? { assignedAgentId: null, isHandedOver: false, handledBy: { in: ["ai_agent", "flow"] } }
      : { assignedAgentId: q.assignee },
    );
  }
  // Private numbers (lib/private-numbers): never counted, never listed.
  const priv = privateConversationsClause(await privateNumbers(tenantId));
  if (priv) and.push(priv);
  const where: any = {
    tenantId,
    ...REAL_CONVERSATION,
    ...(q.channels ? { channel: { in: q.channels } } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
  // The current state: whenever they started.
  if (!q.now) {
    const start = dayStart(q.from!, tz);
    const end = dayStart(nextDay(q.to!), tz);
    if (q.mention) {
      // Conversations where a message in the period says it (any language, any case).
      where.messages = { some: { createdAt: { gte: start, lt: end }, body: { contains: q.mention, mode: "insensitive" } } };
    } else {
      where.createdAt = { gte: start, lt: end };
    }
  }
  if (and.length) where.AND = and;
  return where;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const L = {
  conversations: { he: "שיחות", en: "conversations" },
  status: { OPEN: { he: "פתוחות", en: "Open" }, WAITING: { he: "ממתינות ללקוח", en: "Waiting for the customer" }, CLOSED: { he: "נסגרו", en: "Closed" } } as Record<string, Record<Locale, string>>,
  handler: { gotcha: { he: "GOTCHA", en: "GOTCHA" }, team: { he: "הצוות", en: "Your team" }, none: { he: "לא טופלו", en: "Not handled" } } as Record<string, Record<Locale, string>>,
  sentiment: { positive: { he: "חיובי", en: "Positive" }, neutral: { he: "ניטרלי", en: "Neutral" }, negative: { he: "שלילי", en: "Negative" }, mixed: { he: "מעורב", en: "Mixed" } } as Record<string, Record<Locale, string>>,
};

function handlerOf(c: { handledBy: string | null; isHandedOver: boolean }): "gotcha" | "team" | "none" {
  if (c.handledBy === "human" || c.isHandedOver) return "team";
  if (c.handledBy === "ai_agent" || c.handledBy === "flow") return "gotcha";
  return "none";
}

function periodWords(q: ConversationQuery, locale: Locale): string {
  if (q.now) return locale === "he" ? "כרגע" : "right now";
  const f = whenText(new Date(`${q.from}T12:00:00.000Z`), locale, "UTC", false);
  const t = whenText(new Date(`${q.to}T12:00:00.000Z`), locale, "UTC", false);
  return q.from === q.to ? f : `${f} - ${t}`;
}

/** The source's chip label: "12 שיחות שמזכירות “קטן”", "38 conversations, 1 - 7 October". */
export function sourceLabel(q: ConversationQuery, total: number, locale: Locale): string {
  const he = locale === "he";
  const parts = [`${total} ${L.conversations[locale]}`];
  if (q.mention) parts.push(he ? `שמזכירות “${q.mention}”` : `mentioning “${q.mention}”`);
  if (q.channels?.length === 1) parts.push(he ? `בערוץ ${channelName(q.channels[0], locale)}` : `on ${channelName(q.channels[0], locale)}`);
  if (q.status) parts.push(`(${L.status[q.status]![locale]})`);
  parts.push(`· ${periodWords(q, locale)}`);
  return parts.join(" ");
}

/**
 * The inbox showing the same rows, or null when the inbox cannot say the
 * same thing: it filters by channel and by period (conversations STARTED in
 * it, the same workspace days), not by a mention, a status or several
 * channels, and a link that opens different rows is worse than none.
 */
/**
 * The inbox's "All conversations" view (frontend 542e695): every conversation,
 * open or closed, automated included. Without it a period link opens the
 * default "Waiting in queue" view, far fewer rows than the chart counted.
 * On dev since frontend 1850b9f (2026-10-08).
 */
export const INBOX_VIEW_ALL_LIVE = true;

export function sourceLink(q: ConversationQuery, viewAllLive = INBOX_VIEW_ALL_LIVE): string | null {
  if (!viewAllLive) return null;
  if (q.now || q.mention || q.status || q.customerIds || q.assignee || q.waitingForPerson || (q.channels && q.channels.length > 1)) return null;
  const channel = q.channels?.[0];
  if (channel && !INBOX_CHANNELS.has(channel)) return null;
  return `/inbox?view=all&${channel ? `channel=${channel}&` : ""}from=${q.from}&to=${q.to}`;
}

/** One conversation's state, as a row says it (singular: "פתוחה", not "פתוחות"). */
const ROW_STATUS: Record<string, Record<Locale, string>> = {
  OPEN: { he: "פתוחה", en: "Open" }, WAITING: { he: "ממתינה ללקוח", en: "Waiting for the customer" }, CLOSED: { he: "סגורה", en: "Closed" },
};

/** Who has it: the person assigned, GOTCHA, or (still open) nobody yet. */
function handlerWords(c: ListRow, locale: Locale): string {
  if (c.assignedAgent?.name) return c.assignedAgent.name;
  if (!c.isHandedOver && (c.handledBy === "ai_agent" || c.handledBy === "flow")) return "GOTCHA";
  if (c.status === "CLOSED") return locale === "he" ? "ללא שיוך" : "Unassigned";
  return locale === "he" ? "ממתינה לאדם" : "Waiting for a person";
}

interface ListRow { id: string; customerName: string | null; customerExternalId: string | null; channel: string; status: string; lastMessageAt: Date | null; createdAt: Date; handledBy: string | null; isHandedOver: boolean; assignedAgent: { name: string | null } | null }

/**
 * Rows to open: who, where, its state, who has it, and (for the current
 * state) the last message and when. A period's rows are dated by when they
 * STARTED, its measure: a row dated by its last message read as outside it.
 */
async function listItems(tenantId: string, rows: ListRow[], locale: Locale, tz: string, byLastMessage = false): Promise<RecordListItem[]> {
  const last = rows.length
    ? await prisma.message.findMany({
        where: { tenantId, conversationId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        distinct: ["conversationId"],
        select: { conversationId: true, body: true },
      })
    : [];
  const preview = new Map(last.map((m) => [m.conversationId, m.body ? m.body.replace(/\s+/g, " ").trim().slice(0, 80) : null]));
  return rows.map((c) => ({
    id: c.id,
    title: c.customerName || c.customerExternalId || (locale === "he" ? "לקוח" : "Customer"),
    subtitle: `${channelName(c.channel, locale)} · ${ROW_STATUS[c.status]?.[locale] ?? c.status} · ${handlerWords(c, locale)}`,
    meta: whenText(byLastMessage ? (c.lastMessageAt ?? c.createdAt) : c.createdAt, locale, tz),
    deepLink: `/inbox?c=${c.id}`,
    preview: preview.get(c.id) ?? null,
  }));
}

const LIST_SELECT = { id: true, customerName: true, customerExternalId: true, channel: true, status: true, lastMessageAt: true, createdAt: true, handledBy: true, isHandedOver: true, assignedAgent: { select: { name: true } } } as const;

/** The current state lists the latest activity first; a period, the latest started. */
function orderOf(q: ConversationQuery): any[] {
  return q.now ? [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }] : [{ createdAt: "desc" }, { id: "desc" }];
}

export interface QueryResult {
  /** For the model: the counts in words and the id to cite. Never the blocks' raw arrays. */
  summary: Record<string, unknown>;
  blocks: Block[];
  source: Source;
}

/** Run a conversations query: counts, the block(s) and the source. */
export async function queryConversations(ctx: QueryCtx, q: ConversationQuery): Promise<QueryResult> {
  const tz = await tenantTimeZone(ctx.tenantId);
  const where = await whereOf(ctx.tenantId, q, ctx.viewer, tz);
  const rows = await prisma.conversation.findMany({
    where,
    select: { id: true, channel: true, status: true, handledBy: true, isHandedOver: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS + 1,
  });
  const capped = rows.length > MAX_ROWS;
  const counted = capped ? rows.slice(0, MAX_ROWS) : rows;
  const total = counted.length;
  const sId = ctx.nextId("s");
  const source: Source = { id: sId, label: sourceLabel(q, total, ctx.locale), kind: "conversations", count: total, deepLink: sourceLink(q), query: { tool: "conversations", params: q } };
  const blocks: Block[] = [];
  const he = ctx.locale === "he";
  const partial = capped ? { reason: "capped", cap: MAX_ROWS } : null;

  // A card that shows nothing is not drawn: the answer says the 0 in words.
  let groups: Array<{ label: string; value: number }> | null = null;
  let coverage: { covered: number; of: number } | null = null;
  if (q.list) {
    // Rows, below: no split card.
  } else if (q.groupBy === "day") {
    const days = daysBetween(q.from!, q.to!);
    const byDay = new Map(days.map((d) => [d, 0]));
    for (const r of counted) { const d = dayOf(r.createdAt, tz); if (byDay.has(d)) byDay.set(d, byDay.get(d)! + 1); }
    const values = days.map((d) => byDay.get(d)!);
    const max = Math.max(0, ...values);
    if (total) blocks.push({
      type: "chart", id: ctx.nextId("b"), title: he ? "שיחות לפי יום" : "Conversations by day", sourceId: sId, kind: "bar",
      x: { kind: "day", values: days }, series: [{ key: "conversations", label: he ? "שיחות" : "Conversations", values }],
      unit: "count", currency: null, highlight: max > 0 ? days.filter((_, i) => values[i] === max) : [], deepLink: "/analytics?tab=overview", partial,
    });
  } else if (q.groupBy === "intent" || q.groupBy === "sentiment") {
    // Recorded only for some conversations: the block says for how many.
    const intel = total
      ? await prisma.conversationIntelligence.findMany({
          where: { tenantId: ctx.tenantId, conversationId: { in: counted.map((r) => r.id) } },
          select: { detectedIntent: true, sentiment: true, metadata: true },
        })
      : [];
    const counts = new Map<string, number>();
    let covered = 0;
    for (const i of intel as any[]) {
      // Only the close analysis counts: rows from the old keyword heuristics
      // ("general" for any Hebrew text) or a failed call ("unknown") are not
      // recorded values, and a settled row without an intent is "looked at,
      // nothing to record".
      if ((i.metadata as any)?.source !== "close-analysis") continue;
      const v = q.groupBy === "intent" ? i.detectedIntent : i.sentiment;
      if (!v || (q.groupBy === "intent" && !(v in INTENTS))) continue;
      covered++;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, value]) => ({
      key, value, share: covered ? value / covered : 0,
      label: q.groupBy === "sentiment" ? L.sentiment[key]?.[ctx.locale] ?? key : intentLabel(key, ctx.locale),
    }));
    groups = items.map((i) => ({ label: i.label, value: i.value }));
    coverage = { covered, of: total };
    if (items.length) blocks.push({
      type: "breakdown", id: ctx.nextId("b"), title: q.groupBy === "intent" ? (he ? "לפי כוונה" : "By intent") : (he ? "לפי סנטימנט" : "By sentiment"), sourceId: sId,
      items, total: covered, unit: "count", currency: null, other: null, coverage: { covered, of: total }, deepLink: "/analytics?tab=topics", partial: null,
    });
  } else {
    const keyOf = (r: (typeof counted)[number]) => (q.groupBy === "channel" ? r.channel : q.groupBy === "status" ? r.status : handlerOf(r));
    const counts = new Map<string, number>();
    for (const r of counted) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);
    const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, value]) => ({
      key, value, share: total ? value / total : 0,
      label: q.groupBy === "channel" ? channelName(key, ctx.locale) : q.groupBy === "status" ? L.status[key]?.[ctx.locale] ?? key : L.handler[key]![ctx.locale],
    }));
    groups = items.map((i) => ({ label: i.label, value: i.value }));
    if (items.length) blocks.push({
      type: "breakdown", id: ctx.nextId("b"),
      title: q.groupBy === "channel" ? (he ? "לפי ערוץ" : "By channel") : q.groupBy === "status" ? (he ? "לפי מצב" : "By status") : (he ? "מי טיפל" : "Who handled them"),
      sourceId: sId, items, total, unit: "count", currency: null, other: null, coverage: null,
      deepLink: q.groupBy === "channel" ? null : q.groupBy === "status" ? null : "/analytics?tab=gotcha", partial: null,
    });
  }

  // The rows: asked for (a list), or behind a mention (who said it).
  let listed: RecordListItem[] = [];
  if ((q.list || q.mention) && total) {
    const first = await prisma.conversation.findMany({ where, select: LIST_SELECT, orderBy: orderOf(q), take: LIST_FIRST_PAGE });
    listed = await listItems(ctx.tenantId, first as any, ctx.locale, tz, !!q.now);
    blocks.push({
      type: "record_list", id: ctx.nextId("b"),
      title: q.mention ? (he ? `שיחות שמזכירות “${q.mention}”` : `Conversations mentioning “${q.mention}”`) : (he ? "השיחות" : "Conversations"),
      sourceId: sId, kind: "conversation", items: listed, total, hasMore: total > first.length, deepLink: null, partial: null,
    });
  }

  // None started in the period, but some are in that state now: the period is
  // the reason for the 0, and the answer says so ("none started this week;
  // 17 are open").
  let inThisStateNow: number | null = null;
  if (!total && !q.now && !q.mention && (q.status === "OPEN" || q.status === "WAITING")) {
    inThisStateNow = await prisma.conversation.count({ where: await whereOf(ctx.tenantId, { now: true, status: q.status, ...(q.channels ? { channels: q.channels } : {}) }, ctx.viewer, tz) });
  }

  const chart = blocks.find((b): b is ChartBlock => b.type === "chart");
  const summary: Record<string, unknown> = {
    ok: true,
    cite: sId,
    total,
    period: periodWords(q, ctx.locale),
    // Words the model may repeat are in the turn's language ("right now" leaked
    // into a Hebrew answer from English prose here, 2026-10-08).
    ...(q.now ? { counts: he ? "כל השיחות במצב הזה כרגע, לא משנה מתי התחילו" : "every conversation in this state now, whenever it started" } : {}),
    ...(groups ? { groups } : {}),
    // The rows in words, so the model can name them (the card has the links).
    ...(q.list && listed.length ? { rows: listed.map((r) => ({ conversationId: r.id, customer: r.title, where: r.subtitle, lastMessage: r.preview ?? null, when: r.meta })), ...(total > listed.length ? { moreRows: total - listed.length } : {}) } : {}),
    ...(coverage ? { recordedFor: `${coverage.covered} ${he ? "מתוך" : "of"} ${coverage.of}` } : {}),
    ...(chart ? { busiestDays: chart.highlight.map((d) => whenText(new Date(`${d}T12:00:00.000Z`), ctx.locale, "UTC", false)) } : {}),
    ...(inThisStateNow ? { inThisStateNow, note: he
      ? `אף אחת מהן לא התחילה ב${periodWords(q, ctx.locale)}, אבל ${inThisStateNow} במצב הזה כרגע (התחילו קודם): לומר את שניהם`
      : `0 of them STARTED in ${periodWords(q, ctx.locale)}, but ${inThisStateNow} are in this state now (they started earlier): say both` } : {}),
    ...(capped ? { note: `counted the latest ${MAX_ROWS}` } : {}),
    shownAs: blocks.length ? SHOWN_AS : NO_CARD,
    cards: cardsOf(blocks, ctx.locale),
  };
  return { summary, blocks, source };
}

/** What the model is told about the cards it produced. */
export const SHOWN_AS =
  "the user sees these cards with your answer: refer to them (\"the chart\") without saying where they are on the screen, never say you lack a breakdown a card shows, do not repeat every number, cite the source";

/** A result with nothing to draw (0): no card goes with the answer. */
export const NO_CARD = "no card is shown for this: say the number in words and cite the source";

/** The cards in words, so the model knows what the user is looking at. */
export function cardsOf(blocks: Array<{ type: string; title: string; x?: { values: string[] }; items?: unknown[] }>, locale: Locale = "en"): string[] {
  const he = locale === "he";
  return blocks.map((b) =>
    b.type === "chart" ? `${b.title}: ${he ? `גרף עמודות על פני ${b.x?.values.length ?? 0} ימים` : `a bar chart over ${b.x?.values.length ?? 0} days`}`
    : b.type === "breakdown" ? `${b.title}: ${he ? `פילוח ל-${b.items?.length ?? 0} קבוצות` : `a breakdown of ${b.items?.length ?? 0} groups`}`
    : b.type === "record_list" ? `${b.title}: ${he ? `רשימה של ${b.items?.length ?? 0} שורות עם קישורים` : `a list of ${b.items?.length ?? 0} rows with links`}`
    : `${b.title}: ${he ? "כרטיס עם הפרטים" : "a card with its details"}`);
}

/** The full list behind a conversations source, with the caller's CURRENT visibility. */
export async function listConversationsForSource(
  tenantId: string, viewer: Viewer | undefined, locale: Locale, params: ConversationQuery, cursor: string | null,
): Promise<{ data: RecordListItem[]; nextCursor: string | null }> {
  const tz = await tenantTimeZone(tenantId);
  const where = await whereOf(tenantId, params, viewer, tz);
  const rows = await prisma.conversation.findMany({
    where, select: LIST_SELECT, orderBy: orderOf(params), take: LIST_PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, LIST_PAGE);
  return { data: await listItems(tenantId, page as any, locale, tz, !!params.now), nextCursor: rows.length > LIST_PAGE ? page[page.length - 1]!.id : null };
}
