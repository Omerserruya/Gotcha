/**
 * App Review 132211 (2026-11-22): a store chat retired with its store (uninstalled or replaced, its
 * channel DISCONNECTED) no longer feeds the website widget: not its settings, not its places. The old
 * store's widget data was what the reviewer still saw after the new store failed to attach.
 */
import { describe, it, expect, vi } from "vitest";

const CH = vi.hoisted(() => ({
  rows: [
    { id: "old", tenantId: "T", connectionStatus: "DISCONNECTED", config: { shopDomain: "app-review-old.myshopify.com", ux: { look: "old-look" } } },
    { id: "new", tenantId: "T", connectionStatus: "CONNECTED", config: { shopDomain: "random-randomizer.myshopify.com" } },
  ] as any[],
}));

vi.mock("../services/shopify-live-chat.service", () => ({ listChannels: async () => CH.rows, saveChannelConfig: async () => undefined }));
vi.mock("../services/shopify-chat-install.service", () => ({ activationSnapshot: async () => null, provisionStoreChat: async () => undefined }));
vi.mock("../services/connectors/integration-framework", () => ({ loadConnection: async () => null }));
vi.mock("../services/widget-assignment.service", () => ({ answeringEmployee: async () => ({ employee: null, automation: null }) }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    channelAccount: { findFirst: async () => null, findMany: async () => [] },
    whatsAppNumber: { findMany: async () => [] },
    messageTemplate: { findMany: async () => [] },
    tenant: { findUnique: async () => null },
  },
  readDurableSetting: async () => null,
}));

import { getWidget } from "../services/website-widget.service";

describe("a retired store chat is out of the widget", () => {
  it("★ places list only the live store; the settings are not read from the old one", async () => {
    const w: any = await getWidget("T");
    expect(w.places.shopify).toEqual([{ channelId: "new", shopDomain: "random-randomizer.myshopify.com" }]);
    expect(JSON.stringify(w.settings)).not.toContain("old-look");
  });
});
