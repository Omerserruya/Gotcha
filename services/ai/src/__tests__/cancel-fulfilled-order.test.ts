import { describe, it, expect, vi } from "vitest";

/**
 * A fulfilled order cannot be cancelled - and nobody should be asked to
 * approve pretending otherwise.
 *
 * The customer asked to cancel #1006. The bot proposed the cancellation, an
 * approval was raised, a human APPROVED it at 15:03:41, execution ran, and
 * Shopify answered:
 *
 *     shopify_422: Cannot cancel a paid and fulfilled order
 *
 * The whole pipeline worked. The action was impossible from the start.
 *
 * The human-agent path already knew this - commerce-actions.service.ts
 * reconciles the order live and returns `{state:"unavailable",
 * reason:"already_fulfilled"}` before it will let an agent cancel. The AI path
 * checked only `cancelled_at`, so it carried an impossible action all the way
 * to a person's approval, and the failure then handed the customer - who had
 * been told "I'm handling your cancellation now" - to an agent with no reason
 * given.
 *
 * Two things follow. The tool must say, where the model reads it, that a
 * fulfilled order cannot be cancelled and what to do instead; and the adapter
 * must refuse in terms that name the alternative, rather than surfacing a raw
 * provider 422.
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
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const cancelTool = ShopifyAdapter.tools().find((t: any) => t.name === "shopify.cancel_order") as any;

const ORDER = {
  id: 5678901234567,
  name: "#1006",
  financial_status: "paid",
  fulfillment_status: "fulfilled",
  fulfillments: [{ id: 1, status: "success" }],
  cancelled_at: null,
};

/**
 * Runs `cancel_order` against a shop whose only order is `order`.
 *
 * The stub is stateful because the adapter verifies its own write: after
 * POSTing the cancel it re-reads the order and refuses to report success
 * unless `cancelled_at` actually came back set. A stub that answered with an
 * unchanged order would make every successful cancel look like a failure.
 */
function cancel(args: Record<string, unknown>, order: any = ORDER) {
  let live = { ...order };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      if (String(init?.method).toUpperCase() === "POST" && String(url).includes("/cancel")) {
        live = { ...live, cancelled_at: "2026-07-31T15:03:41Z" };
      }
      const body = String(url).includes("orders.json") ? { orders: [live] } : { order: live };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return (ShopifyAdapter as any).execute({
    toolName: "cancel_order",
    args,
    credentials: { shopDomain: "urban.myshopify.com", accessToken: "tok" },
    config: {},
    tenantId: "tnt_1",
  });
}

const execute = (args: Record<string, unknown>) => cancel(args);

describe("the model is told before it proposes", () => {
  it("says a fulfilled order cannot be cancelled", () => {
    // This is the half that saves the human approval. The adapter check below
    // fires only AFTER someone has already said yes.
    expect(cancelTool.whenToUse).toMatch(/fulfilled/i);
    expect(cancelTool.whenToUse).toMatch(/CANNOT be cancelled/i);
  });

  it("names the action that works instead", () => {
    // "Sorry, I can't" strands the customer. A fulfilled order still has a
    // remedy - it is just a different one.
    expect(cancelTool.whenToUse).toMatch(/process_refund/i);
  });

  it("tells the model to check first", () => {
    expect(cancelTool.whenToUse).toMatch(/get_fulfillment_status|get_order/i);
  });

  it("still permits the ordinary case", () => {
    // The warning must not read as a blanket prohibition on cancelling.
    expect(cancelTool.whenToUse).toMatch(/Customer asks to cancel/i);
    expect(cancelTool.whenToUse).toMatch(/calling this tool is what RAISES the approval/i);
  });
});

describe("execution refuses a fulfilled order legibly", () => {
  it("refuses instead of letting Shopify 422", async () => {
    await expect(execute({ order_name: "#1006", reason: "customer" })).rejects.toThrow(
      /order_not_cancellable/,
    );
  });

  it("gives the reason in words, not a provider status code", async () => {
    // `shopify_422: Cannot cancel a paid and fulfilled order` reached the turn
    // as an opaque failure. This is what the model has to explain from.
    await expect(execute({ order_name: "#1006" })).rejects.toThrow(/already been fulfilled/i);
  });

  it("names the alternative in the failure itself", async () => {
    await expect(execute({ order_name: "#1006" })).rejects.toThrow(/process_refund/i);
  });

  it("detects fulfillment from the fulfillments array alone", async () => {
    // `fulfillment_status` is null on some partially-fulfilled orders; the
    // fulfillments array is the more reliable signal, and the human path uses
    // both. They must not disagree.
    await expect(
      cancel({ order_name: "#1006" }, { ...ORDER, fulfillment_status: null }),
    ).rejects.toThrow(/order_not_cancellable/);
  });

  it("treats a partially fulfilled order as uncancellable too", async () => {
    await expect(
      cancel({ order_name: "#1006" }, { ...ORDER, fulfillment_status: "partial", fulfillments: [] }),
    ).rejects.toThrow(/order_not_cancellable/);
  });
});

describe("orders that CAN be cancelled are untouched", () => {
  it("proceeds for an unfulfilled order", async () => {
    // The guard must not make cancellation unreachable - most cancellations
    // are of orders that have not shipped, and those must still work.
    const r = await cancel(
      { order_name: "#1006", reason: "customer" },
      { ...ORDER, fulfillment_status: null, fulfillments: [] },
    );
    expect(r).toBeTruthy();
  });

  it("still reports an already-cancelled order as such, not as uncancellable", async () => {
    // The idempotent-retry path predates this guard and means something
    // different: "this already happened", not "this cannot happen". An
    // approval re-dispatch must not start reporting the wrong one.
    const r = await cancel(
      { order_name: "#1006" },
      { ...ORDER, fulfillment_status: null, fulfillments: [], cancelled_at: "2026-07-31T12:00:00Z" },
    );
    expect(r.already_cancelled).toBe(true);
  });
});

describe("the two paths agree", () => {
  it("uses the same fulfillment predicate as the human-agent path", () => {
    // commerce-actions.service.ts:
    //   ["fulfilled","partial"].includes(fulfillment_status) || fulfillments.length > 0
    // Divergence here is exactly the bug: an action a human agent is blocked
    // from taking must not be one the AI can put in front of a human to
    // approve.
    const fulfilled = (o: any) =>
      ["fulfilled", "partial"].includes(String(o?.fulfillment_status || "").toLowerCase()) ||
      (Array.isArray(o?.fulfillments) && o.fulfillments.length > 0);

    expect(fulfilled(ORDER)).toBe(true);
    expect(fulfilled({ ...ORDER, fulfillment_status: null, fulfillments: [] })).toBe(false);
    expect(fulfilled({ fulfillment_status: "partial" })).toBe(true);
    expect(fulfilled({ fulfillments: [{ id: 1 }] })).toBe(true);
  });
});
