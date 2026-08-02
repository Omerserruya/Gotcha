/**
 * Deterministic cross-customer access guard for customer-channel tool calls.
 *
 * Live P0 (2026-07-20, urban-supply): from Omer's WhatsApp number the model
 * was talked into fetching Matan Amran's order #1004 - "verification" was the
 * attacker saying "yes" and retyping Matan's phone. The model then received
 * the full order (including the stored email) and even attempted
 * shopify.send_invoice to an attacker-supplied address. The LLM can never be
 * the authorization layer; this module is.
 *
 * Model: the AUTHENTICATED CHANNEL IDENTITY is authoritative. For WhatsApp
 * that is the inbound sender number on the conversation - anything typed
 * INSIDE the chat (phones, emails, names, order numbers, "yes I'm him") is
 * untrusted input. A tool call made on behalf of the customer channel may
 * only see resources whose stored identifiers match the channel identity, or
 * that an explicit, unexpired CustomerVerification grant (OTP to the STORED
 * destination) covers.
 *
 * Enforcement is BEFORE the model: executeAdapterTool consults this guard for
 * protected Shopify tools when the call runs with accessScope="customer" -
 * a denied result never reaches the LLM. Pre-flight blocks lookups whose
 * selector (phone/email) isn't the requester's; post-flight verifies the
 * RESOLVED resource's owner and filters list results. An AI-supplied flag can
 * never open access: the requester context is read from the conversation row,
 * never from tool args.
 */
import { prisma } from "@chatcenter/shared";

// Shopify tools that return or act on customer/order-scoped data. Product,
// discount-catalog and segment tools are store-scoped and stay unguarded.
export const PROTECTED_SHOPIFY_TOOLS = new Set([
  "get_customer", "search_customers", "get_customer_by_email", "get_customer_by_phone",
  "get_customer_orders", "get_customer_addresses", "get_customer_tags", "get_customer_metafields",
  "get_customer_discounts", "summarize_customer", "get_customer_health",
  "get_orders", "get_order", "order_lookup", "search_orders", "get_order_items",
  "reconcile_order_items",
  "get_financial_status", "check_payment_status", "get_fulfillment_status",
  "get_shipment_status", "track_shipment", "get_tracking_number", "get_tracking_url",
  "get_fulfillment_events", "check_delivery_eta", "check_pickup_point",
  "get_refund_status", "check_refund", "check_return_status", "get_returns", "get_return_reason",
  "find_latest_order", "find_delayed_order",
  "send_invoice", "resend_confirmation",
  // customer writes are cross-customer-abusable too (tagging/notes on a victim)
  "update_customer", "add_tag", "remove_tag", "update_metafield", "create_note",
]);

export interface RequesterIdentity {
  /** Normalized phone suffixes (last 9 digits) proven by the channel. */
  phoneSuffixes: Set<string>;
  /** Lowercased emails proven by the channel/contact record. */
  emails: Set<string>;
  /** Shopify customer ids granted via contact linkage or verification. */
  customerIds: Set<string>;
  conversationId: string;
  channelSenderId: string | null;
}

