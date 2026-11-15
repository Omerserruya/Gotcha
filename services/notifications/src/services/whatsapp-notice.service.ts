/**
 * Notifications on WhatsApp, from GOTCHA's own number only (2026-11-02).
 *
 * A personal channel: a person turns it on for their own confirmed number;
 * no workspace rule can send it to them. The approval request is NOT sent
 * here (whatsapp-approval.service sends it, with its Approve / Reject
 * buttons). Without the platform number or a template for the event nothing
 * is sent, and the row says why: never a tenant's number instead.
 */
import { prisma, getOutboundAdapter } from "@chatcenter/shared";
import { whatsAppReadiness, notePlatformSendFailure, buildComponents, templateParams, localeForRecipient, templateFor } from "./platform-whatsapp";

/** Events the dispatcher sends on WhatsApp: a template, and not the approval request. */
export function wantsWhatsApp(eventType: string): boolean {
  return eventType !== "tool.approval_required" && !!templateFor(eventType);
}

async function log(tenantId: string, type: string, recipient: string, status: "sent" | "failed" | "skipped", error?: string) {
  await (prisma as any).notificationLog.create({
    data: { tenantId, channel: "whatsapp", type, recipient, status, ...(error ? { error } : {}), ...(status === "sent" ? { sentAt: new Date() } : {}) },
  }).catch(() => {});
}

export async function deliverWhatsAppNotice(opts: {
  user: { id: string; tenantId: string };
  event: { type: string; data: Record<string, unknown>; metadata?: { conversationId?: string } };
  phone: string | null | undefined;
}): Promise<"sent" | "failed" | "skipped"> {
  const { user, event } = opts;
  const phone = String(opts.phone ?? "").replace(/^\+/, "");
  if (!phone) { await log(user.tenantId, event.type, "", "skipped", "no confirmed WhatsApp number"); return "skipped"; }
  const ready = await whatsAppReadiness(event.type);
  if (!ready.ready) { await log(user.tenantId, event.type, `+${phone}`, "skipped", ready.reason); return "skipped"; }
  const conversationId = String(event.metadata?.conversationId ?? (event.data as any)?.conversationId ?? "");
  if (ready.template.urlButton && !conversationId) { await log(user.tenantId, event.type, `+${phone}`, "skipped", "no conversation for the template's link"); return "skipped"; }
  const adapter = getOutboundAdapter("WHATSAPP") as any;
  if (!adapter?.sendTemplateMessage) { await log(user.tenantId, event.type, `+${phone}`, "skipped", "WhatsApp adapter has no template send"); return "skipped"; }
  try {
    const locale = await localeForRecipient(user.tenantId, user.id);
    const components = buildComponents(ready.template, templateParams(event.type, event.data ?? {}, locale), ready.template.urlButton ? { urlSuffix: conversationId } : {});
    await adapter.sendTemplateMessage({ accessToken: ready.sender.accessToken }, ready.sender.externalId, phone, ready.template.name, locale, components);
    await log(user.tenantId, event.type, `+${phone}`, "sent");
    return "sent";
  } catch (err: any) {
    await notePlatformSendFailure(ready.sender, err);
    await log(user.tenantId, event.type, `+${phone}`, "failed", String(err?.message ?? "send failed").slice(0, 240));
    return "failed";
  }
}
