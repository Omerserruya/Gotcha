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

export async function notifyManagerOfApproval(tenantId: string, data: ApprovalEventData): Promise<void> {
  const approvalId = data.id;
  if (!approvalId) return;

  const riskLevel = String(data.riskLevel ?? "medium").toLowerCase();

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

  const adapter = getOutboundAdapter("WHATSAPP");
  if (!adapter?.sendInteractiveMessage) {
    await markNotifyState(approvalId, "skipped", "The WhatsApp channel does not support interactive approval buttons.");
    return;
  }

  // 3. Compose. Deliberately sparse: what + why + risk. No customer PII.
  const tool = data.tool ?? "an action";
  const summary = (data.summary ?? "").trim().slice(0, 300);
  const why = (data.reason ?? "").trim().slice(0, 200);
  const highRisk = REVIEW_IN_APP_RISK.has(riskLevel);

  const lines = [
    "*Approval needed*",
    `Action: ${tool}`,
    summary ? `What: ${summary}` : null,
    why ? `Why: ${why}` : null,
    `Risk: ${riskLevel}`,
    data.expiresAt ? `Expires: ${new Date(data.expiresAt).toUTCString()}` : null,
  ].filter(Boolean) as string[];

  try {
    if (highRisk) {
      // Above the one-tap ceiling: no decision buttons at all. The manager is
      // told it needs review in GOTCHA, where full context and identity checks
      // apply. (resolveApprovalRecipient already rejects when the recipient's
      // own cap is lower; this is the product-wide floor.)
      lines.push("", "This is a high-risk action - open GOTCHA to review and decide.");
      await adapter.sendTextMessage(sender.credentials, sender.externalId, resolved.recipient.phoneE164, lines.join("\n"));
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
      lines.join("\n"),
      [
        { id: refs.approve, title: "Approve" },
        { id: refs.reject, title: "Reject" },
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
