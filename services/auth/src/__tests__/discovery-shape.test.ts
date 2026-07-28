/**
 * The discovery record's shape contract.
 *
 * `BusinessDiscovery.technology` is a Json column with several writers. One
 * of them - the mid-scan checkpoint that doubles as the fallback when LLM
 * synthesis fails - persisted only `platform` and `tools`, while every
 * consumer's type insisted all four collections were arrays. The setup page
 * read `tech.legacy.length` and a brand-new tenant got a blank screen with
 * a TypeError instead of onboarding.
 *
 * These lock the guarantee at the boundary: whatever is in the column, a
 * reader gets all four fields, with the collections as arrays.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeDiscoveryTechnology,
  normalizeDiscoveryCommunication,
  normalizeDiscoveryRecord,
} from "@chatcenter/shared";

describe("technology shape", () => {
  it("fills every collection when the column has only what the checkpoint wrote", () => {
    // The exact row that caused the crash.
    const tech = normalizeDiscoveryTechnology({
      platform: { slug: "shopify", name: "Shopify", confidence: "confirmed" },
      tools: [{ slug: "klaviyo", name: "Klaviyo" }],
    });

    expect(tech.legacy).toEqual([]);
    expect(tech.tracking).toEqual([]);
    expect(tech.tools).toHaveLength(1);
    expect(tech.platform).toMatchObject({ slug: "shopify", name: "Shopify" });
  });

  it.each([
    ["omitted", {}],
    ["explicitly undefined", { legacy: undefined, tracking: undefined, tools: undefined }],
    ["explicitly null", { legacy: null, tracking: null, tools: null }],
    ["already empty", { legacy: [], tracking: [], tools: [] }],
    ["not an array", { legacy: "wordpress", tracking: 7, tools: { slug: "x" } }],
  ])("returns arrays when the collections are %s", (_label, raw) => {
    const tech = normalizeDiscoveryTechnology(raw);
    expect(Array.isArray(tech.legacy)).toBe(true);
    expect(Array.isArray(tech.tracking)).toBe(true);
    expect(Array.isArray(tech.tools)).toBe(true);
  });

  it("survives a technology value that is not an object at all", () => {
    for (const raw of [null, undefined, "shopify", 42, []]) {
      const tech = normalizeDiscoveryTechnology(raw);
      expect(tech.platform).toBeNull();
      expect(tech.legacy).toEqual([]);
    }
  });

  it("keeps entries that can be rendered and drops the ones that cannot", () => {
    // Dropping is deliberate: a row with no name renders as an empty chip,
    // and inventing a placeholder would show a technology the scan never
    // found.
    const tech = normalizeDiscoveryTechnology({
      tools: [
        { slug: "klaviyo", name: "Klaviyo" },
        { slug: "no-name" },
        { name: "Named but unslugged" },
        null,
        "wordpress",
        { slug: "", name: "" },
      ],
    });

    // `{ slug: "no-name" }` survives: the slug stands in as the label, which
    // is still a real detection. null, a bare string, and a fully blank
    // entry are not.
    expect(tech.tools.map((t) => t.name)).toEqual(["Klaviyo", "no-name", "Named but unslugged"]);
  });

  it("keeps a named entry with no slug, because only the icon is lost", () => {
    const tech = normalizeDiscoveryTechnology({ tools: [{ name: "Some CRM" }] });
    expect(tech.tools).toEqual([{ slug: "", name: "Some CRM" }]);
  });

  it("drops a platform with no slug, because that card needs an icon and a name", () => {
    expect(normalizeDiscoveryTechnology({ platform: { name: "Mystery" } }).platform).toBeNull();
    expect(normalizeDiscoveryTechnology({ platform: { slug: "shopify" } }).platform).toMatchObject({
      slug: "shopify",
      name: "shopify",
    });
  });

  it("refuses a slug that could not be part of an icon URL", () => {
    // The slug is interpolated into a CDN URL by the renderer.
    const tech = normalizeDiscoveryTechnology({
      tools: [{ slug: "../../etc/passwd", name: "Traversal" }, { slug: "a b", name: "Spaced" }],
    });
    expect(tech.tools.map((t) => t.slug)).toEqual(["", ""]);
    expect(tech.tools.map((t) => t.name)).toEqual(["Traversal", "Spaced"]);
  });

  it("strips markup out of names, which are assembled from a third party's own pages", () => {
    const tech = normalizeDiscoveryTechnology({
      tools: [{ slug: "x", name: "<img src=x onerror=alert(1)>Klaviyo" }],
    });
    expect(tech.tools[0].name).not.toContain("<");
    expect(tech.tools[0].name).not.toContain(">");
  });

  it("collapses the same tool detected twice", () => {
    const tech = normalizeDiscoveryTechnology({
      tools: [
        { slug: "klaviyo", name: "Klaviyo" },
        { slug: "klaviyo", name: "Klaviyo" },
      ],
    });
    expect(tech.tools).toHaveLength(1);
  });
});

describe("communication shape", () => {
  it("always yields a channels array", () => {
    for (const raw of [undefined, null, {}, { channels: null }, { channels: "email" }, "nope"]) {
      expect(normalizeDiscoveryCommunication(raw).channels).toEqual([]);
    }
  });

  it("drops a channel with no type and keeps a usable one", () => {
    const comm = normalizeDiscoveryCommunication({
      channels: [{ type: "whatsapp", identifier: "+972500000000", confidence: "confirmed" }, { identifier: "orphan" }, null],
    });
    expect(comm.channels).toHaveLength(1);
    expect(comm.channels[0]).toMatchObject({ type: "whatsapp", confidence: "confirmed" });
  });
});

describe("whole-record normalization", () => {
  it("guarantees both collections without touching anything else", () => {
    const record = normalizeDiscoveryRecord({
      id: "d1",
      tenantId: "t1",
      status: "FAILED",
      websiteDomain: "https://example.com",
      technology: { platform: null, tools: [{ slug: "klaviyo", name: "Klaviyo" }] },
      communication: undefined,
      // Everything below is out of scope for this normalizer and must survive.
      brand: { voice: "warm" },
      gaps: [{ id: "g1" }],
    } as Record<string, unknown>) as Record<string, any>;

    expect(record.technology.legacy).toEqual([]);
    expect(record.technology.tracking).toEqual([]);
    expect(record.communication.channels).toEqual([]);
    expect(record.brand).toEqual({ voice: "warm" });
    expect(record.gaps).toEqual([{ id: "g1" }]);
    expect(record.status).toBe("FAILED");
    expect(record.websiteDomain).toBe("https://example.com");
  });

  it("passes a null record straight through", () => {
    // "No scan yet" is a real state and must not become an empty object that
    // the client mistakes for a completed, empty scan.
    expect(normalizeDiscoveryRecord(null)).toBeNull();
    expect(normalizeDiscoveryRecord(undefined)).toBeUndefined();
  });
});
