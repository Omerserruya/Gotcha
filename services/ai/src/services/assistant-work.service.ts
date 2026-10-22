/**
 * What is waiting for the business, for the assistant: approvals waiting for
 * a decision ("what's waiting for me?") and questions customers asked that
 * the AI could not answer. Each as rows linking to the screen that acts on
 * them (/approvals?id=<id>, /studio/knowledge?section=gaps).
 *
 * Approvals: the Approvals screen and Home's count (pending and not past
 * their expiry), every approval of the workspace, as that screen lists them;
 * one on a private number's conversation is not shown. Gaps: with
 * ai:knowledge:read, as the knowledge screen requires.
 */
import { prisma } from "@chatcenter/shared";
import { whenText } from "./system-tools.service";
import { tenantTimeZone, LIST_SHOWN_AS, NO_CARD, cardsOf, customerDisplayName } from "./assistant-query.service";
import { money } from "./assistant-commerce-query.service";
import { privateNumbers, conversationIsPrivate } from "../lib/private-numbers";
import { approvalSummaryFor } from "../lib/plan-summary";
import { riskOf } from "./assistant-approval-read.service";

type Locale = "he" | "en";
interface WorkCtx { tenantId: string; locale: Locale; nextId: (kind: "b" | "s") => string; viewerId?: string | null }

const FIRST_PAGE = 10;
const RISK: Record<string, Record<Locale, string>> = {
  low: { he: "סיכון נמוך", en: "Low risk" }, medium: { he: "סיכון בינוני", en: "Medium risk" },
  high: { he: "סיכון גבוה", en: "High risk" }, critical: { he: "סיכון קריטי", en: "Critical risk" },
};

