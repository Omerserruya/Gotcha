/**
 * Abandoned carts (Studio > Automations, trigger cart_abandoned).
 *
 * A store tells us about a checkout (CartEventJob, any source). We keep its
 * latest snapshot and, for every live cart automation, schedule ONE check
 * after that automation's delay. When the check fires:
 *
 *   - the checkout changed since        → this check is stale; the newer one decides
 *   - the checkout became an order      → nothing (and a parked run stops)
 *   - no consent for marketing          → a run is RECORDED as skipped, with the reason
 *   - otherwise                         → one run per automation per checkout
 *
 * Customer-protection rules live here and in the validator (WhatsApp outside
 * the 24 h window: template only), never in the author's goodwill.
 */
import { prisma, getRedis, incomingMessageQueue, type CartEventJob } from "@chatcenter/shared";
import { runAutomationsForEvent } from "./automation-runner.service";
import { ensureContactForInbound } from "./ensure-contact.service";

export const DEFAULT_CART_DELAY_MIN = 120;
const SNAPSHOT_TTL_S = 14 * 24 * 3600;
const DONE_TTL_S = 30 * 24 * 3600;

const snapKey = (t: string, id: string) => `cart:snap:${t}:${id}`;
const doneKey = (t: string, id: string) => `cart:done:${t}:${id}`;

export interface CartCheckJob { tenantId: string; checkoutId: string; flowId: string; updatedAt: string }

/** Minutes an automation waits before calling a checkout abandoned (15 min .. 2 days). */
export function cartDelayMinutes(config: any): number {
  const n = Number(config?.delayMinutes);
  return Number.isFinite(n) && n >= 15 && n <= 2880 ? Math.round(n) : DEFAULT_CART_DELAY_MIN;
}

/** A purchase (or a completed checkout) for this checkout has been seen. */
export async function isCheckoutDone(tenantId: string, checkoutId: string): Promise<boolean> {
  return (await getRedis().get(doneKey(tenantId, checkoutId))) != null;
}

/** A store event about a checkout. */
export async function onCartEvent(ev: CartEventJob): Promise<{ scheduled: number }> {
  const redis = getRedis();
  if (ev.completed) {
    await redis.set(doneKey(ev.tenantId, ev.checkoutId), "1", "EX", DONE_TTL_S);
    return { scheduled: 0 };
  }
  if (await isCheckoutDone(ev.tenantId, ev.checkoutId)) return { scheduled: 0 };
  await redis.set(snapKey(ev.tenantId, ev.checkoutId), JSON.stringify(ev), "EX", SNAPSHOT_TTL_S);
  const flows = await prisma.chatbotFlow.findMany({
    where: { tenantId: ev.tenantId, isActive: true, triggerType: "cart_abandoned" },
    select: { id: true, triggerConfig: true },
  });
  for (const f of flows as any[]) {
    const delay = cartDelayMinutes(f.triggerConfig) * 60_000;
    await incomingMessageQueue.add(
      "cart-check",
      { tenantId: ev.tenantId, checkoutId: ev.checkoutId, flowId: f.id, updatedAt: ev.updatedAt } satisfies CartCheckJob,
      { delay, jobId: `cartchk_${f.id}_${ev.checkoutId}_${Date.parse(ev.updatedAt) || ev.updatedAt}`, removeOnComplete: true, removeOnFail: 100 },
    );
  }
  return { scheduled: flows.length };
}

/** Variables a cart automation can write. */
export function cartVariables(ev: CartEventJob): Record<string, string> {
  const items = (ev.items ?? []).filter((i) => i?.title).map((i) => (i.quantity > 1 ? `${i.title} x${i.quantity}` : i.title));
  const total = ev.total != null ? `${Number(ev.total).toFixed(2)}${ev.currency ? ` ${ev.currency}` : ""}` : "";
  return {
    cart_url: ev.cartUrl ?? "",
    cart_total: total,
    cart_items: items.join(", "),
    ...(ev.customer?.firstName ? { first_name: String(ev.customer.firstName).trim().split(/\s+/)[0] } : {}),
  };
}

/** Could any of these automations write on WhatsApp (no channel limit, or WHATSAPP among them)? */
export function mayWriteWhatsApp(flows: Array<{ triggerConfig?: any }>): boolean {
  return flows.some((f) => {
    const ch: string[] = Array.isArray(f.triggerConfig?.channels) ? f.triggerConfig.channels.map((x: any) => String(x).toUpperCase()) : [];
    return !ch.length || ch.includes("WHATSAPP");
  });
}

const digits = (p: string | null | undefined) => String(p ?? "").replace(/\D/g, "");

/**
 * Who to write to: an existing conversation of a contact with this phone or
 * email (WhatsApp first), else - with a phone and a WhatsApp number on the
 * workspace - a new WhatsApp conversation. Null when nobody is reachable.
 * A call's contact (VOICE) is never a target: nothing can be written there.
 * `whatsappOnly`: only a WhatsApp conversation (a caller's number).
 * `create: false`: never open a new conversation (no listening automation may
 * write on WhatsApp, so a new one would only be left empty).
 */
