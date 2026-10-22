/**
 * The intents a conversation can have, and their labels in both languages.
 *
 * ONE source: the ai service's analysis on close writes these keys
 * (docs/architecture/conversation-intelligence-on-close.md), and every screen
 * that shows an intent (the Home chat, Analytics) shows these labels. A
 * breakdown groups by the key, so a key is never renamed; adding one is
 * announced to the frontend, whose own copy is only a fallback.
 *
 * No imports: services deep-import this file
 * (`@chatcenter/shared/src/lib/conversation-intents`) so a test that mocks the
 * shared barrel wholesale still has it.
 */
export const INTENTS = {
  order_status: { en: "Order status", he: "סטטוס הזמנה" },
  shipping: { en: "Shipping and delivery", he: "משלוח" },
  returns_exchanges: { en: "Returns and exchanges", he: "החזרות והחלפות" },
  refund: { en: "Refunds", he: "החזרים כספיים" },
  product_question: { en: "Product questions", he: "שאלות על מוצר" },
  pricing_purchase: { en: "Pricing and buying", he: "מחיר ורכישה" },
  booking: { en: "Appointments", he: "תיאום פגישה" },
  billing_payment: { en: "Billing and payment", he: "חיוב ותשלום" },
  technical_issue: { en: "Technical issue", he: "תקלה טכנית" },
  complaint: { en: "Complaint", he: "תלונה" },
  account: { en: "Account", he: "חשבון" },
  other: { en: "Other", he: "אחר" },
} as const;

export type Intent = keyof typeof INTENTS;

export function isIntentKey(key: unknown): key is Intent {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(INTENTS, key);
}

/** The label in the interface language; an unknown key is returned as given. */
export function intentLabel(key: string, locale: "he" | "en"): string {
  return isIntentKey(key) ? INTENTS[key][locale] : key;
}
