import { describe, it, expect } from "vitest";
import {
  buildEntry,
  checksumOf,
  dedupeKeyFor,
  normalizeContent,
  normalizeUrl,
  reconcile,
  SCAN_VERSION,
  type ExistingDoc,
  type ProjectedEntry,
} from "../onboarding-projection";
import {
  projectDiscoveryTopics,
  projectPages,
  projectReadinessAnswers,
  projectExternalSources,
} from "../discovery-to-knowledge";

const CTX = { language: "en", now: "2026-07-29T00:00:00.000Z" };

// A tenant whose scan actually found things, used across the suite.
const DISCOVERY = {
  websiteDomain: "acme.example.com",
  business: {
    industry: "Retail",
    summary: "Acme sells ergonomic office chairs direct to consumers.",
    valueProp: "Chairs delivered in 48 hours with a 10-year warranty.",
    businessModel: "Direct to consumer e-commerce",
    products: [{ name: "Aeron X", description: "Mesh task chair" }, "Standing desk"],
    services: ["Assembly at home"],
    pricingModel: "Fixed retail pricing with seasonal sales",
    personas: ["Remote workers", "Small offices"],
  },
  brand: {
    voice: "Warm and direct",
    tone: "Friendly",
    forbiddenWords: ["cheap", "guys"],
    languages: ["en", "he"],
  },
  knowledge: {
    policies: {
      shipping: "Free delivery over 300 NIS, 2 business days.",
      returns: "30 days, unused, original packaging.",
      refunds: "Refunded to the original payment method within 14 days.",
    },
    faq: [{ question: "Do you ship to Eilat?", answer: "Yes, within 4 business days." }],
  },
  communication: {
    channels: [
      { type: "whatsapp", identifier: "+972500000000", purpose: "support" },
      { type: "email", identifier: "hello@acme.example.com" },
    ],
  },
};

const PROFILE = {
  organizationName: "Acme Chairs",
  industry: "Retail",
  businessDescription: "Ergonomic seating",
  country: "Israel",
};

