import { describe, it, expect } from "vitest";
import { normalizeReport, type DiscoveryInput } from "../services/business-discovery.service";

const baseInput: DiscoveryInput = {
  tenantId: "t1",
  domain: "https://acme.com",
  pages: [{ url: "https://acme.com", text: "we sell things" }],
  signals: {
    whatsapp: ["972501234567"],
    instagram: ["acme"],
    emails: ["support@acme.com"],
    phones: ["+97231234567"],
    platform: { slug: "shopify", name: "Shopify", strength: 4 },
    otherPlatforms: [{ slug: "magento", name: "Magento", strength: 1 }],
    tools: ["hubspot"],
    tracking: ["google_analytics"],
    coverage: ["https://acme.com", "https://acme.com/policies/refund-policy"],
  },
};

describe("normalizeReport", () => {
  it("builds channels authoritatively from ground-truth signals (never false-negative)", () => {
    const out = normalizeReport({ channels: [] }, baseInput); // LLM returned NO channels
    const types = out.communication.channels.map((c) => c.type);
    expect(types).toContain("whatsapp");
    expect(types).toContain("instagram");
    expect(types).toContain("email");
    expect(types).toContain("phone");
    const wa = out.communication.channels.find((c) => c.type === "whatsapp")!;
    expect(wa.identifier).toBe("972501234567");
    expect(wa.confidence).toBe("confirmed");
  });

  it("enriches a ground-truth channel with the LLM's inferred purpose", () => {
    const out = normalizeReport({ channels: [{ type: "whatsapp", purpose: "Order status" }] }, baseInput);
    const wa = out.communication.channels.find((c) => c.type === "whatsapp")!;
    expect(wa.purpose).toBe("Order status");
    expect(wa.confidence).toBe("confirmed");
  });

  it("uses the strength-scored platform as active + demotes weak matches to legacy", () => {
    const out = normalizeReport({}, baseInput);
    expect(out.technology.platform?.slug).toBe("shopify");
    expect(out.technology.platform?.confidence).toBe("confirmed"); // strength 4
    expect(out.technology.legacy.map((l) => l.slug)).toContain("magento");
    expect(out.technology.tracking.map((t) => t.slug)).toContain("google_analytics");
    expect(out.technology.tools.map((t) => t.slug)).toContain("hubspot");
  });

  it("marks a low-strength platform as low confidence", () => {
    const out = normalizeReport({}, { ...baseInput, signals: { platform: { slug: "magento", name: "Magento", strength: 1 } } });
    expect(out.technology.platform?.confidence).toBe("low");
  });

  it("normalizes policies into confidence-levelled findings", () => {
    const raw = { knowledge: { policies: { refunds: { found: true, confidence: "confirmed" }, returns: { found: false, confidence: "likely" }, shipping: true } } };
    const out = normalizeReport(raw, baseInput);
    expect(out.knowledge.policies!.refunds).toEqual({ found: true, confidence: "confirmed", url: undefined });
    expect(out.knowledge.policies!.returns!.found).toBe(false);
    expect(out.knowledge.policies!.terms!.found).toBeNull(); // absent → unknown, not false
    expect(out.knowledge.policies!.terms!.confidence).toBe("unknown");
  });

  it("flags already-detected recommended systems", () => {
    const out = normalizeReport({ recommendation: { systems: [{ slug: "shopify", reason: "your store" }, { slug: "gorgias", reason: "helpdesk" }] } }, baseInput);
    const shopify = out.recommendation.systems.find((s) => s.slug === "shopify")!;
    expect(shopify.alreadyDetected).toBe(true);
  });

  it("defaults an invalid employeeRole and coerces gap confidence", () => {
    const out = normalizeReport({ recommendation: { employeeRole: "wizard" }, gaps: [{ label: "Refund policy", confidence: "unknown" }] }, baseInput);
    expect(out.recommendation.employeeRole).toBe("customer_support");
    expect(out.gaps[0]!.confidence).toBe("unknown");
  });

  it("survives a nearly-empty object without throwing", () => {
    const out = normalizeReport({}, { ...baseInput, signals: {} });
    expect(out.recommendation.employeeRole).toBe("customer_support");
    expect(out.communication.channels).toEqual([]);
    expect(out.technology.platform).toBeNull();
  });
});

