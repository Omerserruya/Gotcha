/**
 * The stock root cause (urban widget, 2026-10-23; sandbox turn 2026-10-25):
 * woocommerce.get_product / list_products WERE on כריש's surface (the new
 * ai.bot_turn audit lists all 20 Woo tools, none dropped), yet the bot told the
 * customer "אין לי כאן גישה למלאי בזמן אמת" and called nothing. The capability
 * hints were keyed only `integration_<slug>`, never the adapter name the bot is
 * offered, so the prompt filed the store's reads under "Custom actions -
 * Tenant-defined custom actions", with no word about price or stock. Pinned:
 * the adapter name gets its system's category, and the store reads say they
 * read live price and stock.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", async () => {
  const effect = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-effect");
  return {
    classifyToolEffect: effect.classifyToolEffect,
    prisma: {
      agentToolPermission: {
        findMany: async () => [
          { tenantTool: { catalogTool: { slug: "get_product", integration: { slug: "woocommerce", category: "ECOMMERCE" } } } },
          { tenantTool: { catalogTool: { slug: "search_contacts", integration: { slug: "hubspot", category: "CRM" } } } },
        ],
      },
    },
  };
});

import { loadToolCapabilityHints } from "../services/plan-context.service";
import { groupToolsIntoCapabilities, renderCapabilities } from "../services/capabilities";
import { parseProposeReply } from "../services/openai.provider";

describe("★ the store's reads are the store's in the prompt", () => {
  it("hints carry the adapter name too, with its system's category", async () => {
    const h = await loadToolCapabilityHints("T", "emp1");
    expect(h["woocommerce.get_product"]).toBe("ECOMMERCE");
    expect(h["integration_get_product"]).toBe("ECOMMERCE"); // the old key still works
    expect(h["hubspot.search_contacts"]).toBe("CRM");
  });

  it("grouped under Store & orders with a live price-and-stock summary, not Custom actions", async () => {
    const h = await loadToolCapabilityHints("T", "emp1");
    const text = renderCapabilities(groupToolsIntoCapabilities(["woocommerce.get_product", "escalate_to_human"], h))!;
    expect(text).toContain("**Store & orders**");
    expect(text).toMatch(/`woocommerce\.get_product` - one product, live: price, stock status and quantity/);
    expect(text).not.toContain("Custom actions");
  });
});

describe("the side chat writes no wide dash", () => {
  it("message and draft", () => {
    expect(parseProposeReply(JSON.stringify({ message: "שלושה ניסוחים — בחרי", draft: "כן – יש" }))).toEqual({ text: "שלושה ניסוחים - בחרי", draft: "כן - יש" });
  });
});