export function phoneSuffix(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

function mask(v: string): string {
  if (v.includes("@")) {
    const [u, d] = v.split("@");
    return `${(u || "").slice(0, 1)}***@${d ?? ""}`;
  }
  const digits = v.replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

/**
 * Resolve the trusted requester identity for a conversation: the inbound
 * channel sender plus the tenant contact record it maps to, plus any ACTIVE
 * CustomerVerification grants (OTP completed against a STORED destination).
 */
export async function resolveRequesterIdentity(
  tenantId: string,
  conversationId: string,
): Promise<RequesterIdentity | null> {
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { customerExternalId: true },
  });
  if (!conv) return null;
  const identity: RequesterIdentity = {
    phoneSuffixes: new Set(),
    emails: new Set(),
    customerIds: new Set(),
    conversationId,
    channelSenderId: conv.customerExternalId ?? null,
  };
  const senderSuffix = phoneSuffix(conv.customerExternalId);
  if (senderSuffix) identity.phoneSuffixes.add(senderSuffix);

  const contact = conv.customerExternalId
    ? await (prisma as any).contact.findFirst({
        where: { tenantId, externalId: conv.customerExternalId },
        select: { phone: true, email: true, metadata: true },
      })
    : null;
  if (contact) {
    const s = phoneSuffix(contact.phone);
    if (s) identity.phoneSuffixes.add(s);
    if (contact.email) identity.emails.add(String(contact.email).toLowerCase());
    const crmId = (contact.metadata as any)?.crmContactId;
    if (crmId) identity.customerIds.add(String(crmId));
  }

  // Explicit verification grants: OTP proven against the STORED destination of
  // the target customer, scoped to this tenant+conversation, unexpired.
  try {
    const grants = await (prisma as any).customerVerification.findMany({
      where: {
        tenantId,
        conversationId,
        verifiedAt: { not: null },
        expiresAt: { gt: new Date() },
      },
      select: { targetCustomerId: true, targetPhone: true, targetEmail: true },
    });
    for (const g of grants) {
      if (g.targetCustomerId) identity.customerIds.add(String(g.targetCustomerId));
      const s = phoneSuffix(g.targetPhone);
      if (s) identity.phoneSuffixes.add(s);
      if (g.targetEmail) identity.emails.add(String(g.targetEmail).toLowerCase());
    }
  } catch {
    // Table may not exist yet in older DBs - verification then simply grants
    // nothing extra. Fail toward LESS access, never more.
  }
  return identity;
}

type Verdict = { allowed: true } | { allowed: false; reason: string };

function ownsPhone(id: RequesterIdentity, v: unknown): boolean {
  const s = phoneSuffix(v);
  return !!s && id.phoneSuffixes.has(s);
}
function ownsEmail(id: RequesterIdentity, v: unknown): boolean {
  const e = String(v ?? "").trim().toLowerCase();
  return !!e && id.emails.has(e);
}
function ownsCustomerId(id: RequesterIdentity, v: unknown): boolean {
  const c = String(v ?? "").trim();
  return !!c && id.customerIds.has(c);
}

/**
 * PRE-FLIGHT: reject lookups whose SELECTOR already names someone else.
 * A typed phone/email in chat is untrusted - if it isn't the requester's own
 * (or covered by a verification grant), the provider is never even called.
 */
export function checkArgsAllowed(
  identity: RequesterIdentity,
  toolName: string,
  args: Record<string, any>,
): Verdict {
  if (args.phone != null && !ownsPhone(identity, args.phone)) {
    return { allowed: false, reason: `selector_phone_not_owned:${mask(String(args.phone))}` };
  }
  if (args.email != null && !ownsEmail(identity, args.email)) {
    return { allowed: false, reason: `selector_email_not_owned:${mask(String(args.email))}` };
  }
  if (args.customer_id != null && !ownsCustomerId(identity, args.customer_id)) {
    return { allowed: false, reason: "selector_customer_id_not_owned" };
  }
  // Financial documents go ONLY to the destination already stored on the
  // verified order. A chat-supplied override ("send it to my other email") is
  // an account-change, not a resend - always denied here.
  if (toolName === "send_invoice" && args.to != null) {
    return { allowed: false, reason: "invoice_destination_override_denied" };
  }
  return { allowed: true };
}

/** Extract owner identifiers from a Shopify order/customer-shaped object. */
function ownerMatches(identity: RequesterIdentity, obj: Record<string, any>): boolean {
  const phones = [obj.phone, obj.customer?.phone, obj.customer?.default_address?.phone,
    obj.shipping_address?.phone, obj.billing_address?.phone];
  const emails = [obj.email, obj.contact_email, obj.customer?.email];
  const ids = [obj.customer?.id, obj.customer_id, obj.orders_count != null || obj.tags !== undefined ? obj.id : undefined];
  return (
    phones.some((p) => ownsPhone(identity, p)) ||
    emails.some((e) => ownsEmail(identity, e)) ||
    ids.some((c) => c != null && ownsCustomerId(identity, c))
  );
}

