/**
 * The business section a tool belongs to (B3, Omer 2026-10-14): the employee
 * page groups its tools by integration, and inside each one by what the tool
 * is about (Orders, Coupons, Customers...), not by READ/WRITE.
 *
 * Derived from the tool's own slug, so a new catalogue row lands in a section
 * without a migration. The rules run in order and the first match wins; a slug
 * that matches none is "other", and the unit test fails for any catalogue row
 * (CATALOG_TOOL_HE, a superset of catalog_tools on dev) that lands there.
 *
 * `domain` doubles as the icon key: the screen maps it to an icon.
 */
export const TOOL_DOMAINS = [
  "orders",
  "products",
  "customers",
  "coupons",
  "payments",
  "shipping",
  "returns",
  "leads",
  "notes",
  "records",
  "calendar",
  "messaging",
  "handover",
  "automation",
  "other",
] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

const LABELS: Record<ToolDomain, { he: string; en: string }> = {
  orders: { he: "הזמנות", en: "Orders" },
  products: { he: "מוצרים", en: "Products" },
  customers: { he: "לקוחות", en: "Customers" },
  coupons: { he: "קופונים והנחות", en: "Coupons and discounts" },
  payments: { he: "תשלומים והחזרים", en: "Payments and refunds" },
  shipping: { he: "משלוחים", en: "Shipping" },
  returns: { he: "החזרות והחלפות", en: "Returns and exchanges" },
  leads: { he: "לידים ועסקאות", en: "Leads and deals" },
  notes: { he: "הערות ופעילות", en: "Notes and activity" },
  records: { he: "רשומות", en: "Records" },
  calendar: { he: "יומן ופגישות", en: "Calendar and meetings" },
  messaging: { he: "הודעות", en: "Messaging" },
  handover: { he: "העברה לנציג", en: "Handover" },
  automation: { he: "אוטומציות", en: "Automations" },
  other: { he: "אחר", en: "Other" },
};

/** Whole integrations that are one section. */
const BY_INTEGRATION: Record<string, ToolDomain> = {
  returngo: "returns",
  google_calendar: "calendar",
};

/** Built-in (registry) tools, by name. */
const BUILT_IN: Record<string, ToolDomain> = {
  send_message: "messaging",
  generate_followup: "messaging",
  schedule_followup: "messaging",
  schedule_followup_template: "messaging",
  close_conversation: "messaging",
  create_broadcast: "messaging",
  schedule_broadcast: "messaging",
  update_contact: "customers",
  tag_contact: "customers",
  merge_contacts: "customers",
  link_customer_identifier: "customers",
  update_crm: "leads",
  create_ticket: "leads",
  create_task: "leads",
  escalate_to_human: "handover",
  schedule_meeting: "calendar",
  create_workflow: "automation",
};

/** The registry category of a built-in the table above does not name yet. */
const BY_REGISTRY_CATEGORY: Record<string, ToolDomain> = {
  messaging: "messaging",
  broadcast: "messaging",
  crm: "leads",
  identity: "customers",
  workflow: "automation",
};

/** Integration tool slugs, first match wins. */
const SLUG_RULES: Array<[RegExp, ToolDomain]> = [
  [/return|exchange/, "returns"],
  [/coupon|discount/, "coupons"],
  [/refund|invoice|payment|transaction|financial/, "payments"],
  [/shipment|tracking|delivery|fulfillment|pickup|shipping/, "shipping"],
  [/event|meeting|calendar/, "calendar"],
  [/product|variant|variation|inventory/, "products"],
  [/order|confirmation/, "orders"],
  [/lead|deal|case|task/, "leads"],
  [/customer|contact|segment|tag|profile|metafield/, "customers"],
  [/note|activity/, "notes"],
  [/record|row|document|item|board|table|field|shop/, "records"],
];

/**
 * The section of one tool. `toolName` is the row's name ("woocommerce.get_order",
 * "integration.get_order" or a built-in "send_message"); `integration` is its
 * integration slug, null for a built-in.
 */
export function toolDomain(toolName: string, integration: string | null, registryCategory?: string | null): ToolDomain {
  const name = String(toolName || "");
  if (!integration) {
    return BUILT_IN[name] ?? (registryCategory ? BY_REGISTRY_CATEGORY[registryCategory] : undefined) ?? "other";
  }
  const whole = BY_INTEGRATION[integration];
  if (whole) return whole;
  const slug = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  for (const [re, domain] of SLUG_RULES) if (re.test(slug)) return domain;
  return "other";
}

export function toolDomainLabel(domain: ToolDomain, locale: "he" | "en"): string {
  return LABELS[domain][locale];
}