export async function resolveCartTarget(tenantId: string, customer: CartEventJob["customer"], opts: { whatsappOnly?: boolean; create?: boolean } = {}) {
  const phone = digits(customer?.phone);
  const email = String(customer?.email ?? "").trim().toLowerCase();
  const or: any[] = [];
  if (phone.length >= 7) or.push({ phone: { contains: phone.slice(-9) } }, { externalId: phone });
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  if (or.length) {
    const contacts = await prisma.contact.findMany({
      where: { tenantId, OR: or, channel: opts.whatsappOnly ? ("WHATSAPP" as any) : { not: "VOICE" as any } },
      select: { id: true, channel: true, externalId: true, optOutChannels: true },
      take: 10,
    });
    const ordered = [...contacts].sort((a: any, b: any) => (a.channel === "WHATSAPP" ? -1 : 0) - (b.channel === "WHATSAPP" ? -1 : 0));
    for (const c of ordered as any[]) {
      const conv = await prisma.conversation.findFirst({
        where: { tenantId, channel: c.channel, customerExternalId: c.externalId },
        orderBy: { createdAt: "desc" },
        select: { id: true, channel: true, customerExternalId: true, assignedAgentId: true, isHandedOver: true, automationRunId: true },
      });
      if (conv) return { contact: c, conversation: conv };
    }
  }
  if (phone.length < 7 || opts.create === false) return null;
  const account = await prisma.channelAccount.findFirst({
    where: { tenantId, channel: "WHATSAPP" as any, isActive: true },
    select: { id: true },
  });
  if (!account) return null;
  const contact = await ensureContactForInbound({ tenantId, channel: "WHATSAPP" as any, externalId: phone, displayName: customer?.firstName ?? null });
  const conv = await prisma.conversation.create({
    data: { tenantId, channel: "WHATSAPP" as any, channelAccountId: account.id, customerExternalId: phone, customerName: customer?.firstName ?? null, status: "OPEN" as any },
    select: { id: true, channel: true, customerExternalId: true, assignedAgentId: true, isHandedOver: true, automationRunId: true },
  });
  return { contact: contact ? { id: contact.id, channel: "WHATSAPP", externalId: phone, optOutChannels: (contact as any).optOutChannels ?? [] } : null, conversation: conv };
}

/**
 * May we send marketing to this customer on this channel? The store's own
 * record decides when it has one (Shopify: accepts email / SMS marketing);
 * otherwise only a ConsentRecord marketing_<channel> granted=true counts
 * (WooCommerce stores no consent). An opt-out always wins.
 */
export async function hasMarketingConsent(tenantId: string, ev: CartEventJob, target: { contact: any; conversation: any }): Promise<{ ok: boolean; reason?: string }> {
  const channel = String(target.conversation.channel).toUpperCase();
  const optedOut = Array.isArray(target.contact?.optOutChannels) ? target.contact.optOutChannels.map((x: any) => String(x).toUpperCase()) : [];
  if (optedOut.includes(channel)) return { ok: false, reason: "opted_out" };
  const store = ev.marketingConsent;
  // A WhatsApp or SMS message is a phone channel; email is email.
  const storeSays = channel === "EMAIL" || channel === "GMAIL" || channel === "OUTLOOK" ? store?.email : store?.sms ?? null;
  if (storeSays === true) return { ok: true };
  if (target.contact?.id) {
    const rec = await prisma.consentRecord.findFirst({
      where: { tenantId, subjectType: "contact", subjectId: target.contact.id, purpose: `marketing_${channel.toLowerCase()}` },
      orderBy: { createdAt: "desc" },
      select: { granted: true },
    }).catch(() => null);
    if (rec?.granted === true) return { ok: true };
  }
  return { ok: false, reason: "no_marketing_consent" };
}

/** The delayed check: is this checkout abandoned, and may we act on it? */
export async function onCartCheck(job: CartCheckJob): Promise<{ outcome: string }> {
  const raw = await getRedis().get(snapKey(job.tenantId, job.checkoutId));
  if (!raw) return { outcome: "no_snapshot" };
  const ev = JSON.parse(raw) as CartEventJob;
  if (ev.updatedAt !== job.updatedAt) return { outcome: "stale" };
  if (await isCheckoutDone(job.tenantId, job.checkoutId)) return { outcome: "purchased" };
  const flow = await prisma.chatbotFlow.findFirst({
    where: { id: job.flowId, tenantId: job.tenantId, isActive: true, triggerType: "cart_abandoned" },
    select: { id: true, triggerConfig: true },
  });
  if (!flow) return { outcome: "automation_inactive" };
  const eventKey = `cart:${job.checkoutId}`;

  const target = await resolveCartTarget(job.tenantId, ev.customer, { create: mayWriteWhatsApp([flow]) });
  const consent = target ? await hasMarketingConsent(job.tenantId, ev, target) : { ok: false, reason: "no_reachable_customer" };
  if (!target || !consent.ok) {
    // Recorded, so the run log says why nobody was written to.
    await prisma.automationRun.create({
      data: {
        tenantId: job.tenantId, flowId: flow.id, triggerType: "cart_abandoned", eventKey,
        conversationId: target?.conversation.id ?? null, contactId: target?.contact?.id ?? null,
        status: "skipped", error: consent.reason ?? "no_reachable_customer", endedAt: new Date(),
      },
    }).catch((err: any) => { if (err?.code !== "P2002") throw err; });
    return { outcome: consent.reason ?? "no_reachable_customer" };
  }
  // A person owns the conversation, or another automation is parked there.
  if (target.conversation.assignedAgentId || target.conversation.isHandedOver || target.conversation.automationRunId) {
    return { outcome: "conversation_busy" };
  }
  const r = await runAutomationsForEvent({
    tenantId: job.tenantId,
    types: ["cart_abandoned"],
    onlyFlowIds: [flow.id],
    eventKey,
    conversationId: target.conversation.id,
    contactId: target.contact?.id ?? null,
    channel: String(target.conversation.channel).toLowerCase(),
    message: "",
    vars: cartVariables(ev),
  });
  return { outcome: r.runs.length ? r.runs[0]!.status : "duplicate" };
}
