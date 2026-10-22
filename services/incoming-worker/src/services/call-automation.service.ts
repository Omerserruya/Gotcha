/**
 * "Call missed" / "Call answered" automations (Studio > Automations).
 *
 * The shared call-state transition queues one automation-event per inbound
 * call that was missed, or answered and ended. Here it becomes a run: the
 * reply goes to the caller on WhatsApp (their existing conversation, else a
 * new one on the workspace's WhatsApp number). A call is not a WhatsApp
 * message, so the 24 h window is usually closed: the validator allows only a
 * template on these automations.
 *
 *   no WhatsApp number / no caller number → run recorded skipped (no_reachable_customer)
 *   the caller opted out of WhatsApp      → skipped (opted_out)
 *   a person or another run owns the chat → skipped (conversation_busy)
 *   otherwise                             → one run per automation per call
 */
import { prisma } from "@chatcenter/shared";
import { runAutomationsForEvent } from "./automation-runner.service";
import { resolveCartTarget } from "./cart.service";

export type CallTrigger = "call_missed" | "call_answered";

/** "3:07" from milliseconds; "" when unknown. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Variables a call automation can write. */
export function callVariables(session: any): Record<string, string> {
  const ms = session.durationMs ?? (session.answeredAt && session.endedAt ? +new Date(session.endedAt) - +new Date(session.answeredAt) : null);
  return {
    caller_number: String(session.customerNumber ?? ""),
    line_name: String(session.channel?.friendlyName ?? ""),
    call_duration: formatDuration(ms),
    // Usually not ready when the call ends (the provider processes it after).
    call_recording_url: session.recordingStatus === "available" ? String(session.recordingUrl ?? "") : "",
  };
}

/** The automations of this type that listen on this call's line (`lines`: voice line ids; none = every line). */
export function onLine(flows: Array<{ id: string; triggerConfig: any }>, channelId: string | null): string[] {
  return flows
    .filter((f) => {
      const lines: string[] = Array.isArray(f.triggerConfig?.lines) ? f.triggerConfig.lines.map(String) : [];
      return !lines.length || (!!channelId && lines.includes(channelId));
    })
    .map((f) => f.id);
}

export async function onCallEvent(ev: { tenantId: string; type: CallTrigger; sessionId: string }): Promise<{ outcome: string }> {
  const session = await prisma.voiceCallSession.findFirst({
    where: { id: ev.sessionId, tenantId: ev.tenantId },
    select: {
      id: true, direction: true, customerNumber: true, channelId: true, answeredAt: true, endedAt: true, durationMs: true,
      recordingUrl: true, recordingStatus: true, channel: { select: { friendlyName: true } },
    },
  });
  if (!session || session.direction !== "inbound") return { outcome: "no_session" };
  const flows = await prisma.chatbotFlow.findMany({
    where: { tenantId: ev.tenantId, isActive: true, triggerType: ev.type },
    select: { id: true, triggerConfig: true },
  });
  const ids = onLine(flows as any[], session.channelId ?? null);
  if (!ids.length) return { outcome: "no_automation" };
  const eventKey = `call:${session.id}`;

  const number = String(session.customerNumber ?? "");
  const target = /\d{7,}/.test(number.replace(/\D/g, "")) ? await resolveCartTarget(ev.tenantId, { phone: number }, { whatsappOnly: true }) : null;
  const optedOut = !!target && (Array.isArray(target.contact?.optOutChannels) ? target.contact.optOutChannels : []).map((x: any) => String(x).toUpperCase()).includes("WHATSAPP");
  const busy = !!target && !!(target.conversation.assignedAgentId || target.conversation.isHandedOver || target.conversation.automationRunId);
  const skip = !target ? "no_reachable_customer" : optedOut ? "opted_out" : busy ? "conversation_busy" : null;
  if (skip) {
    // Recorded, so the run log says why nobody was written to.
    for (const flowId of ids) {
      await prisma.automationRun.create({
        data: {
          tenantId: ev.tenantId, flowId, triggerType: ev.type, eventKey,
          conversationId: target?.conversation.id ?? null, contactId: target?.contact?.id ?? null,
          status: "skipped", error: skip, endedAt: new Date(),
        },
      }).catch((err: any) => { if (err?.code !== "P2002") throw err; });
    }
    return { outcome: skip };
  }
  const r = await runAutomationsForEvent({
    tenantId: ev.tenantId,
    types: [ev.type],
    onlyFlowIds: ids,
    eventKey,
    conversationId: target!.conversation.id,
    contactId: target!.contact?.id ?? null,
    channel: "whatsapp",
    message: "",
    vars: callVariables(session),
  });
  return { outcome: r.runs.length ? r.runs.map((x) => x.status).join(",") : "duplicate" };
}
