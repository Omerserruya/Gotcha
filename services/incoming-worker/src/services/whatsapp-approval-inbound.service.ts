/**
 * Handle a manager tapping Approve/Reject on WhatsApp.
 *
 * This runs BEFORE the normal inbound pipeline. A manager's decision is not a
 * customer conversation: letting it through would create a contact and a
 * conversation for a staff phone number and hand it to the bot.
 *
 * Trust model - the tap proves only that someone holding that phone pressed a
 * button, so every fact is re-derived server-side:
 *   1. the opaque handle is consumed (single use, atomically);
 *   2. the approval row is re-read and must still be PENDING for this tenant;
 *   3. the tool is matched against what the handle was minted for;
 *   4. the sender's number must be the number we sent it to;
 *   5. the recipient's authorisation is RE-CHECKED (they may have been
 *      removed, demoted, or disabled since the message was sent);
 *   6. the decision goes through the same atomic CAS the web UI uses, so a
 *      phone tap racing a browser click cannot double-decide.
 */

import {
  prisma,
  consumeApprovalRef,
  isApprovalRef,
  userMayApprove,
  approveRequest,
  rejectRequest,
  revokeApprovalRefs,
  getOutboundAdapter,
  decryptCredentials,
  type ChannelCredentials,
} from "@chatcenter/shared";

export interface InboundApprovalResult {
  /** True when this message was an approval decision and must not continue
   *  into the normal customer pipeline. */
  handled: boolean;
}

/** Reply to the manager on the same thread. Best effort - never throws. */
async function replyToManager(
  tenantId: string,
  toPhone: string,
  text: string,
): Promise<void> {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { tenantId, channel: "WHATSAPP", isActive: true },
      select: { externalId: true, credentials: true },
    });
    if (!account?.credentials || !account.externalId) return;
    const adapter = getOutboundAdapter("WHATSAPP");
    if (!adapter) return;
    await adapter.sendTextMessage(
      decryptCredentials(account.credentials as any) as ChannelCredentials,
      account.externalId,
      toPhone,
      text,
    );
  } catch (err: any) {
    console.warn("[wa-approval-in] could not reply to manager:", err?.message);
  }
}

/**
 * @param buttonPayload the reply-button id from the inbound interactive message
 * @param senderPhone   the E.164 number that sent it
 */
