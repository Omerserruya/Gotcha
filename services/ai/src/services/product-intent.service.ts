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
