import { describe, it, expect, vi } from "vitest";

/**
 * A destructive order action must name the order it acts on.
 *
 * On 2026-07-31 the model called `shopify.cancel_order` with `{}`. Nothing
 * stopped it: `cancel_order` passed `undefined` for `required`, so the schema
 * handed to the model said every parameter was optional - including the one
 * identifying WHICH order to cancel.
 *
 * The gate then did its job, saw a HIGH-risk tool, and raised an approval. A
 * human approved `shopify.cancel_order()` at 14:22:53. Execution failed with
 * `order_id_or_name_required`, `execution_state` went to FAILED, and the
 * customer - who had been told "I'm handling your cancellation now" - waited,
 * asked "נו?", asked "מה קורה?", and got nothing until an agent took over.
 *
 * `required` alone cannot say "one of these two", which is why the constraint
 * was missing rather than wrong. `anyOf` says it - and OpenAI rejects anyOf at
 * the top level of a function's parameters, so shipping that 400'd every
 * request and left the model with no tools at all. The requirement therefore
 * lives in the description the model reads, and is ENFORCED at dispatch.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const tools = ShopifyAdapter.tools();
const byName = (slug: string) => tools.find((t: any) => t.name === `shopify.${slug}`);

/** The tools that change or end an order - a missing target is dangerous. */
const DESTRUCTIVE = [
  "cancel_order",
  "edit_order",
  "send_invoice",
  "resend_confirmation",
  "process_refund",
  "update_order_fulfillment",
];

describe("destructive order tools demand a target", () => {
  it.each(DESTRUCTIVE)("%s states the identifier requirement in prose", (slug) => {
    // NOT via `anyOf`. OpenAI rejects anyOf/oneOf/allOf at the top level of a
    // function's parameters - shipping it 400'd every request for this tenant,
    // which left the model with no tools at all. `required` cannot express
    // "one of these two" either, so the requirement is stated where the model
    // will actually read it and enforced at dispatch.
    const def: any = byName(slug);
    expect(def, `${slug} is missing from the adapter`).toBeTruthy();
    expect(def.description).toMatch(/REQUIRED: supply either order_id or order_name/i);
    expect(def.parameters.properties.order_id.description).toMatch(/REQUIRED/i);
    expect(def.parameters.properties.order_name.description).toMatch(/REQUIRED/i);
  });

  it.each(DESTRUCTIVE)("%s still exposes BOTH identifier properties", (slug) => {
    // The constraint must not be satisfiable only by the field the model
    // cannot know. A customer says "#1006"; that is `order_name`.
    const props: any = (byName(slug) as any).parameters?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["order_id", "order_name"]));
  });

  it("cancel_order specifically - the call that failed", () => {
    const def: any = byName("cancel_order");
    expect(def.riskLevel).toBe("HIGH");
    expect(def.description).toMatch(/REQUIRED: supply either order_id or order_name/i);
    // The enforcement lives at dispatch (see approval-needs-arguments.test.ts):
    // an argument-less call never reaches a human as an approval.
  });
});

describe("read-only order tools are left alone", () => {
  it("does not impose the constraint where it would only get in the way", () => {
    // `search_orders` legitimately takes no order identifier - it is how you
    // FIND one. Over-applying the rule would break the path a customer without
    // an order number depends on.
    const search: any = byName("search_orders");
    expect(search?.description ?? "").not.toMatch(/REQUIRED: supply either order_id/i);
  });

  it("get_order keeps working with either identifier and no anyOf burden", () => {
    const def: any = byName("get_order");
    const props = def.parameters.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["order_id", "order_name"]));
  });
});
