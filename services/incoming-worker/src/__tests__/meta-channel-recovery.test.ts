import { describe, it, expect, vi, beforeEach } from "vitest";

// A Meta channel breaks for reasons the owner fixes at Meta, not here: a page
// grant revoked in Business Settings, an app permission removed, an admin role
// lost. These tests pin the two halves of that: ERROR rows must still be
// probed, and a passing probe must clear the error.

// The worker reads META_APP_* into module-level consts at import time, and
// vitest hoists imports above plain statements - so these must be set in a
// hoisted block or the worker loads with empty credentials and skips.
vi.hoisted(() => {
  process.env.META_APP_ID = "app-1";
  process.env.META_APP_SECRET = "secret-1";
});

const findMany = vi.fn();
const update = vi.fn().mockResolvedValue({});

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: { channelAccount: { findMany: (...a: unknown[]) => findMany(...a), update: (...a: unknown[]) => update(...a) } },
  createWorker: vi.fn(),
  channelHealthQueue: { add: vi.fn() },
  decryptCredentials: (x: unknown) => x,
  encryptCredentials: (x: unknown) => x,
}));

vi.mock("axios", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import axios from "axios";
import { runHealthCheck } from "../workers/channel-health.worker";

beforeEach(() => {
  findMany.mockReset();
  update.mockReset().mockResolvedValue({});
  (axios.get as any).mockReset();
});

describe("Meta channel health recovery", () => {
  it("probes ERROR channels, not only CONNECTED ones", async () => {
    findMany.mockResolvedValue([]);
    await runHealthCheck();

    const where = findMany.mock.calls[0][0].where;
    expect(where.connectionStatus).toEqual({ in: ["CONNECTED", "ERROR"] });
    // A channel a person deliberately turned off must not be resurrected.
    expect(where.connectionStatus.in).not.toContain("DISCONNECTED");
  });

  it("clears the error when a previously-broken page token passes debug_token", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", channel: "MESSENGER", externalId: "page-1", connectionStatus: "ERROR", credentials: { accessToken: "EAAW-fixed" } },
    ]);
    (axios.get as any).mockResolvedValue({ data: { data: { is_valid: true } } });

    await runHealthCheck();

    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data;
    expect(data.connectionStatus).toBe("CONNECTED");
    expect(data.lastError).toBeNull();
  });

  it("clears the error when a previously-broken Instagram-Login token passes /me", async () => {
    findMany.mockResolvedValue([
      { id: "ch-2", channel: "INSTAGRAM", externalId: "ig-1", connectionStatus: "ERROR", credentials: { accessToken: "IGAA-fixed", igLogin: true } },
    ]);
    (axios.get as any).mockResolvedValue({ data: { user_id: "ig-1" } });

    await runHealthCheck();

    const data = update.mock.calls[0][0].data;
    expect(data.connectionStatus).toBe("CONNECTED");
    expect(data.lastError).toBeNull();
    // graph.instagram.com, never graph.facebook.com - an IG-user token cannot
    // be parsed by Facebook's host.
    expect((axios.get as any).mock.calls[0][0]).toContain("graph.instagram.com");
  });

  it("keeps a still-broken channel in ERROR with the reason from Meta", async () => {
    findMany.mockResolvedValue([
      { id: "ch-3", channel: "MESSENGER", externalId: "page-1", connectionStatus: "ERROR", credentials: { accessToken: "EAAW-dead" } },
    ]);
    (axios.get as any).mockResolvedValue({
      data: { data: { is_valid: false, error: { message: "pages_read_engagement must be granted" } } },
    });

    await runHealthCheck();

    const data = update.mock.calls[0][0].data;
    expect(data.connectionStatus).toBe("ERROR");
    expect(data.lastError).toContain("pages_read_engagement");
  });
});
