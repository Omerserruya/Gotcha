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
import { isOptedOutOn } from "@chatcenter/shared/src/lib/marketing-optout";

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
export async function resolveCartTarget(tenantId: string, customer: CartEventJob["customer"], opts: { whatsappOnly?: boolean; create?: boolean; via?: CartVia | null } = {}) {
  if (opts.via === "email") return resolveEmailTarget(tenantId, customer, { create: opts.create !== false });
  const phone = digits(customer?.phone);
  const email = String(customer?.email ?? "").trim().toLowerCase();
  const or: any[] = [];
  if (phone.length >= 7) or.push({ phone: { contains: phone.slice(-9) } }, { externalId: phone });
  // Reached by WhatsApp: a contact found by email still has to be a WhatsApp one.
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  const whatsappOnly = opts.whatsappOnly || opts.via === "whatsapp";
  if (or.length) {
    const contacts = await prisma.contact.findMany({
      where: { tenantId, OR: or, channel: whatsappOnly ? ("WHATSAPP" as any) : { not: "VOICE" as any } },
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

export type CartVia = "whatsapp" | "email";
const EMAIL_CHANNELS = ["GMAIL", "OUTLOOK", "EMAIL"];

/**
 * Reached by email (2026-10-14): the customer's existing email conversation,
 * else - when allowed - a new one on the workspace's connected email account,
 * addressed to the checkout email. Null without an email or an account.
 */
export async function resolveEmailTarget(tenantId: string, customer: CartEventJob["customer"], opts: { create: boolean }) {
  const email = String(customer?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const select = { id: true, channel: true, customerExternalId: true, assignedAgentId: true, isHandedOver: true, automationRunId: true } as const;
  const contacts = await prisma.contact.findMany({
    where: { tenantId, channel: { in: EMAIL_CHANNELS as any }, OR: [{ externalId: email }, { email: { equals: email, mode: "insensitive" } }] },
    select: { id: true, channel: true, externalId: true, optOutChannels: true },
    take: 5,
  });
  for (const c of contacts as any[]) {
    const conv = await prisma.conversation.findFirst({
      where: { tenantId, channel: c.channel, customerExternalId: c.externalId },
      orderBy: { createdAt: "desc" },
      select,
    });
    if (conv) return { contact: c, conversation: conv };
  }
  if (!opts.create) return null;
  const account = await prisma.channelAccount.findFirst({
    where: { tenantId, channel: { in: EMAIL_CHANNELS as any }, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, channel: true },
  });
  if (!account) return null;
  const contact = await ensureContactForInbound({ tenantId, channel: account.channel as any, externalId: email, displayName: customer?.firstName ?? null });
  const conv = await prisma.conversation.create({
    data: { tenantId, channel: account.channel as any, channelAccountId: account.id, customerExternalId: email, customerName: customer?.firstName ?? null, status: "OPEN" as any },
    select,
  });
  return { contact: contact ? { id: contact.id, channel: account.channel, externalId: email, optOutChannels: (contact as any).optOutChannels ?? [] } : null, conversation: conv };
}

const SEND_TYPES = new Set(["send_message_text", "send_message_file", "send_message_image", "send_buttons", "send_list", "send_message_template", "send_message_quick_reply", "send_message_interactive", "collect_input", "ai_generate"]);

/** How a send step reaches the customer: a template is WhatsApp; others say so in data.via. */
export function viaOf(node: { type: string; data?: any } | null | undefined): CartVia | null {
  if (!node) return null;
  if (node.type === "send_message_template") return "whatsapp";
  const v = String(node.data?.via ?? "").toLowerCase();
  return v === "whatsapp" || v === "email" ? v : null;
}

/**
 * The first send step on the path from the trigger, and the step its
 * "unreachable" exit leads to (2026-10-14). The first send step decides how a
 * cart run reaches the customer; its unreachable branch is tried when that
 * channel cannot.
 */
export function cartReachPlan(nodes: Array<{ id: string; type: string; data?: any }>, edges: Array<{ source: string; target: string; sourceHandle?: string | null }>) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === "automation_trigger");
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  let first: { id: string; type: string; data?: any } | null = null;
  while (queue.length && !first) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n && SEND_TYPES.has(n.type)) { first = n; break; }
    for (const e of edges) if (e.source === id && e.sourceHandle !== "unreachable") queue.push(e.target);
  }
  const fallbackId = first ? edges.find((e) => e.source === first!.id && e.sourceHandle === "unreachable")?.target ?? null : null;
  const fallback = fallbackId ? byId.get(fallbackId) ?? null : null;
  return { first, via: viaOf(first), fallback, fallbackVia: viaOf(fallback) };
}

/** Has this customer ever written to the business, on any channel? (Read-only.) */
export async function hasPriorInbound(tenantId: string, customer: CartEventJob["customer"]): Promise<boolean> {
  const phone = digits(customer?.phone);
  const email = String(customer?.email ?? "").trim().toLowerCase();
  const or: any[] = [];
  if (phone.length >= 7) or.push({ phone: { contains: phone.slice(-9) } }, { externalId: phone });
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  if (!or.length) return false;
  const contacts = await prisma.contact.findMany({ where: { tenantId, OR: or }, select: { channel: true, externalId: true }, take: 20 });
  if (!contacts.length) return false;
  const n = await prisma.message.count({
    where: {
      tenantId, direction: "INBOUND",
      conversation: { OR: (contacts as any[]).map((c) => ({ channel: c.channel, customerExternalId: c.externalId })) },
    } as any,
  });
  return n > 0;
}

/**
 * May this customer get marketing (an abandoned cart, a review request, an
 * order message) on this channel?
 *
 * Marketing works by OPT-OUT (Omer's decision 2026-10-08, docs/product/
 * ai-studio-skills-automations.md §6; it replaces the explicit-consent rule
 * on WhatsApp): allowed with prior contact (the customer wrote to the
 * business before) OR the store's consent OR a recorded consent, every
 * message carries the removal line, and an opt-out ALWAYS wins.
 */
export async function marketingGate(
  tenantId: string,
  ev: { marketingConsent?: CartEventJob["marketingConsent"] | null },
  target: { contact: any; conversation: any },
  prior: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const channel = String(target.conversation.channel).toUpperCase();
  if (isOptedOutOn(target.contact?.optOutChannels, channel)) return { ok: false, reason: "opted_out" };
  if (prior) return { ok: true };
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
  return { ok: false, reason: "no_prior_contact_or_consent" };
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
    select: { id: true, name: true, triggerConfig: true, nodes: true, edges: true },
  });
  if (!flow) return { outcome: "automation_inactive" };
  const eventKey = `cart:${job.checkoutId}`;

  // How the customer is reached (2026-10-14): the first send step's channel,
  // then its "unreachable" branch's. A new conversation is opened only for a
  // customer who may be written to on THAT channel (prior contact, or the
  // store's consent: sms for WhatsApp, email for email).
  const plan = cartReachPlan(((flow as any).nodes ?? []) as any[], ((flow as any).edges ?? []) as any[]);
  const prior = await hasPriorInbound(job.tenantId, ev.customer);
  const tryReach = async (via: CartVia | null) => {
    const mayCreate = prior || (via === "email" ? ev.marketingConsent?.email === true : ev.marketingConsent?.sms === true);
    // No via (an automation from before the model): as before, WhatsApp when the trigger allowed it.
    const target = await resolveCartTarget(job.tenantId, ev.customer, via ? { via, create: mayCreate } : { create: mayCreate && mayWriteWhatsApp([flow]) });
    const consent = target ? await marketingGate(job.tenantId, ev, target, prior) : { ok: false, reason: "no_reachable_customer" };
    return { target, consent };
  };
  let { target, consent } = await tryReach(plan.via);
  let fellBack = false;
  if ((!target || !consent.ok) && plan.fallback && plan.fallbackVia && plan.fallbackVia !== plan.via) {
    const second = await tryReach(plan.fallbackVia);
    if (second.target && second.consent.ok) { target = second.target; consent = second.consent; fellBack = true; }
  }
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
    vars: { ...cartVariables(ev), __emailSubject: (flow as any).name ?? "", __reach: { reachedVia: EMAIL_CHANNELS.includes(String(target.conversation.channel).toUpperCase()) ? "email" : String(target.conversation.channel).toLowerCase(), fellBack } },
    // Reached on the second channel: the walk starts on the unreachable branch.
    startNodeId: fellBack ? plan.fallback!.id : null,
  });
  return { outcome: r.runs.length ? r.runs[0]!.status : "duplicate" };
}
