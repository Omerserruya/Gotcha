/**
 * Sanitized replay fixture: "where is my order?" with no ETA available.
 *
 * Modelled on a real WhatsApp conversation of 2026-07-31 that went wrong in
 * five distinct ways. NO live customer data: the name is fictional, there is no
 * phone number, and the tenant/agent/conversation ids are invented. The order
 * number is kept because it IS the defect - a customer-facing order NAME being
 * fed into an internal-id parameter.
 *
 * What the original conversation did, in order:
 *   1. volunteered the acronym "ETA" into a Hebrew chat, unprompted
 *   2. explained it twice because the customer asked twice what it meant
 *   3. narrated its own tool calls ("I ran two checks")
 *   4. described internal writes ("a note/tag on the fulfillment line")
 *   5. surfaced a provider error as "a system error on our side"
 *   6. called one failing tool four times in five minutes
 *   7. promised to contact a shipping team it cannot reach - four times
 *   8. promised proactive WhatsApp updates and scheduled nothing
 *   9. wrote a slash form about itself after speaking as a woman throughout
 *  10. addressed a male customer with slash forms
 *
 * The customer asked to cancel the order.
 */

/** The customer's real words, in order. Fictional sender. */
export const CUSTOMER_TURNS: string[] = [
  "היי",
  "אני רוצה לבדוק האם ההזמנה שלי יצאה לדרך כבר?",
  "מה זה ETA?",
  "וכן תעדכני אותי כשזה יוצא לדרך בבקשה",
  "קיבלתי מייל שההזמנה שלי אושרה 1006",
  "תוך כמה זמן זה אמור לקרות? ומתי היא צריכה להגיע?",
  "מה זה ETA לא הבנתי",
  "אז מתי ההזמנה שלי תגיע? יש לך צפי?",
  "את יכולה לעשות את זה?",
];

/**
 * Replies the model actually produced, verbatim except for the customer's
 * name. Each is an input to the reply guard in the regression test - the point
 * is that these exact strings must not reach a customer unchanged.
 */
export const BAD_REPLIES = {
  volunteeredAcronym:
    "טוב שכתבת. בדקתי גם עבור ETA, לא נמצא תיעוד של תאריך הגעה משוער.",
  narratedTwoChecks:
    "עשיתי עכשיו שתי בדיקות: בדקתי את ה‑ETA להזמנה #1006, אין אצלנו תיעוד של זמן הגעה משוער. ניסיתי להוסיף הערה/תג לשורת המילוי, אבל נתקלה שגיאת מערכת והפעולה נכשלה.",
  promisedTeamContact:
    "כרגע אין צפי להגעה כי ההזמנה עדיין לא נשלחה. אפשרי שאפנה עכשיו לצוות המשלוחים כדי לבקש מועד משוער.",
  promisedProactiveUpdate:
    "מעולה, אדאג לעדכן אותך כאן בוואטסאפ ברגע שההזמנה תצא לדרך.",
  slashFormAboutSelf:
    "מציע/ה להמשיך בשני צעדים עכשיו: לפנות ידנית לצוות המשלוחים.",
  slashFormAtCustomer:
    "מאשר/ת שאעשה את זה עכשיו?",
  exposedTechnicalFailure:
    "ניסיתי לסמן לצוות המשלוחים שיבדקו, אך הבקשה לא הושלמה בגלל תקלה טכנית אצלנו.",
} as const;

/**
 * The same information said properly. These must survive the guard untouched -
 * a guard that also mangles the good version has not fixed anything.
 */
export const GOOD_REPLIES = {
  noEtaPlainly:
    "בדקתי, ההזמנה עדיין לא נשלחה, ולכן אין עדיין תאריך הגעה משוער.",
  offerToFollowUp:
    "רוצה שאעדכן אותך כאן ברגע שההזמנה יוצאת?",
  recordedOnly:
    "רשמתי את הבקשה על ההזמנה כדי שתהיה מולנו.",
  honestFailure:
    "לא הצלחתי להשלים את הפעולה כרגע. אפשר להעביר את הטיפול לנציג אנושי.",
  genderNeutralAsk:
    "אפשר לבצע את הפעולה עכשיו?",
  femaleFirstPerson:
    "רגע אחד, בודקת את זה עכשיו.",
} as const;

/** The four failing calls, in order, with the arguments the model sent. */
export const FAILED_WRITE_ATTEMPTS: Array<{ args: Record<string, unknown>; reason: string }> = [
  { args: { order_id: "#1006", note: "Customer requested shipping ETA and tracking." }, reason: "shopify_400: id: expected String to be a id" },
  { args: { order_id: "#1006", tag: "investigate_shipment", note: "Please investigate." }, reason: "shopify_400: id: expected String to be a id" },
  { args: { order_id: "#1006", tag: "shipping-investigation", note: "Mark as high priority." }, reason: "shopify_400: id: expected String to be a id" },
  { args: { order_id: "1006", tag: "urgent_shipment_check", note: "Flagged for urgent ops follow-up." }, reason: "shopify_404: Not Found" },
];

export const FIXTURE = {
  tenantSlug: "replay-tenant",
  locale: "he",
  agentName: "Maya",
  agentGrammaticalGender: "feminine",
  /** Fictional. The real customer's name and number appear nowhere. */
  customerDisplayName: "יונתן לוי",
  customerGrammaticalGender: "masculine",
  orderName: "#1006",
  /** A realistic 13-digit Shopify internal id; not from any real store. */
  orderInternalId: 5678901234567,
  invokedTools: [
    "shopify.find_latest_order",
    "shopify.check_delivery_eta",
    "shopify.get_fulfillment_status",
    "shopify.update_order_fulfillment",
  ],
} as const;
