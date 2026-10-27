/**
 * Telling a catalogue question apart from a support issue.
 *
 * The support persona's objective is RESOLVE_ISSUE, and its instruction is to
 * ask only the questions needed to diagnose. Point that at
 *
 *     "יש את The Minimal Snowboard במידה 159?"
 *
 * and it does what it was told: it asks which colour or version the customer
 * means. On this catalogue that question has no answer - the product has a
 * single `Default Title` variant - so the customer was interrogated about
 * options that do not exist while the tool that would have answered in one
 * call sat unused.
 *
 * A size/stock/SKU question is not an issue to diagnose. It is a lookup, and
 * the answer is in the catalogue. This detector is deliberately narrow and
 * deterministic: it only fires on a question that names a concrete attribute,
 * and all it does is add a directive to the turn.
 */

/** Size/length/measurement, colour, SKU, or plain availability. */
const VARIANT_ATTRIBUTE_RE =
  /(מידה|מידות|גודל|אורך|ס"מ|ס״מ|\bcm\b|צבע|צבעים|דגם|גרסה|מק"ט|מק״ט|\bsku\b|\bsize\b|\blength\b|\bcolou?r\b|\bvariant\b)/i;

/** "do you have", "is it in stock", "is it available". */
const AVAILABILITY_RE =
  /(יש\s*(לכם|לך)?|האם\s*יש|במלאי|זמין|זמינות|אזל|נגמר|do you have|in stock|available|availability)/i;

/**
 * Coupons and discounts, in a customer conversation.
 *
 * Out of scope by product decision. The tools are gone from the autonomous
 * surface (allowed_modes = ASSIST), so the model CANNOT create, validate or
 * disable a code even if it wanted to - but a model with no tool tends to
 * improvise, and the live failure did exactly that: it offered to create a
 * coupon, promised to pass the details to a team, and speculated about booking
 * a meeting, in one reply.
 *
 * So the turn is told plainly what the answer is. Silence is what produced the
 * improvisation.
 */
const COUPON_RE =
  /(קופון|קופונים|הנחה|הנחות|קוד\s*הנחה|מבצע|זיכוי\s*לחנות|coupon|discount|promo\s*code|voucher)/i;

/**
 * Validating a code WITHOUT naming it a coupon: "הקוד ABC תקף?".
 *
 * The word "coupon" never appears, but `validate_discount` is exactly what the
 * model would reach for, so the same scope decision has to cover it.
 */
const CODE_VALIDITY_RE =
  /(הקוד|קוד)\s*\S{0,20}?\s*(תקף|בתוקף|עובד|פעיל)|\bcode\b[^\n]{0,20}?\b(valid|still work|works)\b/i;

export function detectCouponIntent(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return COUPON_RE.test(t) || CODE_VALIDITY_RE.test(t);
}

/**
 * What the model must say instead of improvising.
 *
 * Three explicit prohibitions, each one an observed failure mode: do not offer
 * to make a coupon (there is no tool), do not hand the conversation to a person
 * (a discount question is not an incident), and do not pivot to a refund - a
 * customer asking about a promotion has not asked for their money back, and
 * offering it is how a discount enquiry turns into an unintended financial
 * conversation.
 */
export function buildCouponUnsupportedDirective(): string {
  return (
    `The customer is asking about a coupon, discount code or promotion.\n` +
    `This is NOT SUPPORTED in customer conversations, by product decision. You have no tool for it and must not look for one.\n` +
    `- Say plainly, in the customer's language, that coupons cannot be issued, checked or applied through this chat.\n` +
    `- Suggested Hebrew wording: "כרגע לא ניתן להפיק, לבדוק או להוסיף קופון דרך השיחה."\n` +
    `- Do NOT offer to create, generate or apply a coupon or discount.\n` +
    `- Do NOT offer a refund or a partial refund as a substitute. If the customer separately asks for a refund, that is a different request.\n` +
    `- Do NOT transfer the conversation to a human just because a discount was requested.\n` +
    `- Do NOT promise anyone will look into it.\n` +
    `- Answer briefly, then carry on helping with whatever else they need.\n`
  );
}

/**
 * The one exception (W9 phase d): the coupons the merchant chose to show on
 * the website widget, live right now. The model may share exactly these
 * codes, as written, and nothing else; every other rule above stands.
 */
