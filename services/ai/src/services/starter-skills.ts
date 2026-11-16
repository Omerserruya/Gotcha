/**
 * Starter store skills (2026-11-16, reply engine v2).
 *
 * Prod had zero BusinessSkill rows on 2026-11-16, so a new store's AI employee
 * started with no playbooks at all. These are the playbooks a store employee
 * needs on day one. They are attached at setup (status "active", mode decided
 * by the setup code) and the business can edit any of them afterwards.
 *
 * A skill never grants a tool (business-skills.service.ts): the step tools here
 * are only the names the skill expects, and the fit check still decides per
 * employee. That is why the tools are resolved PER PLATFORM - a Woo store must
 * not get Shopify tool names, or every step would read as a handover point.
 *
 * Tool names are the adapter names the bot exposes (`shopify.get_order`,
 * `woocommerce.list_products`) plus the system tools from agent-tools.ts.
 */
import type { SkillInput, SkillStep } from "./business-skills.service";

export type StorePlatform = "shopify" | "woocommerce";
export type StarterLocale = "he" | "en";

/** Capability → the adapter tool slugs that serve it on each platform. Empty = none on that platform. */
const CAP: Record<string, Record<StorePlatform, string[]>> = {
  findOrder: {
    shopify: ["order_lookup", "get_order", "find_latest_order", "get_customer_orders"],
    woocommerce: ["get_order", "list_customer_orders"],
  },
  trackOrder: {
    shopify: ["get_fulfillment_status", "track_shipment", "get_tracking_url"],
    woocommerce: ["get_shipment_tracking"],
  },
  searchProducts: {
    shopify: ["search_products", "get_product"],
    woocommerce: ["list_products", "get_product"],
  },
  variants: {
    shopify: ["variant_information", "inventory_status"],
    woocommerce: ["list_product_variations"],
  },
  deliveryEta: {
    shopify: ["check_delivery_eta", "check_pickup_point"],
    woocommerce: [],
  },
  checkDiscount: {
    shopify: ["validate_discount", "get_customer_discounts"],
    woocommerce: ["get_coupon"],
  },
  returnOrExchange: {
    shopify: ["create_return", "exchange_order_item"],
    woocommerce: [],
  },
  returnStatus: {
    shopify: ["check_return_status", "get_refund_status"],
    woocommerce: ["list_refunds"],
  },
  cancelOrder: {
    shopify: ["cancel_order"],
    woocommerce: ["cancel_order"],
  },
};

function tools(platform: StorePlatform, ...caps: string[]): string[] {
  return caps.flatMap((c) => (CAP[c]?.[platform] ?? []).map((slug) => `${platform}.${slug}`));
}

const HANDOVER = "escalate_to_human";
const CARD = ["send_product_card", "send_product_carousel"];

type Txt = Record<StarterLocale, string>;
const t = (he: string, en: string): Txt => ({ he, en });

interface StepDef {
  id: string;
  kind: SkillStep["kind"];
  title: Txt;
  guidance: Txt;
  tools: string[];
  approvalOverAmount?: number | null;
  elseNote?: Txt | null;
}
interface SkillDef {
  key: string;
  category: "orders" | "products" | "bookings" | "other";
  name: Txt;
  situation: Txt;
  whenToUse: Txt;
  examples: Record<StarterLocale, string[]>;
  steps: StepDef[];
  rules: Array<{ type: "never" | "handover"; text: Txt }>;
  requiredInfo: Array<{ key: string; label: Txt; priority: number }>;
}

