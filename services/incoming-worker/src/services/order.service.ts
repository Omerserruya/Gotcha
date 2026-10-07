/**
 * "Order event" automations (Studio > Automations, trigger order_event).
 *
 * A store reports an order's status (OrderEventJob: Shopify orders/*, the
 * WooCommerce poller). Every live order automation whose `statuses` include
 * it runs once for that order and status (eventKey order:<source>:<id>:<status>),
 * written to the customer where they can be reached: their existing
 * conversation (WhatsApp first), else a new WhatsApp conversation by phone.
 *
 * An order message is about the customer's own purchase, so it needs no
 * marketing consent; an opt-out on the channel always wins. On WhatsApp the
 * validator allows only a template (the customer usually has not written).
 *
 *   nobody reachable / opted out / a person owns the chat → a SKIPPED run with the reason
 */
import { prisma, type OrderEventJob } from "@chatcenter/shared";
import { runAutomationsForEvent } from "./automation-runner.service";
import { resolveCartTarget } from "./cart.service";

/** Variables an order automation can write. */
export function orderVariables(ev: OrderEventJob): Record<string, string> {
  const items = (ev.items ?? []).filter((i) => i?.title).map((i) => (i.quantity > 1 ? `${i.title} x${i.quantity}` : i.title));
  return {
    order_number: ev.orderNumber ?? "",
    order_total: ev.total != null ? `${Number(ev.total).toFixed(2)}${ev.currency ? ` ${ev.currency}` : ""}` : "",
    order_status: ev.status,
    order_items: items.join(", "),
    order_url: ev.orderUrl ?? "",
    ...(ev.customer?.firstName ? { first_name: String(ev.customer.firstName).trim().split(/\s+/)[0] } : {}),
  };
}

/** The automations listening for this status (`statuses`: none = every status). */
export function forStatus(flows: Array<{ id: string; triggerConfig: any }>, status: string): string[] {
  return flows
    .filter((f) => {
      const s: string[] = Array.isArray(f.triggerConfig?.statuses) ? f.triggerConfig.statuses.map(String) : [];
      return !s.length || s.includes(status);
    })
    .map((f) => f.id);
}

export async function onOrderEvent(ev: OrderEventJob): Promise<{ outcome: string }> {
  const tenant = await prisma.tenant.findUnique({ where: { id: ev.tenantId }, select: { status: true } });
  if (!tenant || tenant.status !== "ACTIVE") return { outcome: "tenant_inactive" };
  const flows = await prisma.chatbotFlow.findMany({
    where: { tenantId: ev.tenantId, isActive: true, triggerType: "order_event" },
    select: { id: true, triggerConfig: true },
  });
  const ids = forStatus(flows as any[], ev.status);
  if (!ids.length) return { outcome: "no_automation" };
  const eventKey = `order:${ev.source}:${ev.orderId}:${ev.status}`;

  const target = await resolveCartTarget(ev.tenantId, ev.customer);
  const channel = target ? String(target.conversation.channel).toUpperCase() : null;
  const optedOut = !!target && (Array.isArray(target.contact?.optOutChannels) ? target.contact.optOutChannels : []).map((x: any) => String(x).toUpperCase()).includes(channel);
  const busy = !!target && !!(target.conversation.assignedAgentId || target.conversation.isHandedOver || target.conversation.automationRunId);
  const skip = !target ? "no_reachable_customer" : optedOut ? "opted_out" : busy ? "conversation_busy" : null;
  if (skip) {
    // Recorded, so the run log says why nobody was written to.
    for (const flowId of ids) {
      await prisma.automationRun.create({
        data: {
          tenantId: ev.tenantId, flowId, triggerType: "order_event", eventKey,
          conversationId: target?.conversation.id ?? null, contactId: target?.contact?.id ?? null,
          status: "skipped", error: skip, endedAt: new Date(),
        },
      }).catch((err: any) => { if (err?.code !== "P2002") throw err; });
    }
    return { outcome: skip };
  }
  const r = await runAutomationsForEvent({
    tenantId: ev.tenantId,
    types: ["order_event"],
    onlyFlowIds: ids,
    eventKey,
    conversationId: target!.conversation.id,
    contactId: target!.contact?.id ?? null,
    channel: channel!.toLowerCase(),
    message: "",
    vars: orderVariables(ev),
  });
  return { outcome: r.runs.length ? r.runs.map((x) => x.status).join(",") : "duplicate" };
}