export async function listApprovalsResult(ctx: WorkCtx) {
  const he = ctx.locale === "he";
  const now = new Date();
  const rows = await prisma.approvalRequest.findMany({
    where: { tenantId: ctx.tenantId, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, summary: true, tool: true, params: true, riskLevel: true, createdAt: true, expiresAt: true, conversationId: true, contactId: true },
  });
  // Who each one is about, and whether that conversation is a private number's.
  const convIds = [...new Set(rows.map((r) => r.conversationId).filter(Boolean))] as string[];
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
  const [convs, contacts, rules] = await Promise.all([
    convIds.length ? prisma.conversation.findMany({ where: { tenantId: ctx.tenantId, id: { in: convIds } }, select: { id: true, channel: true, customerExternalId: true, channelAccountId: true, customerName: true } }) : Promise.resolve([]),
    contactIds.length ? prisma.contact.findMany({ where: { tenantId: ctx.tenantId, id: { in: contactIds } }, select: { id: true, displayName: true, externalId: true } }) : Promise.resolve([]),
    privateNumbers(ctx.tenantId),
  ]);
  const convById = new Map(convs.map((c: any) => [c.id, c]));
  const contactById = new Map(contacts.map((c: any) => [c.id, c]));
  const visible = rows.filter((r) => !(r.conversationId && convById.has(r.conversationId) && conversationIsPrivate(convById.get(r.conversationId) as any, rules)));

  const total = visible.length;
  if (!total) return { summary: { ok: true, total: 0, shownAs: NO_CARD, cards: [] } };
  const tz = await tenantTimeZone(ctx.tenantId);
  const page = visible.slice(0, FIRST_PAGE);
  const items = page.map((r) => {
    const conv: any = r.conversationId ? convById.get(r.conversationId) : null;
    const contact: any = r.contactId ? contactById.get(r.contactId) : null;
    const who = contact?.displayName || conv?.customerName ? customerDisplayName(contact?.displayName ?? conv?.customerName, contact?.externalId ?? conv?.customerExternalId, ctx.locale) : null;
    const p = (r.params ?? {}) as Record<string, any>;
    const amount = Number(p.amount);
    const amountText = Number.isFinite(amount) && amount > 0 ? money(amount, typeof p.currency === "string" ? p.currency : null, ctx.locale) : null;
    return {
      id: r.id,
      // For this reader (an assignment to them is "you"); a plan's risk is its steps' own.
      title: (approvalSummaryFor(r, ctx.viewerId) || r.tool).slice(0, 140),
      subtitle: [who, amountText, RISK[riskOf(r)]?.[ctx.locale]].filter(Boolean).join(" · "),
      meta: he ? `ממתין מ-${whenText(r.createdAt, "he", tz)}` : `waiting since ${whenText(r.createdAt, "en", tz)}`,
      deepLink: `/approvals?id=${r.id}`,
      who, amountText,
    };
  });
  const sId = ctx.nextId("s");
  const blocks = [{
    type: "record_list" as const, id: ctx.nextId("b"), title: he ? "מחכים לאישור" : "Waiting for approval", sourceId: sId, kind: "approval" as const,
    items: items.map(({ who: _w, amountText: _a, ...i }) => i), total, hasMore: total > page.length, deepLink: null, partial: null,
  }];
  const source = { id: sId, kind: "approvals" as const, count: total, deepLink: "/approvals", label: he ? (total === 1 ? "אישור אחד ממתין" : `${total} אישורים ממתינים`) : `${total} waiting for approval`, query: { tool: "approvals" as const, params: {} } };
  return {
    summary: {
      ok: true, cite: sId, total,
      approvals: items.map((i) => ({ approvalId: i.id, what: i.title, customer: i.who, amount: i.amountText, since: i.meta })),
      ...(total > page.length ? { moreRows: total - page.length } : {}),
      shownAs: LIST_SHOWN_AS,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}

export async function listKnowledgeGapsResult(ctx: WorkCtx) {
  const he = ctx.locale === "he";
  const where = { tenantId: ctx.tenantId, resolvedAt: null };
  const [total, rows] = await Promise.all([
    prisma.unansweredQuestion.count({ where }),
    prisma.unansweredQuestion.findMany({ where, orderBy: [{ lastAskedAt: "desc" }, { id: "desc" }], take: FIRST_PAGE, select: { id: true, question: true, askCount: true, askedBy: true, lastAskedAt: true } }),
  ]);
  if (!total) return { summary: { ok: true, total: 0, shownAs: NO_CARD, cards: [] } };
  const tz = await tenantTimeZone(ctx.tenantId);
  const asked = (times: number, people: number) => he
    ? `${times === 1 ? "נשאלה פעם אחת" : `נשאלה ${times} פעמים`}${people > 1 ? `, על ידי ${people} אנשים` : ""}`
    : `asked ${times === 1 ? "once" : `${times} times`}${people > 1 ? ` by ${people} people` : ""}`;
  const items = rows.map((r) => ({
    id: r.id, title: r.question.slice(0, 200), subtitle: asked(r.askCount, r.askedBy),
    meta: he ? `לאחרונה ${whenText(r.lastAskedAt, "he", tz, false)}` : `last ${whenText(r.lastAskedAt, "en", tz, false)}`,
    deepLink: "/studio/knowledge?section=gaps",
  }));
  const sId = ctx.nextId("s");
  const blocks = [{
    type: "record_list" as const, id: ctx.nextId("b"), title: he ? "שאלות שלא נענו" : "Unanswered questions", sourceId: sId, kind: "question" as const,
    items, total, hasMore: total > items.length, deepLink: null, partial: null,
  }];
  const source = { id: sId, kind: "questions" as const, count: total, deepLink: "/studio/knowledge?section=gaps", label: he ? (total === 1 ? "שאלה אחת שלא נענתה" : `${total} שאלות שלא נענו`) : `${total} unanswered questions`, query: { tool: "knowledge_gaps" as const, params: {} } };
  return {
    summary: {
      ok: true, cite: sId, total,
      questions: rows.map((r) => ({ question: r.question.slice(0, 200), timesAsked: r.askCount, distinctAskers: r.askedBy })),
      ...(total > items.length ? { moreRows: total - items.length } : {}),
      answerHow: he ? "בעל העסק עונה עליהן במסך הידע, והתשובה הופכת לידע" : "the owner answers them on the knowledge screen, and the answer becomes knowledge",
      shownAs: LIST_SHOWN_AS,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}
