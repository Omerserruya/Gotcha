/**
 * Disconnecting Shopify must actually uninstall the app, and must not claim
 * success before Shopify confirms it.
 *
 * WHAT THIS REPLACES
 * "Disconnect Shopify" used to clear GOTCHA's own row and nothing else. The
 * app stayed installed with its scopes and went on delivering webhooks while
 * the merchant was told they had disconnected.
 *
 * Shopify supports an app uninstalling itself: the `appUninstall` Admin
 * GraphQL mutation (API 2026-07, which this app already targets). It takes no
 * arguments and uninstalls only the caller. Its 200 means "request accepted",
 * NOT "uninstalled", so the signed `app/uninstalled` webhook stays the
 * authority and these tests pin that distinction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const graphQL = vi.fn();
vi.mock("../services/connectors/shopify-graphql", () => ({
  shopifyGraphQLRequest: (...a: unknown[]) => graphQL(...a),
}));

const findFirst = vi.fn();
const update = vi.fn();
vi.mock("@chatcenter/shared", () => ({
  prisma: { tenantIntegration: { findFirst: (...a: unknown[]) => findFirst(...a), update: (...a: unknown[]) => update(...a) } },
  shopifyApiVersion: () => "2026-07",
  // Credentials are stored ENCRYPTED, as a string. The first version of this
  // service read `row.credentials.accessToken` off the raw column, which is
  // ciphertext, silently got undefined, and returned no_token for a healthy
  // connection. The fixtures below use the real storage shape so that cannot
  // pass again.
  decryptCredentials: (blob: string) => JSON.parse(Buffer.from(blob, "base64").toString("utf8")),
}));

/** Encrypt-shaped: a string, exactly as the column stores it. */
function sealed(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

import {
  requestShopifySelfUninstall,
  isAwaitingUninstall,
  UNINSTALL_REQUESTED_AT,
} from "../services/connectors/shopify-self-uninstall.service";

const CONNECTED_ROW = {
  id: "ti1",
  config: { shopDomain: "new-for-test.myshopify.com", useAsCrm: true },
  credentials: sealed({ accessToken: "offline-token" }),
};

beforeEach(() => {
  graphQL.mockReset(); findFirst.mockReset(); update.mockReset();
  graphQL.mockResolvedValue({ appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } });
  update.mockResolvedValue({});
});

describe("1. redirect started but uninstall not completed", () => {
  it("reports awaiting_webhook, never disconnected", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: true, state: "awaiting_webhook", shopDomain: "new-for-test.myshopify.com" });
  });

  it("records the intent WITHOUT disconnecting or clearing credentials", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    await requestShopifySelfUninstall("t1");
    const data = update.mock.calls[0][0].data;
    expect(data.config[UNINSTALL_REQUESTED_AT]).toBeTruthy();
    // The app is still installed until Shopify says otherwise. Touching any of
    // these here would strand the merchant half-disconnected if the webhook
    // never arrived.
    expect(data.status).toBeUndefined();
    expect(data.credentials).toBeUndefined();
  });

  it("a merchant who returns mid-flight is still connected, and we say so", () => {
    expect(isAwaitingUninstall({ [UNINSTALL_REQUESTED_AT]: "2026-09-30T00:00:00.000Z" })).toBe(true);
    expect(isAwaitingUninstall({})).toBe(false);
  });

  it("calls the official mutation, with no arguments, and never retries it", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    await requestShopifySelfUninstall("t1");
    const [ctx, query, vars, opts] = graphQL.mock.calls[0];
    expect(query).toMatch(/appUninstall/);
    expect(vars).toEqual({});
    // A retry against an app that is already gone is a 401, which would read
    // as failure for a request that actually succeeded.
    expect(opts.retryable).toBe(false);
    expect(ctx.base).toBe("https://new-for-test.myshopify.com/admin/api/2026-07");
  });
});

describe("2. Shopify refuses the request", () => {
  it("reports the failure and does NOT record a pending uninstall", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    graphQL.mockRejectedValue(new Error("appUninstall refused"));
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: false, reason: "shopify_refused" });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("3. nothing to uninstall", () => {
  it("a workspace with no connected Shopify is not_connected, and nothing is called", async () => {
    findFirst.mockResolvedValue(null);
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: false, reason: "not_connected" });
    expect(graphQL).not.toHaveBeenCalled();
  });

  it("a connection without a usable token cannot be uninstalled remotely", async () => {
    findFirst.mockResolvedValue({ ...CONNECTED_ROW, credentials: sealed({}) });
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: false, reason: "no_token" });
    expect(graphQL).not.toHaveBeenCalled();
  });
});

describe("4. only the caller's own app is uninstalled", () => {
  it("sends no shop or app argument that could target something else", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    await requestShopifySelfUninstall("t1");
    const [, query, vars] = graphQL.mock.calls[0];
    expect(vars).toEqual({});
    expect(query).not.toMatch(/\$shop|\$appId|\$id/);
  });

  it("authenticates with the store's own offline token", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    await requestShopifySelfUninstall("t1");
    expect(graphQL.mock.calls[0][0].token).toBe("offline-token");
  });
});

describe("5. the request is scoped to Shopify", () => {
  it("looks up only the Shopify integration, and only a live one", async () => {
    findFirst.mockResolvedValue(CONNECTED_ROW);
    await requestShopifySelfUninstall("t1");
    const where = findFirst.mock.calls[0][0].where;
    expect(where.integration).toEqual({ slug: "shopify" });
    expect(where.tenantId).toBe("t1");
    // An already-disconnected row has no token to call with.
    expect(where.status).toEqual({ in: ["CONNECTED", "ERROR"] });
  });
});


describe("6. credentials are encrypted at rest (the production 502)", () => {
  it("decrypts the column instead of reading fields off ciphertext", async () => {
    // This is the bug a merchant hit: a healthy CONNECTED store with a valid
    // token, refused as `no_token`, because `credentials` is a string and
    // `credentials.accessToken` on a string is undefined.
    findFirst.mockResolvedValue(CONNECTED_ROW);
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: true, state: "awaiting_webhook", shopDomain: "new-for-test.myshopify.com" });
    expect(graphQL.mock.calls[0][0].token).toBe("offline-token");
  });

  it("still accepts an already-decrypted object, for connections stored that way", async () => {
    findFirst.mockResolvedValue({ ...CONNECTED_ROW, credentials: { accessToken: "plain" } });
    const r = await requestShopifySelfUninstall("t1");
    expect(r.ok).toBe(true);
    expect(graphQL.mock.calls[0][0].token).toBe("plain");
  });

  it("undecryptable credentials refuse rather than throwing at the merchant", async () => {
    findFirst.mockResolvedValue({ ...CONNECTED_ROW, credentials: "not-valid-ciphertext" });
    const r = await requestShopifySelfUninstall("t1");
    expect(r).toEqual({ ok: false, reason: "no_token" });
    expect(graphQL).not.toHaveBeenCalled();
  });
});