export async function handleApprovalButtonReply(
  buttonPayload: string | undefined,
  senderPhone: string,
): Promise<InboundApprovalResult> {
  if (!isApprovalRef(buttonPayload)) return { handled: false };

  // (1) Burn the handle. Unknown / expired / already-used are indistinguishable
  // to the sender by design.
  const binding = await consumeApprovalRef(buttonPayload!);
  if (!binding) {
    // We do not know the tenant here, so we cannot reply on their channel.
    // Silence is correct: an unknown handle may be someone probing.
    console.warn("[wa-approval-in] unknown/expired/replayed approval handle");
    return { handled: true };
  }

  const { tenantId, approvalId, recipientUserId, decision, tool } = binding;

  // (2) The request must still exist, belong to this tenant, and be undecided.
  const row = await (prisma as any).approvalRequest.findFirst({
    where: { id: approvalId, tenantId },
    select: { id: true, status: true, tool: true, expiresAt: true },
  });
  if (!row) {
    console.warn(`[wa-approval-in] approval ${approvalId} not found for tenant`);
    return { handled: true };
  }
  if (row.status !== "PENDING") {
    await replyToManager(tenantId, senderPhone, `This request was already ${String(row.status).toLowerCase()}. No action taken.`);
    return { handled: true };
  }
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    await replyToManager(tenantId, senderPhone, "This request has expired, so it can no longer be approved. Open GOTCHA if it still needs doing.");
    return { handled: true };
  }

  // (3) The handle must have been minted for THIS action.
  if (tool && row.tool && tool !== row.tool) {
    console.error(`[wa-approval-in] tool mismatch for ${approvalId}: handle=${tool} row=${row.tool}`);
    return { handled: true };
  }

  // (4) The tap must come from the number we sent it to. A forwarded message
  // tapped on another handset is not the approver.
  const recipientRow = await (prisma as any).approvalRecipient.findFirst({
    where: { tenantId, userId: recipientUserId, channel: "whatsapp" },
    select: { phoneE164: true, enabled: true },
  });
  const normalizedSender = senderPhone.startsWith("+") ? senderPhone : `+${senderPhone}`;
  if (!recipientRow?.enabled || recipientRow.phoneE164 !== normalizedSender) {
    console.error(`[wa-approval-in] sender/recipient mismatch on ${approvalId}`);
    await replyToManager(tenantId, senderPhone, "This approval link isn't valid for this number.");
    return { handled: true };
  }

  // (5) Re-authorise NOW, not when the message was sent.
  if (!(await userMayApprove(tenantId, recipientUserId))) {
    await replyToManager(tenantId, senderPhone, "You no longer have permission to approve actions in this workspace.");
    console.warn(`[wa-approval-in] ${recipientUserId} no longer authorised on ${tenantId}`);
    return { handled: true };
  }

  // (6) Decide through the SAME atomic path the web UI uses.
  if (decision === "reject") {
    const rejected = await rejectRequest(
      tenantId, approvalId, recipientUserId, "Rejected by manager via WhatsApp",
      { decisionChannel: "whatsapp", correlationId: approvalId },
    );
    await revokeApprovalRefs(approvalId);
    // The manager is not the only person owed an answer. Without this the
    // customer - who was told their cancellation was being handled - simply
    // never heard again, which is indistinguishable from being ignored.
    if (rejected) await triggerRejectedDispatch(tenantId, approvalId);
    await replyToManager(
      tenantId, senderPhone,
      rejected ? "Rejected. The action will not run, and I've let the customer know." : "This request was already decided elsewhere.",
    );
    return { handled: true };
  }

  const approved = await approveRequest(
    tenantId, approvalId, recipientUserId, undefined, "Approved by manager via WhatsApp",
    { decisionChannel: "whatsapp", correlationId: approvalId },
  );
  await revokeApprovalRefs(approvalId);
  if (!approved) {
    await replyToManager(tenantId, senderPhone, "This request was already decided elsewhere.");
    return { handled: true };
  }

  // Approval is recorded; EXECUTION is owned by the conversation service's
  // dispatch path (claim → execute → record → notify-customer-once). We only
  // acknowledge the decision here, and deliberately do NOT tell the manager
  // the action succeeded - it has not run yet.
  await replyToManager(tenantId, senderPhone, "Approved. I'll run it now and update the customer once it's done.");
  await triggerApprovedDispatch(tenantId, approvalId);
  return { handled: true };
}

/**
 * Ask the conversation service to run the approved action, using the same
 * endpoint the web UI drives. Keeping ONE execution path means the WhatsApp
 * route inherits the execution state machine, idempotency, and the
 * once-only customer notification for free.
 */
async function triggerApprovedDispatch(tenantId: string, approvalId: string): Promise<void> {
  const base = process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002";
  try {
    const res = await fetch(`${base}/api/approvals/${approvalId}/dispatch-approved`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({ source: "whatsapp" }),
    });
    if (!res.ok) {
      console.error(`[wa-approval-in] dispatch failed for ${approvalId}: ${res.status}`);
    }
  } catch (err: any) {
    // The row stays APPROVED + NOT_STARTED, which is exactly the state a
    // retry sweeper can pick up. Nothing is lost.
    console.error(`[wa-approval-in] dispatch call failed for ${approvalId}:`, err?.message);
  }
}

/**
 * Tell the customer their request was declined, through the SAME endpoint the
 * web reject route uses - so the once-only claim, the message wording and the
 * return of the conversation to the AI are identical on both channels.
 *
 * The decision is already durable when this runs; a failure here leaves a
 * REJECTED row with no customerNotifiedAt, which is precisely what a sweeper
 * looks for.
 */
async function triggerRejectedDispatch(tenantId: string, approvalId: string): Promise<void> {
  const base = process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002";
  try {
    const res = await fetch(`${base}/api/approvals/${approvalId}/dispatch-rejected`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({ source: "whatsapp" }),
    });
    if (!res.ok) {
      console.error(`[wa-approval-in] rejection notice failed for ${approvalId}: ${res.status}`);
    }
  } catch (err: any) {
    console.error(`[wa-approval-in] rejection notice call failed for ${approvalId}:`, err?.message);
  }
}
