/**
 * Send an approval request to the configured manager on WhatsApp.
 *
 * Design constraints that shaped this:
 *
 *  • OPT-IN. Nothing is sent unless the tenant created an ApprovalRecipient
 *    row AND enabled it. There is no implicit "notify an admin" fallback.
 *  • THE BUTTON CARRIES NOTHING. Reply-button ids are opaque handles minted by
 *    `mintApprovalRefs`; the tenant, tool, customer and decision live only in
 *    Redis. A screenshot of the message leaks no state.
 *  • MINIMAL CONTEXT. Enough to decide safely (what action, why, risk), never
 *    the customer's personal data. The manager opens GOTCHA for detail.
 *  • FAILURE IS VISIBLE. Skips and errors are written to the ApprovalRequest
 *    so the in-app inbox can say "not sent, and here's why" instead of leaving
 *    an operator wondering.
 *
 * The approval always exists in the in-app inbox regardless - WhatsApp is an
 * accelerator, never the system of record.
 */

import {
  prisma,
  getOutboundAdapter,
  decryptCredentials,
  mintApprovalRefs,
  resolveApprovalRecipient,
  recipientRejectionMessage,
  type ChannelCredentials,
} from "@chatcenter/shared";
import { localeForRecipient, type TemplateLocale } from "./platform-whatsapp";
import { workspaceTimeZone } from "./personal-preferences.service";

/** Risk levels above this are never one-tap; the manager is sent to the UI. */
const REVIEW_IN_APP_RISK = new Set(["high", "critical"]);

interface ApprovalEventData {
  id?: string;
  tool?: string;
  summary?: string;
  reason?: string;
  riskLevel?: string;
  conversationId?: string | null;
  expiresAt?: string;
  requestedBy?: string;
}

/** A plan's steps, who asked and where (event-bridge planOf). */
export interface PingPlan { steps?: unknown; requester?: { userId?: string; name?: string } | null; source?: string | null }

const RISK_ORDER = ["low", "medium", "high", "critical"];
const RISK_WORDS: Record<string, Record<TemplateLocale, string>> = {
  low: { he: "נמוך", en: "low" }, medium: { he: "בינוני", en: "medium" }, high: { he: "גבוה", en: "high" }, critical: { he: "קריטי", en: "critical" },
};

/** A plan's risk is its highest step's, never another. */
function riskOf(data: ApprovalEventData, plan: PingPlan | null): string {
  const steps = plan?.steps;
  if (Array.isArray(steps) && steps.length) {
    const i = Math.max(...steps.map((s: any) => RISK_ORDER.indexOf(String(s?.riskLevel ?? "").toLowerCase())));
    if (i >= 0) return RISK_ORDER[i]!;
  }
  return String(data.riskLevel ?? "medium").toLowerCase();
}

/** A plan's steps for this reader: an assignment to them is "you" (twin of lib/plan-summary). */
function planSummaryFor(steps: unknown, viewerId: string): string | null {
  if (!Array.isArray(steps) || !steps.length) return null;
  const said = (steps as any[]).map((st) => {
    const forAssignee = typeof st?.summaryForAssignee === "string" ? st.summaryForAssignee : null;
    return forAssignee && st?.target?.assigneeId === viewerId ? forAssignee : typeof st?.summary === "string" ? st.summary : "";
  }).filter(Boolean);
  return said.length ? said.join("; ") : null;
}

/**
 * The message the approver reads, in their language: never a tool's raw name
 * (it said "Action: propose_plan"), a plan as who asked and its steps in the
 * reader's words, GOTCHA feminine, the reader addressed without a gender.
 */
