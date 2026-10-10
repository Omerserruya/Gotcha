/**
 * ★ The channel check asks whether messages can still ARRIVE, not only
 * whether the token is valid (2026-10-09: Messenger, Gmail and Outlook could
 * show CONNECTED while nothing came in).
 *   - Messenger: GET /{page}/subscribed_apps; our app missing -> SUBSCRIBE_FAILED,
 *     still CONNECTED; present -> clears only SUBSCRIBE_FAILED
 *   - Gmail: watch renewal failing, or no topic -> WATCH_FAILED; success clears it
 *   - Outlook: PATCH the Graph subscription when it has under 24h left (or no
 *     expiry); 404/failure/missing -> OUTLOOK_SUBSCRIPTION_FAILED; never created
 *   - rows that are not CONNECTED (or ERROR where the pass allows it) and
 *     active are never touched
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => {
  process.env.META_APP_ID = "app_ours";
  process.env.META_APP_SECRET = "secret";
  return {
    rows: [] as any[],
    updates: [] as any[],
    calls: [] as Array<{ method: string; url: string; body?: any; opts?: any }>,
    subscribedApps: [] as any[] | Error,
    debugValid: true,
    watchFails: null as null | Error,
    patch: null as null | { status: number } | { data: any },
  };
});

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status, data: { error: { message } } } });

vi.mock("axios", () => ({
  default: {
    get: async (url: string, opts: any) => {
      H.calls.push({ method: "get", url, opts });
      if (url.endsWith("/debug_token")) return { data: { data: { is_valid: H.debugValid, expires_at: 0, error: { message: "bad token" } } } };
      if (url.endsWith("/subscribed_apps")) {
        if (H.subscribedApps instanceof Error) throw H.subscribedApps;
        return { data: { data: H.subscribedApps } };
      }
      if (url === "https://graph.microsoft.com/v1.0/me") return { data: { id: "me" } };
      return { data: {} };
    },
    post: async (url: string, body: any, opts: any) => {
      H.calls.push({ method: "post", url, body, opts });
      if (url === "https://oauth2.googleapis.com/token") return { data: { access_token: "g_fresh" } };
      if (url.includes("login.microsoftonline.com")) return { data: { access_token: "ms_fresh", expires_in: 3600 } };
      if (url.endsWith("/users/me/watch")) {
        if (H.watchFails) throw H.watchFails;
        return { data: { historyId: "9", expiration: "1760000000000" } };
      }
      return { data: {} };
    },
    patch: async (url: string, body: any, opts: any) => {
      H.calls.push({ method: "patch", url, body, opts });
      if (H.patch && "status" in H.patch) throw httpError(H.patch.status, H.patch.status === 404 ? "ResourceNotFound" : "Server busy");
      return H.patch && "data" in H.patch ? H.patch : { data: { expirationDateTime: body.expirationDateTime } };
    },
  },
}));

// A prisma double that honours `where`: findMany filters like the real query,
// update hits only the row whose id matches (and throws on none, like Prisma).
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && Array.isArray(v.in) ? v.in.includes(row[k]) : row[k] === v);
}
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    decryptCredentials: () => { throw new Error("not encrypted in this test"); },
    encryptCredentials: (x: unknown) => x,
    prisma: {
      channelAccount: {
        findMany: async ({ where }: any) => H.rows.filter((r) => matches(r, where)),
        update: async ({ where, data }: any) => {
          const row = H.rows.find((r) => r.id === where.id);
          if (!row) throw new Error(`no row ${where.id}`);
          H.updates.push({ where, data });
          Object.assign(row, data);
          return row;
        },
      },
    },
  };
});

import { runHealthCheck, runGmailWatchRenewal, runOutlookHealth } from "../workers/channel-health.worker";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const base = { tenantId: "T", isActive: true, connectionStatus: "CONNECTED", lastError: null };
const messenger = (o: any = {}) => ({ ...base, id: "ca_m", channel: "MESSENGER", externalId: "page_1", credentials: { accessToken: "tok_page", pageId: "page_1" }, platformMeta: null, ...o });
const gmail = (o: any = {}) => ({ ...base, id: "ca_g", channel: "GMAIL", externalId: "a@x.com", credentials: { accessToken: "old", refreshToken: "rt", clientId: "c", clientSecret: "s" }, platformMeta: { lastHistoryId: "5" }, ...o });
const outlook = (o: any = {}) => ({ ...base, id: "ca_o", channel: "OUTLOOK", externalId: "b@x.com", credentials: { accessToken: "old", refreshToken: "rt", clientId: "c", clientSecret: "s", tenantIdAzure: "tz" }, platformMeta: { subscriptionId: "sub_1", clientState: "cs_1", subscriptionExpiresAt: new Date(NOW + 2 * HOUR).toISOString() }, ...o });

const updatesFor = (id: string) => H.updates.filter((u) => u.where.id === id);
const callsTo = (fragment: string) => H.calls.filter((c) => c.url.includes(fragment));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/gmail-dev";
  Object.assign(H, { rows: [], updates: [], calls: [], subscribedApps: [{ id: "app_ours", name: "GOTCHA" }], debugValid: true, watchFails: null, patch: null });
});
afterEach(() => { vi.useRealTimers(); });

describe("★ Messenger: the Page must still list our app", () => {
  it("listed: read with the Page's own token, CONNECTED and no error", async () => {
    H.rows = [messenger()];
    await runHealthCheck();
    const read = callsTo("/page_1/subscribed_apps");
    expect(read).toHaveLength(1);
    expect(read[0]!.method).toBe("get");
    expect(read[0]!.opts.params).toEqual({ access_token: "tok_page" });
    expect(updatesFor("ca_m")[0]!.data).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("our app missing (another app listed): stays CONNECTED with SUBSCRIBE_FAILED", async () => {
    H.rows = [messenger()];
    H.subscribedApps = [{ id: "someone_else" }];
    await runHealthCheck();
    const data = updatesFor("ca_m")[0]!.data;
    expect(data.connectionStatus).toBe("CONNECTED");
    expect(data.lastError).toMatch(/^\[SUBSCRIBE_FAILED\] /);
  });

  it("no apps at all: SUBSCRIBE_FAILED", async () => {
    H.rows = [messenger()];
    H.subscribedApps = [];
    await runHealthCheck();
    expect(updatesFor("ca_m")[0]!.data.lastError).toMatch(/^\[SUBSCRIBE_FAILED\] /);
  });

  it("listed again: a stored SUBSCRIBE_FAILED is cleared", async () => {
    H.rows = [messenger({ lastError: "[SUBSCRIBE_FAILED] old" })];
    await runHealthCheck();
    expect(updatesFor("ca_m")[0]!.data.lastError).toBeNull();
  });

  it("listed: another writer's code is kept", async () => {
    H.rows = [messenger({ lastError: "[OTHER_CODE] someone else knows" })];
    await runHealthCheck();
    expect(updatesFor("ca_m")[0]!.data.lastError).toBe("[OTHER_CODE] someone else knows");
  });

  it("the read itself failing is no evidence: a stored code stays, free text clears", async () => {
    H.subscribedApps = httpError(500, "temporarily unavailable");
    H.rows = [messenger({ lastError: "[SUBSCRIBE_FAILED] old" }), messenger({ id: "ca_m2", externalId: "page_2", lastError: "Token refresh failed: x" })];
    await runHealthCheck();
    expect(updatesFor("ca_m")[0]!.data).toMatchObject({ connectionStatus: "CONNECTED", lastError: "[SUBSCRIBE_FAILED] old" });
    expect(updatesFor("ca_m2")[0]!.data).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("an invalid token is still ERROR, and the subscription is not read", async () => {
    H.rows = [messenger()];
    H.debugValid = false;
    await runHealthCheck();
    expect(callsTo("subscribed_apps")).toEqual([]);
    expect(updatesFor("ca_m")[0]!.data).toMatchObject({ connectionStatus: "ERROR", lastError: "bad token" });
  });

  it("WhatsApp and Instagram-Login rows are not read for a Page subscription", async () => {
    H.rows = [
      messenger({ id: "ca_wa", channel: "WHATSAPP", externalId: "pn_1" }),
      messenger({ id: "ca_ig", channel: "INSTAGRAM", externalId: "ig_1", credentials: { accessToken: "tok_ig", igLogin: true } }),
    ];
    H.subscribedApps = [];
    await runHealthCheck();
    expect(callsTo("subscribed_apps")).toEqual([]);
    expect(updatesFor("ca_wa")[0]!.data.lastError).toBeNull();
    expect(updatesFor("ca_ig")[0]!.data.lastError).toBeNull();
  });

  it("disconnected or inactive Pages are never read or written", async () => {
    H.rows = [messenger({ id: "ca_off", connectionStatus: "DISCONNECTED" }), messenger({ id: "ca_inactive", isActive: false })];
    H.subscribedApps = [];
    await runHealthCheck();
    expect(H.calls).toEqual([]);
    expect(H.updates).toEqual([]);
  });
});

describe("★ Gmail: a watch that cannot be renewed says so", () => {
  it("renewed: WATCH_FAILED cleared, platformMeta merged, no status change", async () => {
    H.rows = [gmail({ lastError: "[WATCH_FAILED] old" })];
    await runGmailWatchRenewal();
    const watch = callsTo("/users/me/watch")[0]!;
    expect(watch.body).toEqual({ topicName: "projects/p/topics/gmail-dev", labelIds: ["INBOX"] });
    expect(watch.opts.headers.Authorization).toBe("Bearer g_fresh");
    const data = updatesFor("ca_g")[0]!.data;
    expect(data.lastError).toBeNull();
    expect(data.platformMeta).toEqual({ lastHistoryId: "5", watchExpiration: "1760000000000" });
    expect(data).not.toHaveProperty("connectionStatus");
  });

  it("renewed: another writer's code is kept", async () => {
    H.rows = [gmail({ lastError: "[OTHER_CODE] x" })];
    await runGmailWatchRenewal();
    expect(updatesFor("ca_g")[0]!.data.lastError).toBe("[OTHER_CODE] x");
  });

  it("the watch call failing: WATCH_FAILED with the reason, status unchanged", async () => {
    H.rows = [gmail()];
    H.watchFails = httpError(403, "User not authorized to perform this action.");
    await runGmailWatchRenewal();
    const data = updatesFor("ca_g")[0]!.data;
    expect(data.lastError).toMatch(/^\[WATCH_FAILED\] .*User not authorized to perform this action\./);
    expect(data).not.toHaveProperty("connectionStatus");
  });

  it("no refresh credentials: WATCH_FAILED, no watch call", async () => {
    H.rows = [gmail({ credentials: { accessToken: "old" } })];
    await runGmailWatchRenewal();
    expect(callsTo("/users/me/watch")).toEqual([]);
    expect(updatesFor("ca_g")[0]!.data.lastError).toMatch(/^\[WATCH_FAILED\] /);
  });

  it("no Pub/Sub topic: every connected mailbox gets WATCH_FAILED, nothing is called", async () => {
    delete process.env.GMAIL_PUBSUB_TOPIC;
    H.rows = [gmail(), gmail({ id: "ca_g2", externalId: "c@x.com" })];
    await runGmailWatchRenewal();
    expect(H.calls).toEqual([]);
    expect(updatesFor("ca_g")[0]!.data).toEqual({ lastError: expect.stringMatching(/^\[WATCH_FAILED\] .*topic/) });
    expect(updatesFor("ca_g2")[0]!.data.lastError).toMatch(/^\[WATCH_FAILED\] /);
  });

  it("disconnected, errored or inactive mailboxes are never touched, topic or not", async () => {
    const off = [gmail({ id: "g_off", connectionStatus: "DISCONNECTED" }), gmail({ id: "g_err", connectionStatus: "ERROR" }), gmail({ id: "g_in", isActive: false })];
    H.rows = off;
    await runGmailWatchRenewal();
    delete process.env.GMAIL_PUBSUB_TOPIC;
    await runGmailWatchRenewal();
    expect(H.calls).toEqual([]);
    expect(H.updates).toEqual([]);
  });
});

describe("★ Outlook: the Graph mail subscription is renewed before it lapses", () => {
  it("under 24h left: PATCH with the fresh token for 4200 minutes, expiry merged into platformMeta", async () => {
    H.rows = [outlook()];
    await runOutlookHealth();
    const patches = callsTo("/subscriptions/");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub_1");
    const asked = new Date(NOW + 4200 * 60 * 1000).toISOString();
    expect(patches[0]!.body).toEqual({ expirationDateTime: asked });
    expect(patches[0]!.opts.headers.Authorization).toBe("Bearer ms_fresh");
    const data = updatesFor("ca_o")[0]!.data;
    expect(data).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    expect(data.platformMeta).toEqual({ subscriptionId: "sub_1", clientState: "cs_1", subscriptionExpiresAt: asked });
  });

  it("stores the expiry Graph granted, not the one asked for", async () => {
    H.rows = [outlook()];
    H.patch = { data: { expirationDateTime: "2026-10-11T08:00:00.000Z" } };
    await runOutlookHealth();
    expect(updatesFor("ca_o")[0]!.data.platformMeta.subscriptionExpiresAt).toBe("2026-10-11T08:00:00.000Z");
  });

  it("an older row with only subscriptionId is renewed, and nothing else in platformMeta is erased", async () => {
    H.rows = [outlook({ platformMeta: { subscriptionId: "sub_1", note: "keep" } })];
    await runOutlookHealth();
    expect(callsTo("/subscriptions/")).toHaveLength(1);
    expect(updatesFor("ca_o")[0]!.data.platformMeta).toMatchObject({ subscriptionId: "sub_1", note: "keep", subscriptionExpiresAt: expect.any(String) });
  });

  it("more than 24h left: no PATCH, platformMeta untouched, its own code cleared", async () => {
    H.rows = [outlook({ lastError: "[OUTLOOK_SUBSCRIPTION_FAILED] old", platformMeta: { subscriptionId: "sub_1", subscriptionExpiresAt: new Date(NOW + 25 * HOUR).toISOString() } })];
    await runOutlookHealth();
    expect(callsTo("/subscriptions/")).toEqual([]);
    const data = updatesFor("ca_o")[0]!.data;
    expect(data).not.toHaveProperty("platformMeta");
    expect(data.lastError).toBeNull();
  });

  it("23h left is inside the window and renews", async () => {
    H.rows = [outlook({ platformMeta: { subscriptionId: "sub_1", subscriptionExpiresAt: new Date(NOW + 23 * HOUR).toISOString() } })];
    await runOutlookHealth();
    expect(callsTo("/subscriptions/")).toHaveLength(1);
  });

  it("an already-past expiry is still attempted (Graph decides if it is gone)", async () => {
    H.rows = [outlook({ platformMeta: { subscriptionId: "sub_1", subscriptionExpiresAt: new Date(NOW - HOUR).toISOString() } })];
    await runOutlookHealth();
    expect(callsTo("/subscriptions/")).toHaveLength(1);
  });

  it("404 (subscription gone): OUTLOOK_SUBSCRIPTION_FAILED, still CONNECTED, expiry not moved", async () => {
    H.rows = [outlook()];
    H.patch = { status: 404 };
    await runOutlookHealth();
    const data = updatesFor("ca_o")[0]!.data;
    expect(data.connectionStatus).toBe("CONNECTED");
    expect(data.lastError).toMatch(/^\[OUTLOOK_SUBSCRIPTION_FAILED\] .*no longer exists/);
    expect(data).not.toHaveProperty("platformMeta");
  });

  it("any other failure: OUTLOOK_SUBSCRIPTION_FAILED with the reason", async () => {
    H.rows = [outlook()];
    H.patch = { status: 503 };
    await runOutlookHealth();
    expect(updatesFor("ca_o")[0]!.data.lastError).toMatch(/^\[OUTLOOK_SUBSCRIPTION_FAILED\] .*Server busy/);
  });

  it("no subscriptionId: reported, and never created here", async () => {
    H.rows = [outlook({ platformMeta: { subscriptionId: null } })];
    await runOutlookHealth();
    expect(H.calls.filter((c) => c.url.includes("/subscriptions"))).toEqual([]);
    const data = updatesFor("ca_o")[0]!.data;
    expect(data).toMatchObject({ connectionStatus: "CONNECTED" });
    expect(data.lastError).toMatch(/^\[OUTLOOK_SUBSCRIPTION_FAILED\] /);
  });

  it("renewed: a token error text is cleared, another writer's code is kept", async () => {
    H.rows = [
      outlook({ connectionStatus: "ERROR", lastError: "Outlook token is invalid or expired: x" }),
      outlook({ id: "ca_o2", externalId: "c@x.com", lastError: "[OTHER_CODE] y" }),
    ];
    await runOutlookHealth();
    expect(updatesFor("ca_o")[0]!.data).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    expect(updatesFor("ca_o2")[0]!.data.lastError).toBe("[OTHER_CODE] y");
  });

  it("a dead token: ERROR as before, and no renewal is attempted", async () => {
    H.rows = [outlook({ credentials: { accessToken: "old" } })];
    await runOutlookHealth();
    expect(callsTo("/subscriptions/")).toEqual([]);
    expect(updatesFor("ca_o")[0]!.data.connectionStatus).toBe("ERROR");
  });

  it("disconnected or inactive mailboxes are never renewed or written", async () => {
    H.rows = [outlook({ id: "o_off", connectionStatus: "DISCONNECTED" }), outlook({ id: "o_in", isActive: false })];
    await runOutlookHealth();
    expect(H.calls).toEqual([]);
    expect(H.updates).toEqual([]);
  });
});
