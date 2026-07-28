/**
 * The setup page's last line of defence against a half-written scan.
 *
 * `/setup` crashed on `tech.legacy.length` for a newly created tenant: the
 * mid-scan checkpoint persists `{ platform, tools }`, the type claimed all
 * four collections were arrays, and the render guard short-circuited on
 * `platform` so the partial object sailed past it.
 *
 * The server normalizes the record now. These cover the client-side guard
 * anyway, because the failure mode is a blank page in the middle of
 * onboarding and the page is far too large to render in a unit test - which
 * is precisely why the guard used to live inline and go unverified.
 */
import { describe, it, expect } from "vitest";
import { techList, renderableTech } from "../discovery-shape";

const ITEM = { slug: "klaviyo", name: "Klaviyo" };

describe("techList", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("returns an array when the collection is %s", (_label, value) => {
    expect(techList(value)).toEqual([]);
  });

  it("returns an empty array unchanged", () => {
    expect(techList([])).toEqual([]);
  });

  it("passes a populated collection straight through", () => {
    const items = [ITEM];
    expect(techList(items)).toBe(items);
  });

  it("refuses a value that is not an array at all", () => {
    // The column is Json: a string or an object can genuinely be in there.
    for (const bogus of ["klaviyo", 7, { slug: "x" }, true] as never[]) {
      expect(techList(bogus)).toEqual([]);
    }
  });
});

describe("renderableTech", () => {
  it("keeps entries that have something to display", () => {
    expect(renderableTech([ITEM])).toEqual([ITEM]);
  });

  it("keeps an entry with no slug, because only the icon is lost", () => {
    const noSlug = { slug: "", name: "Some CRM" };
    expect(renderableTech([noSlug])).toEqual([noSlug]);
  });

  it("drops entries that would render as an empty chip", () => {
    // A blank chip reads as a bug to someone looking at "what we found on
    // your site". Substituting a placeholder would be worse: it would show
    // a technology the scan never detected.
    const items = [ITEM, { slug: "x", name: "" }, { slug: "y", name: "   " }, null, undefined, "wordpress", 42];
    expect(renderableTech(items as never)).toEqual([ITEM]);
  });

  it("survives a collection that is missing entirely", () => {
    expect(renderableTech(undefined)).toEqual([]);
    expect(renderableTech(null)).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const items = [ITEM, { slug: "x", name: "" }];
    const copy = JSON.parse(JSON.stringify(items));
    renderableTech(items as never);
    expect(items).toEqual(copy);
  });
});

describe("the exact record that crashed the page", () => {
  it("yields empty collections for the mid-scan checkpoint shape", () => {
    // { platform, tools } and nothing else - what the deterministic
    // checkpoint wrote, and what survives a failed LLM synthesis.
    const tech = {
      platform: { slug: "shopify", name: "Shopify", confidence: "confirmed" },
      tools: [ITEM],
    } as { platform: unknown; tools: typeof ITEM[]; legacy?: typeof ITEM[]; tracking?: typeof ITEM[] };

    expect(renderableTech(tech.legacy)).toEqual([]);
    expect(renderableTech(tech.tracking)).toEqual([]);
    expect(renderableTech(tech.tools)).toEqual([ITEM]);

    // The guard the page renders on: platform alone is enough to show the
    // block, and reading the other collections must not throw.
    const hasTech =
      !!tech.platform ||
      renderableTech(tech.tools).length > 0 ||
      renderableTech(tech.legacy).length > 0 ||
      renderableTech(tech.tracking).length > 0;
    expect(hasTech).toBe(true);
  });

  it("shows nothing rather than an empty block when a scan found no technology", () => {
    const tech = { platform: null, tools: [], legacy: [], tracking: [] };
    const hasTech =
      !!tech.platform ||
      renderableTech(tech.tools).length > 0 ||
      renderableTech(tech.legacy).length > 0 ||
      renderableTech(tech.tracking).length > 0;
    expect(hasTech).toBe(false);
  });
});

/**
 * The states a scan can actually be in, end to end.
 *
 * `legacy` was the field that crashed the page, but it crashed because the
 * mid-scan checkpoint writes a PARTIAL object - so the interesting cases are
 * the shapes a real scan passes through, not one field in isolation.
 */
describe("every state a scan passes through", () => {
  const cases: Array<[string, unknown]> = [
    // Nothing has run yet.
    ["not started", undefined],
    ["null column", null],
    // The mid-scan checkpoint: the exact shape that took the page down.
    ["mid-scan checkpoint", { platform: { slug: "shopify", name: "Shopify" }, tools: [] }],
    // A scan that ran and found nothing is a legitimate, complete result.
    ["completed, found nothing", { platform: null, legacy: [], tracking: [], tools: [] }],
    // A scan that failed leaves whatever the writer managed before it threw.
    ["failed scan", { platform: null }],
    ["failed scan, error marker", { error: "scan_failed" }],
    // Json columns accept anything; these have all been seen in the wild.
    ["malformed - string", "shopify"],
    ["malformed - array", [{ name: "Shopify" }]],
    ["malformed - collection is an object", { legacy: { name: "nope" }, tools: [] }],
    ["malformed - collection is a string", { legacy: "klaviyo", tools: [] }],
    ["malformed - entries are primitives", { legacy: ["klaviyo", 42, null], tools: [] }],
  ];

  it.each(cases)("renders %s without throwing", (_label, technology) => {
    const tech = technology as any;
    // Exactly what the page does for each of the four fields.
    expect(() => {
      for (const key of ["legacy", "tracking", "tools"]) {
        const list = renderableTech(tech?.[key]);
        expect(Array.isArray(list)).toBe(true);
        list.map((t) => t.name.trim());
      }
    }).not.toThrow();
  });

  it.each(cases)("reports a length for %s, which is what the page reads", (_label, technology) => {
    const tech = technology as any;
    // `tech.legacy.length` is the expression that threw. It must be safe for
    // every one of these, which is the whole point of routing through the guard.
    expect(typeof techList(tech?.legacy).length).toBe("number");
    expect(typeof techList(tech?.tracking).length).toBe("number");
    expect(typeof techList(tech?.tools).length).toBe("number");
  });
});