export function buildCouponPromotionsDirective(promotions: Array<{
  code: string; amount: string; discountType: string; expiresAt: string | null; minimumAmount: string | null;
}>): string {
  const lines = promotions.map((p) => {
    const what = p.discountType === "percent" ? `${p.amount}% off` : p.discountType === "fixed_product" ? `${p.amount} off each eligible product` : `${p.amount} off the cart`;
    return `  - ${p.code}: ${what}${p.minimumAmount ? `, on orders from ${p.minimumAmount}` : ""}${p.expiresAt ? `, until ${dayMonthYear(p.expiresAt)}` : ""}`;
  });
  return (
    `The customer is asking about a coupon, discount code or promotion.\n` +
    `The store currently offers these promotions, chosen by the business to show on its website. You may share them, with the code EXACTLY as written:\n` +
    `${lines.join("\n")}\n` +
    `- These are the only codes you may mention. Never invent, guess or alter a code.\n` +
    `- Do NOT create, check or apply any other coupon, and do NOT promise one: that is not supported in this chat.\n` +
    `- Do NOT offer a refund as a substitute, and do NOT transfer to a human just because a discount was requested.\n` +
    `- The customer applies the code at checkout on the store.\n` +
    // Dev 2026-10-27 (urban-e23): asked "which promotions are there today?", the
    // reply gave the code and left out the free shipping the store's text states.
    `- Standing offers the store's own information states (free shipping above an amount, free returns) are promotions too: when asked which promotions there are, name them briefly with the codes.\n` +
    `- Write dates as day.month.year (30.09.2027), never 2027-09-30.\n`
  );
}

/** "2027-09-30" (or a full ISO time) as "30.09.2027"; anything else as given. */
function dayMonthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/**
 * "Write this on my order."
 *
 * The model never called the tool. Asked to record a callback request on
 * #1011 it replied "ביצעתי את הבקשה" and then, once that was stripped,
 * "בקשתך עודכנה בהזמנה" - twice claiming a write while Shopify showed
 * note: null and tags: "". The honesty net caught the claims; nothing caused
 * the write.
 */
const ORDER_NOTE_RE =
  /(תרשמו|תרשום|תכתבו|תכתוב|תוסיפו\s*הערה|הוסיפו\s*הערה|תתעדו|לתעד|תציינו|רשמו|note\s*on\s*(the\s*)?order|add\s*a?\s*note)/i;

export function detectOrderNoteIntent(text: string | null | undefined): boolean {
  return ORDER_NOTE_RE.test(String(text ?? ""));
}

/**
 * What a note IS, and what it is not.
 *
 * The second half matters as much as the first. A note is a record on an
 * order; it does not page anyone, create a task, or guarantee follow-up. The
 * model kept treating "I wrote it down" and "I told the team" as the same
 * sentence, which is how a customer ends up waiting for a call nobody has been
 * asked to make.
 */
export function buildOrderNoteDirective(): string {
  return (
    `The customer is asking to record something ON their order.\n` +
    `- Call add_order_note with the order they named (NOT create_note - that writes the customer profile and leaves the order blank) and a short, faithful summary of what they asked to record. Do this in THIS turn.\n` +
    `- Only after it returns successfully may you say the note was added.\n` +
    `- A note is a RECORD on the order. It does not notify anyone, does not create a task, and does not guarantee a callback.\n` +
    `- So do NOT say or imply that a team, agent or department has been told, will look at it, or will get back to them. If they need a person, that is a separate handoff you must actually perform.\n` +
    `- Suggested Hebrew wording on success: "ההערה נוספה להזמנה #<order>."\n` +
    `- If the tool fails, say the note was not added and offer a real alternative. Never describe an unwritten note as written.\n`
  );
}

export interface VariantIntent {
  /** The turn is asking about a concrete product attribute or its stock. */
  isVariantQuestion: boolean;
  /** The attribute value the customer named, when it looks like one ("159"). */
  attributeToken?: string;
}

/**
 * Does this message ask about a specific variant or its availability?
 *
 * Requires an attribute word AND an availability/question shape, so ordinary
 * browsing ("אני מחפש סנובורד למתחיל") stays with product discovery, where a
 * recommendation conversation is the right behaviour.
 */
export function detectVariantIntent(text: string | null | undefined): VariantIntent {
  const t = String(text ?? "");
  if (!t.trim()) return { isVariantQuestion: false };
  const hasAttribute = VARIANT_ATTRIBUTE_RE.test(t);
  const hasAvailability = AVAILABILITY_RE.test(t) || /\?/.test(t);
  if (!hasAttribute || !hasAvailability) return { isVariantQuestion: false };
  // A number next to the attribute is usually the value ("מידה 159").
  const m = t.match(/(?:מידה|גודל|אורך|size|length)\s*(?:של\s*)?(\d{2,3})/i);
  return { isVariantQuestion: true, ...(m ? { attributeToken: m[1] } : {}) };
}

/**
 * The directive added to a turn that asks about a variant.
 *
 * It does two jobs: send the model to the catalogue instead of to the
 * customer, and pre-empt the specific wrong answer this store produces - a
 * product with one variant has no options to choose between, so "which colour
 * did you mean?" is not a clarifying question, it is a dead end.
 */
