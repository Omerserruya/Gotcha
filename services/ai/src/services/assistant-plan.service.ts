/**
 * A plan's steps, pinned when they are proposed (2026-10-08, the first Home
 * proposal): "assign me Omer's open conversation" was stored as
 * { assignee: "me", customerId } and resolved at execution, so "me" became
 * whoever APPROVED and "their open conversation" could be another one by
 * then. Now, at proposal:
 *   - a conversation step names its conversation (a customer's open one is
 *     looked up now, as the requester sees it) and its assignee (the
 *     requester for "me");
 *   - the requester must see what the step touches;
 *   - each step carries a machine-readable target, and the summary is
 *     written here from the steps, never from the model's prose.
 */
import { prisma, type Viewer } from "@chatcenter/shared";
import { channelName } from "./system-tools.service";
import { visibleConversation, customersConversation } from "./assistant-conversation-read.service";
import { visibleCustomer } from "./assistant-customers.service";
import { customerDisplayName } from "./assistant-query.service";

type Locale = "he" | "en";

export interface PlanCtx {
  tenantId: string;
  /** The person asking: the requester, and "me". */
  userId: string;
  viewer?: Viewer;
  locale: Locale;
  canReadContacts: boolean;
}

export interface PlanStep {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  riskLevel: "low" | "medium" | "high";
  /** What it acts on, for the approval card to link and name. */
  target: { conversationId?: string; customerId?: string; assigneeId?: string; questionId?: string };
  /** The step in words, in the turn's language. */
  summary: string;
}

export class PlanRefused extends Error {}

const CONVERSATION_ACTIONS = new Set(["claim_conversation", "assign_conversation", "close_conversation", "return_to_gotcha"]);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** A one-letter Hebrew prefix: joined to a Hebrew word, hyphenated before Latin letters or digits ("ל-Omer", "לנועה"). */
const heb = (letter: string, word: string) => (/^[A-Za-z0-9]/.test(word) ? `${letter}-${word}` : `${letter}${word}`);
const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 57)}...` : s}”`;

/** Generic wording for the actions that keep their own params. */
const OTHER: Record<string, Record<Locale, string>> = {
  send_message: { he: "לשלוח הודעה", en: "Send a message" },
  tag_contact: { he: "לתייג", en: "Tag" },
  schedule_followup: { he: "לתזמן הודעת המשך", en: "Schedule a follow-up" },
  schedule_meeting: { he: "לקבוע פגישה", en: "Book a meeting" },
  create_broadcast: { he: "ליצור קמפיין", en: "Create a campaign" },
  schedule_broadcast: { he: "לתזמן קמפיין", en: "Schedule a campaign" },
  create_workflow: { he: "ליצור אוטומציה", en: "Create an automation" },
  resolve_identity: { he: "לזהות את הלקוח", en: "Identify the customer" },
  merge_contacts: { he: "למזג את פרטי הלקוח", en: "Merge the customer's records" },
  link_customer_identifier: { he: "לקשר פרט מזהה ללקוח", en: "Link an identifier to the customer" },
};

async function userName(tenantId: string, userId: string): Promise<string | null> {
  const u = await prisma.user.findFirst({ where: { id: userId, tenantId, isActive: true }, select: { name: true, email: true } });
  return u ? (u.name || u.email || null) : null;
}