function looksCustomerScoped(obj: Record<string, any>): boolean {
  return (
    obj.email !== undefined || obj.contact_email !== undefined || obj.customer !== undefined ||
    obj.phone !== undefined || obj.orders_count !== undefined ||
    obj.financial_status !== undefined || obj.order_id !== undefined || obj.name !== undefined
  );
}

/**
 * POST-FLIGHT: the RESOLVED resource must belong to the requester. Arrays are
 * filtered to owned entries; a scalar result owned by someone else is denied
 * outright and never reaches the model.
 */
export function checkResultAllowed(
  identity: RequesterIdentity,
  toolName: string,
  result: unknown,
): { allowed: true; result: unknown } | { allowed: false; reason: string } {
  if (result == null || typeof result !== "object") return { allowed: true, result };

  if (Array.isArray(result)) {
    const scoped = result.filter((x) => x && typeof x === "object" && looksCustomerScoped(x));
    if (!scoped.length) return { allowed: true, result };
    const owned = result.filter(
      (x) => !(x && typeof x === "object" && looksCustomerScoped(x)) || ownerMatches(identity, x),
    );
    if (!owned.length) return { allowed: false, reason: `result_not_owned:${toolName}` };
    return { allowed: true, result: owned };
  }

  const obj = result as Record<string, any>;
  // Wrapper shapes ({order_id, refunds}, {customer, recent_orders}, …): check
  // nested owner-bearing objects when the top level has no identifiers.
  if (looksCustomerScoped(obj)) {
    if (ownerMatches(identity, obj)) return { allowed: true, result };
    // Wrappers like {order_id, name, refunds:[…]} carry no owner fields at all
    // - those were already authorized at resolve time by the pre-flight +
    // the order-returning tools; only DENY when identifiers exist and differ.
    const hasOwnerFields =
      obj.email != null || obj.contact_email != null || obj.phone != null ||
      obj.customer?.id != null || obj.customer?.email != null || obj.customer?.phone != null;
    if (hasOwnerFields) return { allowed: false, reason: `result_not_owned:${toolName}` };
    return { allowed: true, result };
  }
  if (obj.customer && typeof obj.customer === "object") {
    if (!ownerMatches(identity, obj)) return { allowed: false, reason: `result_not_owned:${toolName}` };
  }
  return { allowed: true, result };
}

/** Persist a security event (masked) + loud log. Never throws. */
export async function recordSecurityDenial(opts: {
  tenantId: string;
  conversationId: string;
  channelSenderId: string | null;
  toolName: string;
  reason: string;
  args: Record<string, any>;
}): Promise<void> {
  console.error(
    `[SECURITY] cross-customer access denied tenant=${opts.tenantId} conv=${opts.conversationId} ` +
      `sender=${opts.channelSenderId ? mask(opts.channelSenderId) : "?"} tool=shopify.${opts.toolName} reason=${opts.reason}`,
  );
  try {
    await (prisma as any).auditLog.create({
      data: {
        tenantId: opts.tenantId,
        actorType: "system",
        action: "security.cross_customer_access_denied",
        targetType: "conversation",
        targetId: opts.conversationId,
        metadata: {
          tool: `shopify.${opts.toolName}`,
          reason: opts.reason,
          channelSender: opts.channelSenderId ? mask(opts.channelSenderId) : null,
          requestedPhone: opts.args.phone ? mask(String(opts.args.phone)) : undefined,
          requestedEmail: opts.args.email ? mask(String(opts.args.email)) : undefined,
          requestedOrder: opts.args.order_name ?? opts.args.order_id ?? undefined,
        } as any,
      },
    });
  } catch (err: any) {
    console.error("[SECURITY] denial audit write failed:", err?.message);
  }
}
