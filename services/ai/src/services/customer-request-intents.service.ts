/**
 * Deterministic turn directives for the customer-service request shapes.
 *
 * Same mechanism as the coupon and order-note directives in
 * `product-intent.service.ts` (which stay there because they shipped there),
 * applied to the support flows: a missing item, a profile change, an order
 * address change, an exchange, a return, a document request.
 *
 * Why any of this is deterministic rather than left to the persona prompt: in
 * every one of these flows the model has a specific wrong instinct that a
 * general instruction does not reach. It re-verifies an identity it already
 * has. It asks which item is missing on a one-item order. It says the address
 * was changed before the mutation ran. It calls a note a team notification.
 * Each directive below names the wrong instinct and the tool that replaces it.
 *
 * A directive never grants capability. The tool surface and the access guard
 * decide what can happen; this only decides what the model tries and what it
 * is allowed to say about it.
 */

// ── Identity, and when it is already settled ──────────────────

/**
 * Does the channel itself prove who this is?
 *
 * WhatsApp and other phone-addressed channels do: the sender id is the number
 * the provider authenticated, and it is exactly what `customer-access-guard.ts`
 * scopes every Shopify read to. A conversation with no external id proves
 * nothing, and gets no identity block rather than a false assurance.
 */
export function identityIsEstablished(conv: {
  channel?: string | null;
  customerExternalId?: string | null;
}): boolean {
  if (!conv?.customerExternalId) return false;
  const raw = String(conv.customerExternalId).replace(/[\s-]/g, "");
  return conv.channel === "WHATSAPP" || /^\+?\d{6,}$/.test(raw);
}

/**
 * Live (scenario 25, 2026-08-01): Matan reported a missing item from his own
 * order, on the WhatsApp number stored on that order, and the bot asked him to
 * verify his identity. Nothing in the prompt had ever said the identity was
 * settled, while `request_identity_verification` sits in every tool surface
 * telling the model to call it "when in doubt" - so a complaint, which sounds
 * serious, produced doubt, and doubt produced an interrogation.
 *
 * This grants nothing. `customer-access-guard.ts` refuses cross-customer reads
 * before the model ever sees them, whatever the model believes. The block
 * exists so the model stops asking for something the system already has, and
 * it is careful to keep the one case where asking is right: someone else's
 * records.
 */
export function buildEstablishedIdentityBlock(conv: {
  channel?: string | null;
  customerExternalId?: string | null;
}): string | null {
  if (!identityIsEstablished(conv)) return null;
  return (
    "## Identity - already established\n" +
    "This conversation arrives on an authenticated channel, and the sender above IS the customer. " +
    "You do NOT need to verify their identity again to discuss, read or act on THEIR OWN records - " +
    "their orders, their shipments, their profile, their returns. " +
    "A complaint, a missing item, a refund request or an address change is NOT a reason to re-verify.\n" +
    "Ask for verification (request_identity_verification) ONLY when the request is about SOMEONE ELSE: " +
    "a different person's order or profile, a customer record that does not match this sender, or a " +
    "request to send someone else's data somewhere. In every other case, proceed and help."
  );
}

// ── Missing item ──────────────────────────────────────────────

/**
 * "חסר לי פריט" and its neighbours.
 *
 * Deliberately wider than the word "missing": a shortfall is reported as
 * "קיבלתי רק אחד", "הגיע חלקי", "לא הגיע הכל" far more often than as a
 * missing-item complaint in so many words.
 */
const MISSING_ITEM_RE =
  /(חסר|חסרים|חסרה|לא\s*הגיע(ו)?\s*(כל|הכל|כלום|אחד|פריט|מוצר)|הגיע\s*(רק|חלקי|חלק)|קיבלתי\s*רק|התקבל\s*רק|רק\s*חלק\s*מ|missing\s*(item|product|piece)|item\s*(is\s*)?missing|didn'?t\s*(receive|get)\s*(all|everything|one|the)|only\s*(received|got)\s*(one|part|some))/i;

export function detectMissingItemIntent(text: string | null | undefined): boolean {
  return MISSING_ITEM_RE.test(String(text ?? ""));
}

/**
 * The order of operations that was missing.
 *
 * Live, the turn went straight from "something is missing" to "please verify
 * your identity", and never read a quantity. The fix is not a softer identity
 * rule - it is telling the model that the answer is a comparison it can
 * perform, and naming the one tool that performs it.
 */
export function buildMissingItemDirective(opts: { hasReconcileTool: boolean }): string {
  const lines = [
    `The customer is reporting that something is missing or short from an order.`,
    `Identity is ALREADY established - this is their own order arriving on their own authenticated channel.`,
    `Do NOT ask them to verify their identity, and do NOT ask for their phone, email or order number again if you already have them.`,
  ];
  if (opts.hasReconcileTool) {
    lines.push(
      `Call reconcile_order_items for the order in question FIRST. It returns, per line item: ordered, shipped, still pending, cancelled and refunded quantities.`,
      `Read its answer before you say anything about what is missing:`,
      `- If it names exactly one short item (unambiguous_item), say WHICH item and how many units, and do NOT ask the customer which item they mean.`,
      `- If ambiguous is true, ask which of the named items is missing - that is the only case where the question is warranted.`,
      `- If another_shipment_pending is true and the shortfall is accounted for by it, explain that the rest of the order has not been dispatched yet rather than treating it as lost.`,
      `- If fulfillment_visibility is "unreadable", say you cannot confirm the shipment breakdown and offer a person. Never render "cannot see" as "nothing shipped".`,
    );
  } else {
    lines.push(
      `You have no tool that can compare ordered against shipped quantities on this conversation, so you cannot confirm what is missing.`,
      `Say exactly that, and offer a person. Do not guess and do not claim to have checked.`,
    );
  }
  lines.push(
    `Then take the configured next step - a return/RMA or a real handoff - and describe ONLY what actually happened.`,
    `A note or a tag on the order is NOT a team notification: never say a team, warehouse or courier was told anything unless a handoff, task or return really was created this turn.`,
    `Do not say "פתחתי קריאה", "העברתי לצוות" or "הצוות מטפל" unless that is literally true of something that returned success in this turn.`,
  );
  return lines.join("\n");
}