function defs(p: StorePlatform): SkillDef[] {
  const canReturn = tools(p, "returnOrExchange").length > 0;
  return [
    {
      key: "order_status",
      category: "orders",
      name: t("איפה ההזמנה שלי", "Where is my order"),
      situation: t("הלקוח שואל מה מצב ההזמנה או המשלוח שלו", "The customer asks about the status of their order or delivery"),
      whenToUse: t("שאלה על הזמנה שכבר בוצעה: מתי תגיע, איפה היא, מספר מעקב", "A question about an order already placed: when it arrives, where it is, a tracking number"),
      examples: {
        he: ["איפה ההזמנה שלי?", "מתי החבילה מגיעה?", "יש מספר מעקב?"],
        en: ["Where is my order?", "When will my package arrive?", "Do you have a tracking number?"],
      },
      steps: [
        {
          id: "find", kind: "find", title: t("מציאת ההזמנה", "Find the order"),
          guidance: t("חפש לפי מספר הזמנה, ואם אין, לפי הטלפון או המייל של הלקוח. אל תבקש פרט שכבר ידוע.", "Look it up by order number, otherwise by the customer's phone or email. Never ask for a detail you already have."),
          tools: tools(p, "findOrder"),
          elseNote: t("לא נמצאה הזמנה אחרי שני ניסיונות: העבר לנציג", "No order after two tries: hand over"),
        },
        {
          id: "track", kind: "check", title: t("בדיקת סטטוס ומעקב", "Check status and tracking"),
          guidance: t("בדוק את סטטוס המשלוח ואת קישור המעקב.", "Check the fulfilment status and the tracking link."),
          tools: tools(p, "trackOrder"),
        },
        {
          id: "tell", kind: "message", title: t("עדכון הלקוח", "Tell the customer"),
          guidance: t("ענה בקצרה: איפה ההזמנה, מה השלב הבא, וקישור מעקב אם יש. רק מה שהכלי החזיר.", "Answer briefly: where the order is, what comes next, and the tracking link if there is one. Only what the tool returned."),
          tools: [],
        },
      ],
      rules: [
        { type: "never", text: t("לא להבטיח תאריך הגעה שלא הופיע בתוצאה של כלי", "Never promise a delivery date that no tool returned") },
        { type: "handover", text: t("ההזמנה מתעכבת מעבר לזמן שהובטח, או שהלקוח כועס", "The order is late beyond what was promised, or the customer is upset") },
      ],
      requiredInfo: [{ key: "order_identifier", label: t("מספר הזמנה, טלפון או מייל", "Order number, phone or email"), priority: 1 }],
    },
    {
      key: "product_recommendation",
      category: "products",
      name: t("המלצה על מוצר", "Product recommendation"),
      situation: t("הלקוח מחפש מוצר ולא יודע בדיוק מה", "The customer is looking for a product and is not sure which"),
      whenToUse: t("הלקוח מתאר צורך, מתנה, סגנון או תקציב, ומבקש הצעה", "The customer describes a need, a gift, a style or a budget and wants a suggestion"),
      examples: {
        he: ["מחפשת מתנה לאמא שלי", "מה מתאים לעור יבש?", "יש משהו עד 200 שקל?"],
        en: ["I'm looking for a gift for my mom", "What works for dry skin?", "Anything under $50?"],
      },
      steps: [
        {
          id: "need", kind: "find", title: t("הבנת הצורך", "Understand the need"),
          guidance: t("שאלה אחת או שתיים לכל היותר: למי, לאיזה שימוש, תקציב. אם כבר יש מספיק, חפש מיד.", "One or two questions at most: who it is for, what for, budget. If you already know enough, search right away."),
          tools: [],
        },
        {
          id: "search", kind: "check", title: t("חיפוש בחנות", "Search the store"),
          guidance: t("חפש בקטלוג. אם אין תוצאות, נסה מילים אחרות או בלי סינון לפני שאתה אומר שאין.", "Search the catalogue. With no results, try other words or drop a filter before saying there is nothing."),
          tools: tools(p, "searchProducts", "variants"),
        },
        {
          id: "show", kind: "message", title: t("הצגת עד שלוש אפשרויות", "Show up to three options"),
          guidance: t("הצג עד שלושה מוצרים מתאימים עם הסיבה הקצרה לכל אחד, ושאל איזה מדבר אליו. מחיר רק מהתוצאה.", "Show up to three matching products with a short reason for each, and ask which one speaks to them. Prices only from the result."),
          tools: CARD,
        },
      ],
      rules: [
        { type: "never", text: t("לא להמציא מוצר, צבע, מידה או מחיר שלא הופיעו בתוצאה", "Never invent a product, colour, size or price that the result did not show") },
      ],
      requiredInfo: [
        { key: "need", label: t("מה מחפשים ולמי", "What they need and for whom"), priority: 1 },
        { key: "budget", label: t("תקציב", "Budget"), priority: 2 },
      ],
    },
    {
      key: "size_help",
      category: "products",
      name: t("עזרה במידה", "Size help"),
      situation: t("הלקוח לא בטוח איזו מידה לבחור או אם יש מידה במלאי", "The customer is unsure which size to pick or whether a size is in stock"),
      whenToUse: t("שאלה על מידה, התאמה או מלאי של מידה מסוימת", "A question about a size, fit, or stock of a specific size"),
      examples: {
        he: ["איזו מידה לקחת?", "יש את זה ב-M?", "זה גדול או קטן?"],
        en: ["Which size should I take?", "Do you have it in M?", "Does it run large or small?"],
      },
      steps: [
        {
          id: "product", kind: "find", title: t("זיהוי המוצר", "Identify the product"),
          guidance: t("ודא על איזה מוצר מדובר. אם הוצג קודם בשיחה, השתמש בו.", "Make sure which product it is. If it was shown earlier in the chat, use it."),
          tools: tools(p, "searchProducts"),
        },
        {
          id: "sizes", kind: "check", title: t("בדיקת מידות ומלאי", "Check sizes and stock"),
          guidance: t("בדוק אילו מידות קיימות ומה במלאי. טבלת מידות וההנחיות להתאמה מגיעות מהידע של העסק.", "Check which sizes exist and which are in stock. The size chart and fit guidance come from the business's knowledge."),
          tools: tools(p, "variants"),
        },
        {
          id: "answer", kind: "message", title: t("המלצה על מידה", "Recommend a size"),
          guidance: t("המלץ על מידה לפי מה שהלקוח סיפר וטבלת המידות, ואמור אם היא במלאי.", "Recommend a size from what the customer said and the size chart, and say whether it is in stock."),
          tools: CARD,
        },
      ],
      rules: [{ type: "never", text: t("לא לומר שמידה במלאי בלי בדיקה בכלי", "Never say a size is in stock without checking a tool") }],
      requiredInfo: [{ key: "product", label: t("המוצר", "The product"), priority: 1 }],
    },
    {
      key: "return_exchange",
      category: "orders",
      name: t("החזרה או החלפה", "Return or exchange"),
      situation: t("הלקוח רוצה להחזיר או להחליף מוצר", "The customer wants to return or exchange an item"),
      whenToUse: t("בקשה להחזיר, להחליף מידה או צבע, או לקבל זיכוי", "A request to return, swap a size or colour, or get a refund"),
      examples: {
        he: ["אני רוצה להחזיר", "אפשר להחליף מידה?", "המוצר הגיע פגום"],
        en: ["I want to return this", "Can I exchange for another size?", "The item arrived damaged"],
      },
      steps: [
        {
          id: "find", kind: "find", title: t("מציאת ההזמנה", "Find the order"),
          guidance: t("מצא את ההזמנה ואת הפריט.", "Find the order and the item."),
          tools: tools(p, "findOrder"),
        },
        {
          id: "policy", kind: "check", title: t("בדיקה מול מדיניות ההחזרות", "Check against the return policy"),
          guidance: t("בדוק מול מדיניות ההחזרות של העסק אם עוד אפשר, לפי התאריך ומצב המוצר.", "Check the business's return policy: is it still allowed, by date and item condition."),
          tools: tools(p, "returnStatus"),
        },
        canReturn
          ? {
              id: "open", kind: "change", title: t("פתיחת החזרה או החלפה", "Open the return or exchange"),
              guidance: t("פתח את ההחזרה או ההחלפה רק אחרי שהלקוח אישר את הפרטים. נדרש אישור של העסק.", "Open the return or exchange only after the customer confirmed the details. Needs the business's approval."),
              tools: tools(p, "returnOrExchange"),
              approvalOverAmount: 0.01,
            }
          : {
              id: "handover", kind: "handover", title: t("העברה לצוות", "Hand over to the team"),
              guidance: t("סכם לצוות: הזמנה, פריט, סיבה ומה הלקוח מבקש.", "Summarise for the team: order, item, reason and what the customer wants."),
              tools: [HANDOVER],
            },
        {
          id: "confirm", kind: "message", title: t("עדכון הלקוח", "Tell the customer"),
          guidance: t("אמור מה קרה בפועל ומה השלב הבא. אם זה ממתין לאישור, אמור שזה ממתין.", "Say what actually happened and the next step. If it waits for approval, say it is waiting."),
          tools: [],
        },
      ],
      rules: [
        { type: "never", text: t("לא להבטיח זיכוי או סכום לפני שהפעולה בוצעה", "Never promise a refund or an amount before the action is done") },
        { type: "handover", text: t("מוצר פגום, או בקשה מחוץ למדיניות", "A damaged item, or a request outside the policy") },
      ],
      requiredInfo: [
        { key: "order_identifier", label: t("מספר הזמנה, טלפון או מייל", "Order number, phone or email"), priority: 1 },
        { key: "reason", label: t("סיבת ההחזרה", "Reason for the return"), priority: 2 },
      ],
    },
    {
      key: "cancel_order",
      category: "orders",
      name: t("ביטול הזמנה", "Cancel an order"),
      situation: t("הלקוח רוצה לבטל הזמנה", "The customer wants to cancel an order"),
      whenToUse: t("בקשה מפורשת לבטל הזמנה שכבר בוצעה", "An explicit request to cancel an order already placed"),
      examples: { he: ["אני רוצה לבטל את ההזמנה", "אפשר לבטל?"], en: ["I want to cancel my order", "Can I cancel?"] },
      steps: [
        { id: "find", kind: "find", title: t("מציאת ההזמנה", "Find the order"), guidance: t("מצא את ההזמנה.", "Find the order."), tools: tools(p, "findOrder") },
        {
          id: "state", kind: "check", title: t("בדיקה שעוד לא נשלחה", "Check it has not shipped"),
          guidance: t("הזמנה שכבר נשלחה לא מבטלים: מציעים החזרה.", "An order that already shipped is not cancelled: offer a return."),
          tools: tools(p, "trackOrder"),
        },
        {
          id: "cancel", kind: "change", title: t("ביטול", "Cancel"),
          guidance: t("בטל רק אחרי שהלקוח אישר במפורש איזו הזמנה. נדרש אישור של העסק.", "Cancel only after the customer explicitly confirmed which order. Needs the business's approval."),
          tools: tools(p, "cancelOrder"),
          approvalOverAmount: 0.01,
        },
        { id: "confirm", kind: "message", title: t("עדכון הלקוח", "Tell the customer"), guidance: t("אמור מה קרה בפועל.", "Say what actually happened."), tools: [] },
      ],
      rules: [{ type: "never", text: t("לא לומר שההזמנה בוטלה לפני שהכלי החזיר הצלחה", "Never say the order is cancelled before the tool returned success") }],
      requiredInfo: [{ key: "order_identifier", label: t("מספר הזמנה, טלפון או מייל", "Order number, phone or email"), priority: 1 }],
    },
    {
      key: "shipping_info",
      category: "other",
      name: t("משלוחים ואיסוף", "Shipping and pickup"),
      situation: t("הלקוח שואל על זמני משלוח, עלות או איסוף עצמי לפני הזמנה", "The customer asks about delivery times, cost or pickup before ordering"),
      whenToUse: t("שאלה כללית על משלוח, לא על הזמנה קיימת", "A general shipping question, not about an existing order"),
      examples: {
        he: ["כמה זמן לוקח משלוח?", "יש משלוח חינם?", "אפשר לאסוף?"],
        en: ["How long does shipping take?", "Is there free shipping?", "Can I pick it up?"],
      },
      steps: [
        {
          id: "answer", kind: "check", title: t("תשובה מהמדיניות", "Answer from the policy"),
          guidance: t("ענה ממדיניות המשלוחים של העסק. אם יש כלי לזמני הגעה, השתמש בו.", "Answer from the business's shipping policy. Use the delivery-time tool if there is one."),
          tools: tools(p, "deliveryEta"),
        },
      ],
      rules: [{ type: "never", text: t("לא להמציא עלות או זמן משלוח שלא מופיעים במדיניות", "Never invent a shipping cost or time that is not in the policy") }],
      requiredInfo: [],
    },
    {
      key: "discount_code",
      category: "other",
      name: t("קופון והנחה", "Coupon and discount"),
      situation: t("הלקוח שואל על קוד הנחה או שקוד לא עובד", "The customer asks about a discount code or a code that does not work"),
      whenToUse: t("שאלה על קופון קיים, מבצע, או קוד שנדחה", "A question about an existing coupon, a sale, or a rejected code"),
      examples: {
        he: ["הקוד לא עובד", "יש קוד הנחה?", "יש מבצע עכשיו?"],
        en: ["My code doesn't work", "Is there a discount code?", "Any sale right now?"],
      },
      steps: [
        {
          id: "check", kind: "check", title: t("בדיקת הקוד", "Check the code"),
          guidance: t("בדוק אם הקוד קיים ובתוקף, ומה התנאים שלו.", "Check whether the code exists and is valid, and what its conditions are."),
          tools: tools(p, "checkDiscount"),
        },
        {
          id: "answer", kind: "message", title: t("תשובה", "Answer"),
          guidance: t("הסבר למה הקוד לא עבד, או מה המבצע הקיים. מבצע על מוצר אפשר להזכיר בשמו.", "Explain why the code failed, or what the current sale is. A sale on a product may be named."),
          tools: [],
        },
      ],
      rules: [
        { type: "never", text: t("לא להמציא קוד הנחה, ולא ליצור קופון בלי אישור של העסק", "Never invent a discount code, and never create a coupon without the business's approval") },
      ],
      requiredInfo: [],
    },
    {
      key: "talk_to_person",
      category: "other",
      name: t("העברה לנציג", "Hand over to a person"),
      situation: t("הלקוח מבקש אדם, כועס, או שהבקשה מחוץ למה שאפשר לעשות כאן", "The customer asks for a person, is upset, or the request is beyond what can be done here"),
      whenToUse: t("בקשה מפורשת לדבר עם נציג, תלונה חריפה, או מקרה שאין לו כלי", "An explicit request for a person, a strong complaint, or a case with no tool"),
      examples: { he: ["אפשר לדבר עם מישהו?", "אני רוצה נציג"], en: ["Can I talk to someone?", "I want a human"] },
      steps: [
        {
          id: "handover", kind: "handover", title: t("העברה עם סיכום", "Hand over with a summary"),
          guidance: t("העבר מיד, עם סיכום קצר לצוות: מה הלקוח רוצה ומה כבר נבדק. אל תבקש ממנו לחזור על עצמו.", "Hand over right away with a short summary for the team: what the customer wants and what was already checked. Do not make them repeat themselves."),
          tools: [HANDOVER],
        },
      ],
      rules: [{ type: "never", text: t("לא לנסות לשכנע לקוח שביקש נציג להמשיך עם הבוט", "Never try to talk a customer who asked for a person into staying with the bot") }],
      requiredInfo: [],
    },
  ];
}