export function approvalPingText(data: ApprovalEventData, plan: PingPlan | null, o: { locale: TemplateLocale; recipientUserId: string; timeZone?: string }) {
  const he = o.locale === "he";
  const risk = riskOf(data, plan);
  const highRisk = REVIEW_IN_APP_RISK.has(risk);
  let what: string;
  if (plan) {
    const said = (planSummaryFor(plan.steps, o.recipientUserId) ?? data.summary ?? "").trim().slice(0, 300);
    const mine = plan.requester?.userId === o.recipientUserId;
    const name = (plan.requester?.name ?? "").trim();
    const bar = plan.source === "command_bar";
    what = he
      ? `${mine ? "ביקשת" : name ? `${name} ביקש/ה` : "מישהו מהצוות ביקש/ה"} מ-GOTCHA ${bar ? "בשורת הפקודה" : "ב-Home"}${said ? `: ${said}` : ""}`
      : `${mine ? "You asked" : name ? `${name} asked` : "Someone on the team asked"} GOTCHA ${bar ? "in the command bar" : "in Home"}${said ? `: ${said}` : ""}`;
  } else {
    const summary = (data.summary ?? "").trim().slice(0, 300);
    const flow = String(data.requestedBy ?? "").startsWith("flow:");
    what = he
      ? `${flow ? "אוטומציה מבקשת" : "GOTCHA מבקשת"} אישור${summary ? `: ${summary}` : " לפעולה"}`
      : `${flow ? "An automation" : "GOTCHA"} is asking for approval${summary ? `: ${summary}` : " for an action"}`;
  }
  // The AI's own reasoning for a request it raised; a plan's "reason" is only who asked, said above.
  const why = plan ? "" : (data.reason ?? "").trim().slice(0, 200);
  let expires: string | null = null;
  if (data.expiresAt) {
    const d = new Date(data.expiresAt);
    if (!Number.isNaN(d.getTime())) {
      const fmt = (timeZone: string) => new Intl.DateTimeFormat(he ? "he-IL" : "en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
      try { expires = fmt(o.timeZone || "UTC"); } catch { expires = fmt("UTC"); }
    }
  }
  const lines = [
    he ? "*נדרש אישור*" : "*Approval needed*",
    what,
    why ? (he ? `סיבה: ${why}` : `Why: ${why}`) : null,
    `${he ? "סיכון" : "Risk"}: ${RISK_WORDS[risk]?.[o.locale] ?? risk}`,
    expires ? `${he ? "בתוקף עד" : "Expires"}: ${expires}` : null,
    ...(highRisk ? ["", he ? "זו פעולה בסיכון גבוה, ולכן מחליטים עליה ב-GOTCHA ולא כאן." : "This is a high-risk action - open GOTCHA to review and decide."] : []),
  ].filter((x): x is string => x !== null);
  return {
    text: lines.join("\n"),
    highRisk,
    buttons: { approve: he ? "לאשר" : "Approve", reject: he ? "לדחות" : "Reject" },
  };
}

async function markNotifyState(
  approvalId: string,
  state: "sent" | "skipped" | "failed",
  reason?: string,
): Promise<void> {
  await (prisma as any).approvalRequest
    .updateMany({
      where: { id: approvalId },
      data: {
        managerNotifyState: state,
        managerNotifyReason: reason ?? null,
        managerNotifiedAt: state === "sent" ? new Date() : null,
      },
    })
    .catch((err: any) => console.warn("[wa-approval] could not record notify state:", err?.message));
}

/**
 * Resolve the tenant's WhatsApp sending account. Without one there is no way
 * to reach anybody - a distinct, actionable reason from "no recipient".
 */
async function resolveWhatsAppSender(tenantId: string) {
  const account = await prisma.channelAccount.findFirst({
    where: { tenantId, channel: "WHATSAPP", isActive: true },
    select: { id: true, externalId: true, credentials: true },
  });
  if (!account?.credentials || !account.externalId) return null;
  try {
    return {
      externalId: account.externalId,
      credentials: decryptCredentials(account.credentials as any) as ChannelCredentials,
    };
  } catch {
    return null;
  }
}

export async function notifyManagerOfApproval(tenantId: string, data: ApprovalEventData, plan: PingPlan | null = null): Promise<void> {
  const approvalId = data.id;
  if (!approvalId) return;

  const riskLevel = riskOf(data, plan);

  // 1. Is there someone we are allowed to ask?
  const resolved = await resolveApprovalRecipient(tenantId, { riskLevel });
  if (!resolved.ok) {
    await markNotifyState(approvalId, "skipped", recipientRejectionMessage(resolved.reason));
    console.log(`[wa-approval] ${approvalId} not sent (${resolved.reason})`);
    return;
  }

  // 2. Can this tenant send WhatsApp at all?
  const sender = await resolveWhatsAppSender(tenantId);
  if (!sender) {
    await markNotifyState(approvalId, "skipped", "No active WhatsApp channel is connected, so approval requests cannot be delivered there.");
    return;
  }

  // The person who proposed a plan in Home or the command bar is looking at it.
  const fromHome = plan && (plan.source === "home_assistant" || plan.source === "command_bar");
  if (fromHome && plan.requester?.userId && plan.requester.userId === resolved.recipient.userId) {
    await markNotifyState(approvalId, "skipped", "The approver is the person who proposed this plan in GOTCHA, so it was not sent to them again.");
    return;
  }

  const adapter = getOutboundAdapter("WHATSAPP");
  if (!adapter?.sendInteractiveMessage) {
    await markNotifyState(approvalId, "skipped", "The WhatsApp channel does not support interactive approval buttons.");
    return;
  }

  // 3. Compose, in the approver's language. Deliberately sparse: what + why + risk. No customer PII.
  const ping = approvalPingText(data, plan, {
    locale: await localeForRecipient(tenantId, resolved.recipient.userId),
    recipientUserId: resolved.recipient.userId,
    timeZone: await workspaceTimeZone(tenantId),
  });
  const highRisk = ping.highRisk;

  try {
    if (highRisk) {
      // Above the one-tap ceiling: no decision buttons at all. The manager is
      // told it needs review in GOTCHA, where full context and identity checks
      // apply. (resolveApprovalRecipient already rejects when the recipient's
      // own cap is lower; this is the product-wide floor.)
      await adapter.sendTextMessage(sender.credentials, sender.externalId, resolved.recipient.phoneE164, ping.text);
      await markNotifyState(approvalId, "sent", "Sent for in-app review (high risk - no one-tap buttons).");
      return;
    }

    // 4. Mint one opaque handle per decision, bound to tenant + request +
    //    recipient + tool. Nothing about the business is in the button id.
    const refs = await mintApprovalRefs({
      tenantId,
      approvalId,
      recipientUserId: resolved.recipient.userId,
      tool: data.tool ?? "",
      channel: "whatsapp",
    });

    await adapter.sendInteractiveMessage(
      sender.credentials,
      sender.externalId,
      resolved.recipient.phoneE164,
      ping.text,
      [
        { id: refs.approve, title: ping.buttons.approve },
        { id: refs.reject, title: ping.buttons.reject },
      ],
    );
    await markNotifyState(approvalId, "sent");
    console.log(`[wa-approval] ${approvalId} sent to configured approver`);
  } catch (err: any) {
    // Never let a delivery problem hide the approval - it is already in the
    // inbox; we just record why the phone never rang.
    await markNotifyState(approvalId, "failed", `WhatsApp delivery failed: ${err?.message ?? "unknown error"}`);
    console.warn(`[wa-approval] ${approvalId} delivery failed:`, err?.message);
  }
}