describe("normalizeUrl - deterministic identity", () => {
  it("collapses casing, www, trailing slash, scheme and fragment", () => {
    const canonical = "acme.example.com/products";
    for (const variant of [
      "https://acme.example.com/products",
      "http://acme.example.com/products",
      "https://www.Acme.example.com/products/",
      "https://acme.example.com/products#reviews",
      "acme.example.com/products",
    ]) {
      expect(normalizeUrl(variant)).toBe(canonical);
    }
  });

  it("strips tracking parameters but keeps meaningful ones, sorted", () => {
    expect(normalizeUrl("https://a.com/p?utm_source=fb&id=12&gclid=x")).toBe("a.com/p?id=12");
    expect(normalizeUrl("https://a.com/p?b=2&a=1")).toBe(normalizeUrl("https://a.com/p?a=1&b=2"));
  });

  it("treats a different query value as a different page", () => {
    expect(normalizeUrl("https://a.com/p?id=12")).not.toBe(normalizeUrl("https://a.com/p?id=13"));
  });

  it("rejects unusable and non-http input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("checksum - stable across incidental re-crawl differences", () => {
  it("ignores whitespace, CRLF and trailing newlines", () => {
    expect(checksumOf("Hello   world\r\n\r\n\r\nBye  ")).toBe(checksumOf("Hello world\n\nBye"));
  });

  it("changes when the meaning changes", () => {
    expect(checksumOf("30 day returns")).not.toBe(checksumOf("14 day returns"));
  });

  it("normalizeContent collapses runs but preserves paragraph breaks", () => {
    expect(normalizeContent("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("dedupeKeyFor", () => {
  it("maps URL variants of one page to one key", () => {
    const a = dedupeKeyFor({ sourceType: "url", topic: "website_pages", sourceUrl: "https://WWW.a.com/x/" });
    const b = dedupeKeyFor({ sourceType: "url", topic: "website_pages", sourceUrl: "http://a.com/x?utm_source=z" });
    expect(a).toBe(b);
  });

  it("does not collapse two unusable URLs into one shared key", () => {
    const a = dedupeKeyFor({ sourceType: "url", topic: "website_pages", sourceUrl: "javascript:a" });
    const b = dedupeKeyFor({ sourceType: "url", topic: "website_pages", sourceUrl: "javascript:b" });
    expect(a).not.toBe(b);
  });

  it("keys topic entries on the topic and files on their id", () => {
    expect(dedupeKeyFor({ sourceType: "onboarding_scan", topic: "faq" })).toBe("onboarding_scan:faq");
    expect(dedupeKeyFor({ sourceType: "file", topic: "website_pages", externalId: "doc-9" })).toBe("file:doc-9");
  });
});

describe("projectDiscoveryTopics - topic-based, never one mega-document", () => {
  const entries = projectDiscoveryTopics(DISCOVERY, PROFILE, CTX);

  it("produces several distinct topics", () => {
    const topics = entries.map((e) => e.topic);
    expect(topics).toContain("business_overview");
    expect(topics).toContain("products_services");
    expect(topics).toContain("shipping_returns");
    expect(topics).toContain("brand_voice");
    expect(new Set(topics).size).toBe(topics.length);
    expect(entries.length).toBeGreaterThan(3);
  });

  it("writes retrievable prose, not a JSON dump", () => {
    const overview = entries.find((e) => e.topic === "business_overview")!;
    expect(overview.content).toContain("Acme Chairs");
    expect(overview.content).toContain("ergonomic office chairs");
    expect(overview.content).not.toContain('{"');
    expect(overview.content).not.toContain("valueProp");
  });

  it("carries full provenance metadata on every entry", () => {
    for (const e of entries) {
      expect(e.metadata.origin).toBe("onboarding");
      expect(e.metadata.createdDuringOnboarding).toBe(true);
      expect(e.metadata.scanVersion).toBe(SCAN_VERSION);
      expect(e.metadata.language).toBe("en");
      expect(e.metadata.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(e.metadata.lastRefreshedAt).toBe(CTX.now);
      expect(e.metadata.dedupeKey).toBeTruthy();
    }
  });

  it("never carries a tenant id into the document metadata", () => {
    expect(JSON.stringify(entries)).not.toMatch(/tenantId/i);
  });

  it("skips a domain the scan found nothing for, instead of writing 'undefined'", () => {
    const sparse = projectDiscoveryTopics(
      { websiteDomain: "x.com", business: { summary: "We do a thing that is quite long indeed." } },
      {},
      CTX,
    );
    const topics = sparse.map((e) => e.topic);
    expect(topics).not.toContain("shipping_returns");
    expect(topics).not.toContain("faq");
    expect(JSON.stringify(sparse)).not.toContain("undefined");
  });

  it("localizes titles for Hebrew tenants", () => {
    const he = projectDiscoveryTopics(DISCOVERY, PROFILE, { ...CTX, language: "he" });
    const overview = he.find((e) => e.topic === "business_overview")!;
    expect(overview.title).toBe("סקירת העסק");
    expect(overview.metadata.language).toBe("he");
  });

  it("is deterministic - the same input yields the same checksums", () => {
    const again = projectDiscoveryTopics(DISCOVERY, PROFILE, CTX);
    expect(again.map((e) => e.metadata.checksum)).toEqual(entries.map((e) => e.metadata.checksum));
  });
});

describe("projectReadinessAnswers / pages / external sources", () => {
  it("gives every readiness answer its own document", () => {
    const out = projectReadinessAnswers(
      [
        { question: "What are your opening hours?", answer: "Sun-Thu 9:00-17:00" },
        { question: "Do you offer gift wrapping?", answer: "Yes, 15 NIS" },
      ],
      CTX,
    );
    expect(out).toHaveLength(2);
    expect(new Set(out.map((e) => e.metadata.dedupeKey)).size).toBe(2);
    expect(out[0].content).toContain("Sun-Thu 9:00-17:00");
    expect(out[0].sourceType).toBe("readiness_answer");
  });

  it("drops blank answers rather than storing an empty entry", () => {
    expect(projectReadinessAnswers([{ question: "Q", answer: "   " }], CTX)).toHaveLength(0);
  });

  it("keeps each crawled page as its own source", () => {
    const out = projectPages(
      [
        { url: "https://a.com/shipping", title: "Shipping", content: "x".repeat(80) },
        { url: "https://a.com/tiny", content: "short" },
      ],
      CTX,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceUrl).toBe("https://a.com/shipping");
    expect(out[0].metadata.normalizedUrl).toBe("a.com/shipping");
  });

  it("keys uploaded files and Drive documents on their external id", () => {
    const out = projectExternalSources(
      [
        { externalId: "f1", title: "Returns.pdf", content: "Return policy text", sourceType: "file" },
        { externalId: "d1", title: "Runbook", content: "Ops runbook", sourceType: "drive" },
      ],
      CTX,
    );
    expect(out.map((e) => e.metadata.dedupeKey)).toEqual(["file:f1", "drive:d1"]);
  });
});

// ─── Reconciliation: the anti-duplication contract ──────────

function asExisting(entries: ProjectedEntry[], idPrefix = "doc"): ExistingDoc[] {
  return entries.map((e, i) => ({
    id: `${idPrefix}-${i}`,
    title: e.title,
    metadata: { ...e.metadata },
  }));
}

describe("reconcile - a re-scan updates, it does not duplicate", () => {
  const first = projectDiscoveryTopics(DISCOVERY, PROFILE, CTX);

  it("creates everything on a first scan", () => {
    const plan = reconcile(first, []);
    expect(plan.summary.added).toBe(first.length);
    expect(plan.summary.updated + plan.summary.removed).toBe(0);
  });

  it("reports an identical re-scan as entirely unchanged - zero writes", () => {
    const existing = asExisting(first);
    const plan = reconcile(projectDiscoveryTopics(DISCOVERY, PROFILE, CTX), existing);
    expect(plan.summary).toMatchObject({ added: 0, updated: 0, preserved: 0, removed: 0 });
    expect(plan.summary.unchanged).toBe(first.length);
  });

  it("stays stable over three consecutive scans - the count never grows", () => {
    let existing = asExisting(first);
    for (let i = 0; i < 3; i++) {
      const plan = reconcile(projectDiscoveryTopics(DISCOVERY, PROFILE, CTX), existing);
      expect(plan.summary.added).toBe(0);
      existing = asExisting(first);
    }
  });

  it("updates only the topic whose content actually changed", () => {
    const changed = {
      ...DISCOVERY,
      knowledge: { ...DISCOVERY.knowledge, policies: { ...DISCOVERY.knowledge.policies, returns: "14 days only." } },
    };
    const plan = reconcile(projectDiscoveryTopics(changed, PROFILE, CTX), asExisting(first));
    expect(plan.summary.added).toBe(0);
    expect(plan.summary.updated).toBe(1);
    const updated = plan.items.find((i) => i.action === "update")!;
    expect(updated.entry!.topic).toBe("shipping_returns");
    expect(updated.reason).toBe("content_changed");
  });

  it("never overwrites an entry a human edited", () => {
    const existing = asExisting(first).map((d) =>
      d.title.includes("Brand") || (d.metadata as any).topic === "brand_voice"
        ? { ...d, metadata: { ...(d.metadata as any), manualEdit: true, checksum: "stale" } }
        : d,
    );
    const plan = reconcile(first, existing);
    const preserved = plan.items.filter((i) => i.action === "preserved");
    expect(preserved).toHaveLength(1);
    expect(preserved[0].reason).toBe("manual_edit");
    expect(plan.items.some((i) => i.action === "update" && i.entry!.topic === "brand_voice")).toBe(false);
  });

  it("refreshes when the projection version moves even if content matched", () => {
    const stale = asExisting(first).map((d) => ({
      ...d,
      metadata: { ...(d.metadata as any), scanVersion: SCAN_VERSION - 1 },
    }));
    const plan = reconcile(first, stale);
    expect(plan.summary.updated).toBe(first.length);
    expect(plan.items.every((i) => i.reason === "scan_version")).toBe(true);
  });

  it("leaves manually added knowledge completely alone", () => {
    const manual: ExistingDoc[] = [
      { id: "manual-1", title: "Hand written note", metadata: null },
      { id: "manual-2", title: "Pasted policy", metadata: { some: "other" } },
    ];
    const plan = reconcile(first, [...asExisting(first), ...manual], { removeMissing: true });
    const touchedIds = plan.items.map((i) => i.existingId).filter(Boolean);
    expect(touchedIds).not.toContain("manual-1");
    expect(touchedIds).not.toContain("manual-2");
  });

  it("reports pages that vanished, but only within the requested scope", () => {
    const pages = projectPages(
      [
        { url: "https://a.com/one", content: "x".repeat(80) },
        { url: "https://a.com/two", content: "y".repeat(80) },
      ],
      CTX,
    );
    const existing = [...asExisting(first, "topic"), ...asExisting(pages, "page")];
    // Second crawl finds only /one, and produced no topic summaries at all.
    const plan = reconcile(pages.slice(0, 1), existing, {
      removeMissing: true,
      removeScope: ["url"],
    });
    expect(plan.summary.removed).toBe(1);
    const removed = plan.items.find((i) => i.action === "remove")!;
    expect(removed.existingId).toBe("page-1");
    expect(removed.reason).toBe("no_longer_found");
    // The topic summaries are out of scope, so a failed synthesis step cannot
    // wipe last week's good summaries.
    expect(plan.items.filter((i) => i.action === "remove")).toHaveLength(1);
  });

  it("does not remove anything unless asked to", () => {
    const plan = reconcile([], asExisting(first));
    expect(plan.summary.removed).toBe(0);
  });

  it("collapses historical duplicates under one key onto a single survivor", () => {
    const dup = asExisting(first);
    const plan = reconcile(first, [...dup, { ...dup[0], id: "dupe-of-0" }], {});
    const removals = plan.items.filter((i) => i.action === "remove");
    expect(removals).toHaveLength(1);
    expect(removals[0].existingId).toBe("dupe-of-0");
    expect(removals[0].reason).toBe("duplicate");
  });
});

describe("buildEntry", () => {
  it("round-trips content normalization into the checksum", () => {
    const a = buildEntry({ topic: "faq", title: "T", content: "a   b", sourceType: "onboarding_scan", language: "en", now: CTX.now });
    const b = buildEntry({ topic: "faq", title: "T", content: "a b", sourceType: "onboarding_scan", language: "en", now: CTX.now });
    expect(a.metadata.checksum).toBe(b.metadata.checksum);
    expect(a.content).toBe("a b");
  });
});
