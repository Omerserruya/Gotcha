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