/** Each step pinned, checked against what the requester sees, and said in words. */
export async function preparePlan(ctx: PlanCtx, raw: Array<{ tool: string; params: Record<string, unknown>; reason: string; riskLevel: PlanStep["riskLevel"] }>): Promise<PlanStep[]> {
  const he = ctx.locale === "he";
  const out: PlanStep[] = [];
  for (const s of raw) {
    const p = { ...s.params };
    if (CONVERSATION_ACTIONS.has(s.tool)) {
      // The conversation, now: named, or the customer's open one as the requester sees it.
      let conversationId = str(p.conversationId);
      const customerId = str(p.customerId) ?? str(p.contactId);
      if (!conversationId && customerId) conversationId = await customersConversation(ctx, customerId);
      if (!conversationId) throw new PlanRefused("say which conversation (a customerId from system_find_customers, or a conversationId)");
      const c = await visibleConversation(ctx, conversationId);
      if (!c) throw new PlanRefused("conversation not found");
      if (c.status === "CLOSED" && s.tool !== "close_conversation") throw new PlanRefused("that conversation is closed");
      const who = customerDisplayName(c.customerName, c.customerExternalId, ctx.locale);
      const where = channelName(c.channel, ctx.locale);
      let tool = s.tool;
      const params: Record<string, unknown> = { conversationId: c.id };
      let assigneeId: string | undefined;
      let sentence: string;
      if (s.tool === "claim_conversation" || s.tool === "assign_conversation") {
        // "me" is the person asking, fixed now; never whoever approves.
        const asked = str(p.agentId) ?? str(p.assignee) ?? (s.tool === "claim_conversation" ? "me" : null);
        const departmentId = str(p.departmentId);
        if (!asked && !departmentId) throw new PlanRefused("say who to assign it to (\"me\", or a person's id)");
        if (asked) {
          assigneeId = asked === "me" ? ctx.userId : asked;
          const name = await userName(ctx.tenantId, assigneeId);
          if (!name) throw new PlanRefused("that person is not in this workspace");
          params.agentId = assigneeId;
          sentence = assigneeId === ctx.userId
            ? (he ? `לשייך אליך את השיחה של ${who} (${where})` : `Assign ${who}'s ${where} conversation to you`)
            : (he ? `לשייך את השיחה של ${who} (${where}) ${heb("ל", name)}` : `Assign ${who}'s ${where} conversation to ${name}`);
        } else {
          params.departmentId = departmentId;
          sentence = he ? `להעביר את השיחה של ${who} (${where}) למחלקה` : `Move ${who}'s ${where} conversation to a department`;
        }
        tool = "assign_conversation";
      } else if (s.tool === "close_conversation") {
        sentence = he ? `לסגור את השיחה של ${who} (${where})` : `Close ${who}'s ${where} conversation`;
      } else {
        sentence = he ? `להחזיר ל-GOTCHA את השיחה של ${who} (${where})` : `Return ${who}'s ${where} conversation to GOTCHA`;
      }
      out.push({ tool, params, reason: s.reason, riskLevel: s.riskLevel, target: { conversationId: c.id, ...(assigneeId ? { assigneeId } : {}) }, summary: sentence });
      continue;
    }
    if (s.tool === "add_note") {
      const customerId = str(p.contactId) ?? str(p.customerId);
      const body = str(p.body);
      if (!customerId || !body) throw new PlanRefused("a note needs the customer (customerId) and its text (body)");
      const customer = await visibleCustomer({ ...ctx, nextId: () => "", canReadContacts: ctx.canReadContacts }, customerId);
      if (!customer) throw new PlanRefused("customer not found");
      out.push({
        tool: s.tool, params: { contactId: customer.contactId, body }, reason: s.reason, riskLevel: s.riskLevel,
        target: { customerId: customer.contactId },
        summary: he ? `להוסיף הערה ${heb("ל", customer.name)}: ${quote(body)}` : `Add a note to ${customer.name}: ${quote(body)}`,
      });
      continue;
    }
    if (s.tool === "answer_question") {
      const questionId = str(p.unansweredQuestionId);
      const answer = str(p.answer);
      if (!questionId || !answer) throw new PlanRefused("an answer needs the question (unansweredQuestionId) and the answer");
      const q = await prisma.unansweredQuestion.findFirst({ where: { id: questionId, tenantId: ctx.tenantId }, select: { id: true, question: true } });
      if (!q) throw new PlanRefused("question not found");
      out.push({
        tool: s.tool, params: { unansweredQuestionId: q.id, answer }, reason: s.reason, riskLevel: s.riskLevel,
        target: { questionId: q.id },
        summary: he ? `לענות על השאלה ${quote(q.question)}` : `Answer the question ${quote(q.question)}`,
      });
      continue;
    }
    // The other actions keep their params; the customer, when named, is said by name.
    const customerId = str(p.contactId) ?? str(p.customerId);
    const customer = customerId ? await visibleCustomer({ ...ctx, nextId: () => "", canReadContacts: ctx.canReadContacts }, customerId) : null;
    if (customerId && !customer) throw new PlanRefused("customer not found");
    const words = OTHER[s.tool]?.[ctx.locale] ?? s.tool;
    out.push({
      tool: s.tool, params: p, reason: s.reason, riskLevel: s.riskLevel,
      target: { ...(customer ? { customerId: customer.contactId } : {}), ...(str(p.conversationId) ? { conversationId: str(p.conversationId)! } : {}) },
      summary: customer ? (he ? `${words}: ${customer.name}` : `${words}: ${customer.name}`) : words,
    });
  }
  return out;
}
