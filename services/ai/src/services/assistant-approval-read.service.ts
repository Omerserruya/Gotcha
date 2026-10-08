/**
 * One approval request, read for the assistant (design 03: "ask about a
 * request"): what it is, the action and its parameters, why it needs
 * approval, who asked, about which customer and conversation, its state.
 *
 * Read only: the assistant explains a request, it never decides one (there
 * is no tool for that). Visibility: the workspace's, as the Approvals screen
 * lists them, and when the request is tied to a conversation, only if the
 * caller can see that conversation (the inbox's rule; private numbers read
 * as not found). Anything else reads as not found.
 */
import { prisma, visibilityClause, type Viewer } from "@chatcenter/shared";
import { channelName, whenText } from "./system-tools.service";
import { tenantTimeZone, customerDisplayName, RECORD_SHOWN_AS, cardsOf } from "./assistant-query.service";
import { privateNumbers, conversationIsPrivate } from "../lib/private-numbers";

type Locale = "he" | "en";
export interface ApprovalReadCtx { tenantId: string; viewer?: Viewer; locale: Locale; nextId: (k: "b" | "s") => string }

const SECRET = /(token|secret|password|api[_-]?key|authorization|credential|refresh)/i;
/** The action's parameters as the card may show them: no secrets, bounded. */
function shownParams(v: unknown, depth = 0): unknown {
  if (v == null || depth > 3) return null;
  if (typeof v === "string") return v.slice(0, 300);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => shownParams(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) out[k] = SECRET.test(k) ? "[hidden]" : shownParams(x, depth + 1);
    return out;
  }
  return null;
}

const STATE: Record<string, Record<Locale, string>> = {
  PENDING: { he: "ממתינה להחלטה", en: "Waiting for a decision" }, APPROVED: { he: "אושרה", en: "Approved" },
  REJECTED: { he: "נדחתה", en: "Rejected" }, EXPIRED: { he: "פגה", en: "Expired" },
};
const RISK: Record<string, Record<Locale, string>> = {
  low: { he: "נמוך", en: "Low" }, medium: { he: "בינוני", en: "Medium" }, high: { he: "גבוה", en: "High" }, critical: { he: "קריטי", en: "Critical" },
};

/** The request if this caller may read it, else null (as if it did not exist). */
export async function readableApproval(ctx: Pick<ApprovalReadCtx, "tenantId" | "viewer">, approvalId: string) {
  if (!approvalId || !ctx.viewer?.userId) return null;
  const a = await prisma.approvalRequest.findFirst({ where: { id: approvalId, tenantId: ctx.tenantId } });
  if (!a) return null;
  let conversation: any = null;
  if (a.conversationId) {
    const clause = visibilityClause(ctx.viewer);
    conversation = await prisma.conversation.findFirst({
      where: { id: a.conversationId, tenantId: ctx.tenantId, ...(clause ? { OR: clause } : {}) },
      select: { id: true, channel: true, customerExternalId: true, customerName: true, channelAccountId: true, status: true },
    });
    if (!conversation || conversationIsPrivate(conversation, await privateNumbers(ctx.tenantId))) return null;
  }
  return { approval: a, conversation };
}

export async function readApprovalResult(ctx: ApprovalReadCtx, approvalId: string) {
  const r = await readableApproval(ctx, approvalId);
  if (!r) return { summary: { ok: false, error: "approval request not found" } };
  const { approval: a, conversation: c } = r;
  const he = ctx.locale === "he";
  const tz = await tenantTimeZone(ctx.tenantId);
  const p = (a.params ?? {}) as Record<string, any>;
  const requester = p.requester && typeof p.requester === "object" ? (p.requester.name ?? null) : null;
  const askedBy = requester
    ? requester
    : a.requestedBy === "bot" || a.requestedBy.startsWith("ai-agent:") ? "GOTCHA"
    : a.requestedBy.startsWith("flow:") ? (he ? "אוטומציה" : "An automation")
    : (he ? "משתמש בצוות" : "A team member");
  const tags = Array.isArray(a.riskTags) ? (a.riskTags as unknown[]).map(String) : [];
  const why = [
    a.policyRuleName ? (he ? `כלל: ${a.policyRuleName}` : `Rule: ${a.policyRuleName}`) : null,
    `${he ? "סיכון" : "Risk"}: ${RISK[String(a.riskLevel).toLowerCase()]?.[ctx.locale] ?? a.riskLevel}`,
    tags.length ? tags.join(", ") : null,
  ].filter(Boolean).join(" · ");
  const customer = c ? customerDisplayName(c.customerName, c.customerExternalId, ctx.locale) : null;
  const steps = Array.isArray(p.steps) ? (p.steps as any[]).map((s) => String(s?.summary ?? s?.tool ?? "")).filter(Boolean) : null;
  const sId = ctx.nextId("s");
  const deepLink = `/approvals?id=${a.id}`;
  const fields = [
    { key: "what", label: he ? "מה" : "What", value: a.summary },
    ...(steps?.length ? [{ key: "steps", label: he ? "צעדים" : "Steps", value: steps.join("; ") }] : [{ key: "action", label: he ? "פעולה" : "Action", value: a.tool }]),
    { key: "why", label: he ? "למה צריך אישור" : "Why it needs approval", value: why },
    { key: "asked_by", label: he ? "מי ביקש" : "Asked by", value: askedBy },
    ...(customer ? [{ key: "customer", label: he ? "לקוח" : "Customer", value: `${customer} (${channelName(c.channel, ctx.locale)})` }] : []),
    { key: "state", label: he ? "מצב" : "State", value: STATE[a.status]?.[ctx.locale] ?? a.status },
    { key: a.status === "PENDING" ? "expires" : "created", label: a.status === "PENDING" ? (he ? "פוקעת" : "Expires") : (he ? "נוצרה" : "Created"), value: whenText(a.status === "PENDING" ? a.expiresAt : a.createdAt, ctx.locale, tz) },
  ];
  // The state and expiry as data too, so the card can say them and never offer a decided request as askable.
  const blocks = [{ type: "record" as const, id: ctx.nextId("b"), title: a.summary.slice(0, 140), sourceId: sId, kind: "approval" as const, fields, deepLink, partial: null, state: String(a.status).toLowerCase(), expiresAt: a.expiresAt.toISOString() }];
  const source = { id: sId, kind: "approval" as const, count: null, deepLink, label: he ? "בקשת האישור" : "The approval request", query: { tool: "approval" as const, params: { approvalId: a.id } } };
  return {
    summary: {
      ok: true, cite: sId, approvalId: a.id,
      what: a.summary, action: a.tool, parameters: shownParams(a.modifiedParams ?? a.params),
      whyItNeedsApproval: why, reasonGiven: a.reason, askedBy,
      customer, conversationId: c?.id ?? null, conversationLink: c ? `/inbox?c=${c.id}` : null,
      state: STATE[a.status]?.[ctx.locale] ?? a.status,
      ...(a.status === "PENDING" ? { expires: whenText(a.expiresAt, ctx.locale, tz) } : { decided: a.decidedAt ? whenText(a.decidedAt, ctx.locale, tz) : null }),
      readOnly: he
        ? "אפשר להסביר את הבקשה; לאשר או לדחות אותה עושים במסך האישורים"
        : "you can explain this request; approving or rejecting it is done on the Approvals screen",
      shownAs: RECORD_SHOWN_AS,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}