export function buildVariantIntentDirective(intent: VariantIntent, locale: "he" | "en"): string {
  const size = intent.attributeToken ? ` The value they named is "${intent.attributeToken}".` : "";
  return (
    `The customer is asking about a SPECIFIC product attribute (size / length / colour / SKU) or its stock.${size}\n` +
    `This is a catalogue LOOKUP, not an issue to diagnose. Before you reply:\n` +
    `- Call variant_information with product_name set to the product they named. It accepts a name, so you do NOT need a product search first.\n` +
    `- Answer from the real variants it returns: whether that option exists, and whether it is in stock.\n` +
    `- If has_variant_options is false, the product is sold in ONE version. Say plainly that it does not come in different sizes/colours and give its stock status.\n` +
    `- Do NOT ask which version, colour or size they mean before you have looked. Do NOT list other products as an answer to this question.\n` +
    `- Do NOT say you are "checking now" or that you will get back to them. Look it up in this turn and answer.\n` +
    (locale === "he" ? `Reply in Hebrew.\n` : "")
  );
}

/** "is it in stock", "sold out", "available". Narrower than AVAILABILITY_RE: a bare "יש לכם" is not about stock. */
const STOCK_RE = /(במלאי|מלאי|זמין|זמינה|זמינים|זמינות|אזל|נגמר|in stock|out of stock|sold out|available|availability)/i;
/** "how much is it", "what does it cost". */
const PRICE_RE = /(כמה\s*(זה\s*|הוא\s*|היא\s*|הם\s*|הן\s*)?עול|מה\s*המחיר|המחיר\s*של|מחיר|how much|what(?:'s| is) the price|price of|\bcost)/i;

export type ProductInquiryKind = "variant" | "stock" | "price";

/**
 * Is this a question about a product's stock, size, colour or price, as
 * opposed to "help me choose"? (2026-10-25: "יש במלאי את המעיל?" and "יש את
 * מעיל הטרנץ' במידה M?" were both answered with a question.) Whether the
 * customer NAMED a product is the caller's to decide: the discovery engine
 * knows whether a product was extracted.
 */
export function detectProductInquiry(text: string | null | undefined): { kind: ProductInquiryKind; attributeToken?: string } | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const variant = detectVariantIntent(t);
  if (variant.isVariantQuestion) return { kind: "variant", ...(variant.attributeToken ? { attributeToken: variant.attributeToken } : {}) };
  if (STOCK_RE.test(t)) return { kind: "stock" };
  if (PRICE_RE.test(t)) return { kind: "price" };
  return null;
}

/**
 * The WooCommerce counterpart of buildVariantIntentDirective: the store has
 * no variant_information, so the lookup is a search by name, then the
 * product's variations when a size or colour is asked about.
 */
import { HEBREW_PRODUCT_GLOSSARY } from "./woo-chat-turn.service";

export function buildWooLookupDirective(kind: ProductInquiryKind, locale: "he" | "en"): string {
  return (
    `The customer is asking about the ${kind === "price" ? "PRICE" : kind === "stock" ? "STOCK" : "SIZE / COLOUR availability"} of a product they named. This is a catalogue LOOKUP:\n` +
    `- Call woocommerce.list_products with query set to the product's name as the store titles it (the titles are in English: "trench coat", not "טרנץ'"). ${HEBREW_PRODUCT_GLOSSARY}\n` +
    `- For a size or colour, then call woocommerce.list_product_variations with that product's id and answer from its variations: which sizes / colours exist and which are in stock.\n` +
    `- Answer the question in one or two short sentences from the results (yes / no, which sizes are in stock). Never write a URL: the product card carries the link. Write a price only when the customer asked for it, and then exactly as the result gives it, in the store's currency (\"₪529\"); otherwise leave the price to the card. If several products match, name them briefly and ask which one.\n` +
    `- Do NOT ask about budget, use or style first, and do NOT say you will check: check in this turn.\n` +
    (locale === "he" ? `Reply in Hebrew, naturally ("במידה M יש", not "עליי לבדוק").\n` : "")
  );
}

/** Our own messages that asked about money: "מה התקציב?", "טווח מחיר", "budget". */
const BUDGET_ASK = /תקציב|טווח (?:ה)?מחיר|טווח מחירים|budget|price range/i;

/**
 * The budget question, decided here rather than by the model (2026-10-25, eval
 * R1: "מה התקציב?" after every answer, four times in a row in one chat, and as
 * a slash menu of brackets). Budget is never required in a shop. It may be
 * asked once in a conversation, only to help an open recommendation, and never
 * after the customer named a product, a size or a colour.
 */
export function buildBudgetRule(outbound: Array<{ body: string | null }>, lookup: boolean): string {
  const asked = outbound.some((m) => BUDGET_ASK.test(m.body ?? ""));
  if (asked || lookup) {
    return "BUDGET: do NOT ask about budget or a price range in this reply" +
      (asked ? " - it was already asked in this conversation, and asking again is badgering." : " - the customer named what they want; answer about it.") +
      " If price matters, the products and their prices speak for themselves.";
  }
  return "BUDGET: optional, never a condition for showing products. Ask about it at most once in this conversation, and only when the customer wants a recommendation and the matching products span a wide price range. Never after they named a product, a size or a colour, never as a menu of brackets, never with a slash.";
}
