import { describe, it, expect, vi } from "vitest";

/**
 * Every tool schema must be one OpenAI will accept.
 *
 * An invalid schema is not a degraded tool - it fails the WHOLE request:
 *
 *   400 Invalid schema for function 'shopify__cancel_order': schema must have
 *   type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not'
 *   at the top level
 *
 * The model then receives no tools whatsoever and can only apologise or hand
 * the customer to a human. I caused exactly this by adding a perfectly valid
 * piece of JSON Schema (`anyOf`, to express "order_id OR order_name") that
 * OpenAI happens to forbid, and it broke every turn for a live tenant.
 *
 * Nothing else catches it: it type-checks, it is legal JSON Schema, and every
 * test that stubs the OpenAI client passes. So it is checked here, against the
 * documented constraints, for every registered adapter.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (l?: string) => l || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
  safeFetch: async () => ({ ok: false }),
}));

import "../services/connectors";
import { listAdapters } from "../services/connectors/integration-framework";

/** Composition keywords OpenAI rejects at the top level of `parameters`. */
const FORBIDDEN_TOP_LEVEL = ["oneOf", "anyOf", "allOf", "enum", "const", "not"];

interface Entry { adapter: string; tool: string; params: any }

function allTools(): Entry[] {
  const out: Entry[] = [];
  for (const a of listAdapters()) {
    let defs: any[] = [];
    try { defs = a.tools?.() ?? []; } catch { defs = []; }
    for (const d of defs) out.push({ adapter: a.slug, tool: d.name, params: d.parameters });
  }
  return out;
}

const TOOLS = allTools();

describe("adapter tool schemas are valid for OpenAI function calling", () => {
  it("there are tools to check", () => {
    expect(TOOLS.length).toBeGreaterThan(20);
  });

  it("no schema uses a forbidden keyword at the top level", () => {
    const bad = TOOLS.filter((e) =>
      FORBIDDEN_TOP_LEVEL.some((k) => e.params && Object.prototype.hasOwnProperty.call(e.params, k)),
    ).map((e) => {
      const keys = FORBIDDEN_TOP_LEVEL.filter((k) => Object.prototype.hasOwnProperty.call(e.params, k));
      return `${e.tool} (${keys.join(", ")})`;
    });
    expect(
      bad,
      "OpenAI rejects these outright, and a rejected request means the model " +
        "gets NO tools at all - not just these:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  it("every schema declares type: object", () => {
    const bad = TOOLS.filter((e) => e.params?.type !== "object").map((e) => `${e.tool} (type=${e.params?.type})`);
    expect(bad).toEqual([]);
  });

  it("every schema has a properties object", () => {
    const bad = TOOLS.filter((e) => typeof e.params?.properties !== "object" || e.params.properties === null)
      .map((e) => e.tool);
    expect(bad).toEqual([]);
  });

  it("`required` only ever names properties that exist", () => {
    // A required key with no matching property is rejected too, and is an easy
    // thing to leave behind when a parameter is renamed.
    const bad: string[] = [];
    for (const e of TOOLS) {
      const req: string[] = Array.isArray(e.params?.required) ? e.params.required : [];
      const props = Object.keys(e.params?.properties ?? {});
      for (const r of req) if (!props.includes(r)) bad.push(`${e.tool}: required "${r}" is not a property`);
    }
    expect(bad).toEqual([]);
  });

  it("tool names fit OpenAI's pattern", () => {
    // Dotted names are transformed to `shopify__cancel_order` upstream; the
    // raw name must still be made of safe characters.
    const bad = TOOLS.filter((e) => !/^[A-Za-z0-9_.-]{1,64}$/.test(e.tool)).map((e) => e.tool);
    expect(bad).toEqual([]);
  });
});
