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

const RISK_ORDER = ["low", "medium", "high", "critical"];
/** Tags said in words; any other tag is internal and not shown. */
const TAG_WORDS: Record<string, Record<Locale, string>> = {
  FINANCIAL: { he: "כרוך בכסף", en: "involves money" },
  IRREVERSIBLE: { he: "אי אפשר לבטל אחרי שמבוצע", en: "cannot be undone once done" },
};

/**
 * Why this request waits for a person, as the gate decided it and never
 * guessed: a plan proposed from Home or the command bar always waits (by
 * design); a tool gated by the approval settings says which setting. The
 * stored rule name of a plan was the requester sentence ("a request of X from
 * GOTCHA in Home"), which is not a rule, and the model filled the gap with an
 * invented risk story (2026-10-08).
 */
export function whyItWaits(a: { tool: string; params: unknown; policyRuleName: string | null; riskLevel: string; riskTags: unknown }, locale: Locale): string {
  const he = locale === "he";
  const p = (a.params ?? {}) as Record<string, any>;
  if (a.tool === "propose_plan") {
    const where = p.source === "command_bar" ? (he ? "משורת הפקודה" : "from the command bar") : (he ? "מ-Home" : "from Home");
    return he ? `כל פעולה ש-GOTCHA מציעה ${where} מחכה לאישור` : `Every action GOTCHA proposes ${where} waits for approval`;
  }
  const rule = String(a.policyRuleName ?? "").trim();
  const condition = /^condition matched: (.+)$/.exec(rule)?.[1];
  const gate = condition
    ? (he ? `לפי הגדרות האישורים, הפעולה הזו דורשת אישור כש: ${condition}` : `The approval settings require approval when: ${condition}`)
    : /^policy requires approval\b/.test(rule)
      ? (he ? "לפי הגדרות האישורים, הפעולה הזו דורשת אישור תמיד" : "The approval settings say this action always needs approval")
      : rule ? (he ? `כלל: ${rule}` : `Rule: ${rule}`) : null;
  const tags = (Array.isArray(a.riskTags) ? (a.riskTags as unknown[]) : []).map((t) => TAG_WORDS[String(t).toUpperCase()]?.[locale]).filter(Boolean);
  return [gate, tags.length ? tags.join(", ") : null].filter(Boolean).join(" · ");
}

/** The risk the request carries: a plan's is its highest step's, never another. */
export function riskOf(a: { tool: string; params: unknown; riskLevel: string }): string {
  const steps = (a.params as any)?.steps;
  if (a.tool === "propose_plan" && Array.isArray(steps) && steps.length) {
    const levels = steps.map((s: any) => RISK_ORDER.indexOf(String(s?.riskLevel ?? "").toLowerCase())).filter((i: number) => i >= 0);
    if (levels.length) return RISK_ORDER[Math.max(...levels)];
  }
  return String(a.riskLevel).toLowerCase();
}

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
  const why = whyItWaits(a as any, ctx.locale);
  const risk = riskOf(a as any);
  const riskWords = RISK[risk]?.[ctx.locale] ?? risk;
  const customer = c ? customerDisplayName(c.customerName, c.customerExternalId, ctx.locale) : null;
  const steps = Array.isArray(p.steps) ? (p.steps as any[]).map((s) => String(s?.summary ?? s?.tool ?? "")).filter(Boolean) : null;
  const sId = ctx.nextId("s");
  const deepLink = `/approvals?id=${a.id}`;
  const fields = [
    { key: "what", label: he ? "מה" : "What", value: a.summary },
    ...(steps?.length ? [{ key: "steps", label: he ? "צעדים" : "Steps", value: steps.join("; ") }] : [{ key: "action", label: he ? "פעולה" : "Action", value: a.tool }]),
    { key: "why", label: he ? "למה צריך אישור" : "Why it needs approval", value: why },
    { key: "risk", label: he ? "רמת סיכון" : "Risk", value: riskWords },
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
      // The gate's own words; the risk is the steps' own. Never a reason of your own.
      whyItNeedsApproval: why, risk: riskWords, askedBy,
      // What the AI employee said it was doing (a plan's is only who asked, said above).
      ...(a.tool !== "propose_plan" && a.reason ? { whyTheActionWasRequested: a.reason } : {}),
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
