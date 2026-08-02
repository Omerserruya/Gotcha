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

// ── Own profile ───────────────────────────────────────────────

/**
 * "תעדכנו לי את המייל" / "הכתובת שלי השתנתה".
 *
 * Careful about what this must NOT catch: an ORDER's shipping address is a
 * different request with a different eligibility rule and a different tool
 * (Phase 4). The order words are excluded explicitly below rather than left to
 * chance, because "תשנו לי את הכתובת במשלוח" and "תשנו לי את הכתובת" differ by
 * one word and by everything else.
 */
// Both word orders. Hebrew states the change either way round - "השתנתה
// הכתובת" and "הכתובת שלי השתנתה" are the same sentence, and a verb-first
// pattern silently missed the one customers actually write.
const PROFILE_UPDATE_RE =
  /((תעדכנו|תעדכן|לעדכן|תשנו|תשנה|לשנות|תחליפו|החליפו)[^\n]{0,25}?(מייל|אימייל|טלפון|נייד|שם|כתובת)|(שיניתי|השתנה|השתנתה)\s*(ה)?(מייל|אימייל|טלפון|נייד|כתובת)|(מייל|אימייל|טלפון|נייד|כתובת)[^\n]{0,15}?(השתנה|השתנתה|שונה|שונתה)|(update|change)\s*(my)?\s*(email|phone|number|name|address)|my\s*(email|phone|address)\s*(has\s*)?changed)/i;

const ORDER_SCOPED_RE =
  /(בהזמנה|של\s*ההזמנה|למשלוח|במשלוח|של\s*המשלוח|on\s*(the|my)\s*order|shipping\s*address|delivery\s*address|for\s*order)/i;

export function detectProfileUpdateIntent(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (!PROFILE_UPDATE_RE.test(t)) return false;
  // An order-scoped address change is Phase 4's flow, not this one.
  return !ORDER_SCOPED_RE.test(t);
}

export function buildProfileUpdateDirective(opts: { hasProfileTool: boolean }): string {
  if (!opts.hasProfileTool) {
    return [
      `The customer wants to change their own stored details, and you have no tool that can do it on this conversation.`,
      `Say plainly that you cannot change it from here, and offer a person. Do NOT say it was changed or that you will pass it on unless you actually create a handoff.`,
    ].join("\n");
  }
  return [
    `The customer wants to change their OWN stored details (name, email, phone or saved address).`,
    `Use update_my_profile. It takes ONLY the new values - there is no customer id, email or phone selector, because the system already knows which record is theirs.`,
    `So: do NOT ask for their customer number, do NOT ask them to confirm who they are, and do NOT pass an id you found elsewhere.`,
    `Before calling, read the NEW value back to them and get a clear yes - an email or phone change affects how they are recognised later, and a typo there is expensive.`,
    `A saved-address change is NOT the same as changing the delivery address of an existing order. If they meant an order, say so and handle that separately.`,
    `After the call, report ONLY the fields in changed_fields. If verified is false, tell them it did not go through - never describe an unconfirmed write as done.`,
    `If a conflict is reported, the new email or phone already belongs to another account: say that plainly and offer a person.`,
  ].join("\n");
}

// ── Order shipping address ────────────────────────────────────

const ORDER_ADDRESS_RE =
  /((תשנו|תשנה|לשנות|תעדכנו|תעדכן|לעדכן|להחליף|תחליפו)[^\n]{0,30}?(כתובת|יעד|משלוח)|(כתובת|יעד)[^\n]{0,20}?(משלוח|למשלוח|ההזמנה)|(change|update)[^\n]{0,20}?(shipping|delivery)\s*address|(ship|deliver)\s*(it\s*)?to\s*(a\s*)?(different|another|new)\s*address)/i;

export function detectOrderAddressIntent(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (!ORDER_ADDRESS_RE.test(t)) return false;
  // "הכתובת שלי השתנתה" with no order in sight is a profile change.
  return ORDER_SCOPED_RE.test(t) || /(הזמנה|order)\s*#?\d/i.test(t);
}

/**
 * The two halves of this flow fail in opposite directions.
 *
 * Before dispatch the model under-acts: it hands the conversation to a person
 * for something it can do (scenario 10, "UNSUPPORTED - handed off"). After
 * dispatch it over-claims: it says the address was changed, or that the
 * courier has been contacted, neither of which any tool here can make true.
 */
export function buildOrderAddressDirective(opts: { hasAddressTool: boolean }): string {
  if (!opts.hasAddressTool) {
    return [
      `The customer wants to change the delivery address of an existing order, and you have no tool for it here.`,
      `Say plainly that you cannot change it from this chat, and offer a person.`,
      `Do NOT say the address was changed. Do NOT say the courier, carrier or warehouse was contacted - you have not contacted anyone.`,
    ].join("\n");
  }
  return [
    `The customer wants to change the delivery address of an existing ORDER (not their saved profile address).`,
    `Identity is already established - do not re-verify.`,
    `Collect the FULL new address first: street, city, country at minimum, plus postal code and province where they apply. Read it back to them before calling.`,
    `Then call update_order_shipping_address. It checks eligibility from the order's fulfillment orders, so you do not have to guess whether it has shipped.`,
    `If it returns eligible: false, the order is already on its way. Say exactly the reason given and stop:`,
    `- do NOT say the address was changed`,
    `- do NOT say the carrier, courier or warehouse has been contacted, or that anyone will intercept the parcel`,
    `- you may offer the tracking link if one exists, and a real handover to a person if they want one`,
    `If it returns address_updated: true, tell them the new city and country. If verified is false, say it did not go through.`,
  ].join("\n");
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