// A gap is a claimed ABSENCE — it must never survive when the report itself
// proves the thing exists (Doctrine law 2, enforced deterministically).
describe("gap contradiction filter", () => {
  const knFound = { policies: { refunds: { found: true, confidence: "confirmed" }, returns: { found: true, confidence: "confirmed" }, shipping: { found: true, confidence: "confirmed" } } };

  it("drops a 'no customer phone' gap (Hebrew) when a WhatsApp number was found", () => {
    const raw = { gaps: [{ label: "אין מספר טלפון שירות לקוחות גלוי בעמודי הקשר שנסקרו", ask: "האם יש מספר טלפון לשירות לקוחות שניתן לפרסם או לקשר למרכז טלפוני?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { whatsapp: ["972733859384"] } });
    expect(out.gaps).toHaveLength(0);
  });

  it("keeps the 'no phone' gap when NO phone or WhatsApp number exists", () => {
    const raw = { gaps: [{ label: "No customer service phone number visible", ask: "Do you have a support phone line?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { emails: ["hi@acme.com"] } });
    expect(out.gaps).toHaveLength(1);
  });

  it("drops a 'no Help Center' gap (Hebrew) when returns/refund policies were found", () => {
    const raw = {
      knowledge: knFound,
      gaps: [{ label: "אין מרכז עזרה מובנה (Help Center) עם קטלוג מאמרים מפורט", ask: "להקים Help Center מקצועי שיכלול מאמרים על משלוחים, מידות, החלפות והחזרות." }],
    };
    const out = normalizeReport(raw, { ...baseInput, signals: {} });
    expect(out.gaps).toHaveLength(0);
  });

  it("drops a 'missing shipping policy' gap when the shipping policy was found", () => {
    const raw = { knowledge: knFound, gaps: [{ label: "Shipping policy not found", ask: "What is your shipping policy?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: {} });
    expect(out.gaps).toHaveLength(0);
  });

  it("keeps unrelated honest gaps untouched", () => {
    const raw = { knowledge: knFound, gaps: [{ label: "Brand voice on social media unclear", ask: "How do you want to sound on Instagram?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { whatsapp: ["972501234567"] } });
    expect(out.gaps).toHaveLength(1);
  });

  it("does not misread 'ממוקד' (targeted) as 'מוקד' (call center)", () => {
    // Regression: a segmentation gap whose ask mentions "קמפיינים ממוקדים"
    // must survive even when a WhatsApp number exists.
    const raw = { gaps: [{ label: "חוסר ראיה על פילוח לקוחות ומסלולי שימור פרטניים", ask: "אילו קהלים תרצו לשמר עם קמפיינים ממוקדים?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { whatsapp: ["972501234567"] } });
    expect(out.gaps).toHaveLength(1);
  });

  it("still drops a Hebrew call-center gap phrased with מוקד טלפוני", () => {
    const raw = { gaps: [{ label: "אין מוקד טלפוני לשירות לקוחות", ask: "האם יש מוקד טלפוני?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { whatsapp: ["972501234567"] } });
    expect(out.gaps).toHaveLength(0);
  });

  it("keeps a gap whose ASK merely mentions email (hours/SLA gap, observed live)", () => {
    const raw = { gaps: [{ label: "שעות פעילות וצפי מענה לשירות לקוחות לא מופיעים בבירור", ask: "מהן שעות הפעילות והאם עונים גם באימייל?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: { emails: ["support@acme.com"] } });
    expect(out.gaps).toHaveLength(1);
  });

  it("keeps a size-guide gap whose ASK references FAQ (observed live)", () => {
    const raw = { knowledge: knFound, gaps: [{ label: "היעדר מדריך מידות גלוי בעמודים שסקרתי", ask: "האם יש מדריך מידות או עמוד שאלות נפוצות עם מידע על מידות?" }] };
    const out = normalizeReport(raw, { ...baseInput, signals: {} });
    expect(out.gaps).toHaveLength(1);
  });
});