/** Keys of the starter skills, stable across locales (for idempotent setup). */
export const STARTER_SKILL_KEYS = defs("shopify").map((d) => d.key);

/**
 * The starter store skills for a platform, as SkillInput bodies ready for
 * createSkill. `key` is returned beside each so setup can skip ones already
 * created (match by name in the tenant's locale).
 */
export function starterStoreSkills(platform: StorePlatform, locale: StarterLocale = "he"): Array<{ key: string; skill: SkillInput }> {
  return defs(platform).map((d) => ({
    key: d.key,
    skill: {
      name: d.name[locale],
      situation: d.situation[locale],
      category: d.category,
      whenToUse: d.whenToUse[locale],
      examples: d.examples[locale],
      exclusions: [],
      steps: d.steps.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title[locale],
        guidance: s.guidance[locale],
        tools: [...new Set(s.tools)],
        approvalOverAmount: s.approvalOverAmount ?? null,
        elseNote: s.elseNote ? s.elseNote[locale] : null,
      })),
      rules: d.rules.map((r) => ({ type: r.type, text: r.text[locale] })),
      requiredInfo: d.requiredInfo.map((r) => ({ key: r.key, label: r.label[locale], priority: r.priority })),
      status: "active",
    },
  }));
}

/** Every tool name a platform's starter skills reference (for a test against the adapter list). */
export function starterToolNames(platform: StorePlatform): string[] {
  return [...new Set(defs(platform).flatMap((d) => d.steps.flatMap((s) => s.tools)))];
}
