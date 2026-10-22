/**
 * No wide dash in what the business scan shows (00e). The prompt asks for a
 * plain hyphen, and every string the report carries is cleaned on the way
 * out, at any depth - the dev scan stored "אתר מוגן בסיסמה — תוכן דפי החנות
 * חסום" in gaps and 00e showed it as is.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ calls: [] as any[], content: "" }));
vi.mock("../services/ai.service", () => ({
  getDefaultModel: () => "test-model",
  generateResponse: async (a: any) => { H.calls.push(a); return { content: H.content }; },
}));

import { discoverBusiness, withoutWideDashes } from "../services/business-discovery.service";

const WIDE = /[–—―]/;

describe("withoutWideDashes", () => {
  it("cleans every string at any depth, keeps keys and non-strings", () => {
    const out = withoutWideDashes({
      gaps: [{ label: "אתר מוגן בסיסמה — תוכן דפי החנות חסום", priority: 1, nested: { why: ["a – b", "c ― d"] } }],
      "key—kept": true,
      count: 3,
      none: null,
    });
    expect(out.gaps[0].label).toBe("אתר מוגן בסיסמה - תוכן דפי החנות חסום");
    expect(out.gaps[0].nested.why).toEqual(["a - b", "c - d"]);
    expect(out.gaps[0].priority).toBe(1);
    expect(Object.keys(out)).toContain("key—kept");
    expect(out.count).toBe(3);
    expect(out.none).toBeNull();
  });
});

describe("★ discoverBusiness output", () => {
  it("asks for a plain hyphen, and returns no wide dash in any field even when the model writes one", async () => {
    H.content = JSON.stringify({
      brand: { voice: "Warm — direct", tagline: "Fast – friendly" },
      business: { name: "Acme", summary: "We sell coats — in Tel Aviv", industry: "retail" },
      knowledge: { policies: [{ name: "Returns", summary: "14 days – unworn", confidence: "likely" }] },
      gaps: [{ label: "אתר מוגן בסיסמה — תוכן דפי החנות חסום", reason: "login wall ― nothing to read" }],
      recommendation: { employeeRole: "customer_support", reason: "Orders — returns — sizing" },
      report: "Short report — with dashes – everywhere",
      channels: [],
    });
    const out = await discoverBusiness({ tenantId: "t1", domain: "https://acme.com", locale: "he", pages: [{ url: "https://acme.com", text: "x" }], signals: {} } as any);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toMatch(WIDE);
    expect(JSON.stringify(out)).toContain("אתר מוגן בסיסמה - תוכן דפי החנות חסום");
    const system = H.calls[0].messages.find((m: any) => m.role === "system").content;
    expect(system).toMatch(/never write the em-dash \(U\+2014\), the en-dash \(U\+2013\) or the horizontal bar \(U\+2015\)/);
  });
});
