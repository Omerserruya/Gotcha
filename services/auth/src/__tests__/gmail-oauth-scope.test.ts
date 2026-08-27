/**
 * What GOTCHA asks Google for, and what it does with the grant.
 *
 * The Gmail channel used to request four scopes when one covers every call it
 * makes. `gmail.modify` is an accepted authorization scope for users.getProfile,
 * users.watch, users.stop, users.history.list, users.messages.get and
 * users.messages.send, which is the complete list of Gmail endpoints in this
 * repo. `gmail.readonly` and `gmail.send` were subsets of it, and
 * `userinfo.email` existed only to learn the mailbox address that getProfile
 * returns anyway.
 *
 * Over-asking is not free: `gmail.modify` is a restricted scope, so every extra
 * scope is another line a Google reviewer has to accept and another permission
 * a customer has to grant on the consent screen. These cases pin the ask to one
 * scope, and pin the callback to reading the address from Gmail rather than
 * from an identity endpoint we no longer have permission to call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Read at module load in channels.ts, so they have to be set before the import
// below runs. vi.hoisted lifts this above the hoisted import statements.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id-under-test";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret-under-test";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY =
    "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

// ─── What the route saw and did ──────────────────────────────

const state = {
  /** Every URL axios was asked for, so an unexpected host is visible. */
  gets: [] as string[],
  posts: [] as string[],
  channelWrites: [] as any[],
  stateStore: new Map<string, string>(),
};

const mocks = vi.hoisted(() => ({ prismaMock: {} as any }));

vi.mock("axios", () => {
  const get = async (url: string, _cfg?: any) => {
    state.gets.push(url);
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return { data: { emailAddress: "support@acme.test", historyId: 111 } };
    }
    // Anything else is a call this flow should no longer be making. Fail the
    // way Google would if the token lacked the scope, so a regression shows up
    // as a broken connect rather than a silently different code path.
    const err: any = new Error("insufficient authentication scopes");
    err.response = { status: 403, data: { error: "insufficient_scope", url } };
    throw err;
  };
  const post = async (url: string, _body?: any, _cfg?: any) => {
    state.posts.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return {
        data: { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 },
      };
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/watch") {
      return { data: { historyId: 222, expiration: "1900000000000" } };
    }
    const err: any = new Error("unexpected post");
    err.response = { status: 403, data: { url } };
    throw err;
  };
  const axiosMock = { get, post, delete: async () => ({ data: {} }) };
  return { default: axiosMock, ...axiosMock };
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    getRedis: () => ({
      get: async (k: string) => state.stateStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        state.stateStore.set(k, v);
        return "OK";
      },
      del: async (k: string) => (state.stateStore.delete(k) ? 1 : 0),
    }),
    // The auth gate has its own tests; this suite is about the Google ask.
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "user_1" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = "tenant_a";
      next();
    },
    resolvePrincipal: async () => ({
      userId: "user_1",
      tenantId: "tenant_a",
      role: "ADMIN",
    }),
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireCapacity: () => (_req: any, _res: any, next: any) => next(),
    validate: () => (_req: any, _res: any, next: any) => next(),
    // Single-use in memory, matching the real ok/reason contract. The real
    // store is Redis-backed and has its own tests; replaying it here would make
    // this suite about state tokens instead of about the Google ask.
    mintOAuthState: (claims: any) => {
      const token = `st_${state.stateStore.size + 1}`;
      state.stateStore.set(token, JSON.stringify({ ...claims, jti: token }));
      return { state: token, jti: token };
    },
    consumeOAuthState: async (raw: string | undefined, expectedProvider: string) => {
      if (!raw) return { ok: false, reason: "invalid" };
      const stored = state.stateStore.get(raw);
      if (!stored) return { ok: false, reason: "replayed" };
      state.stateStore.delete(raw);
      const claims = JSON.parse(stored);
      if (claims.provider !== expectedProvider) {
        return { ok: false, reason: "provider_mismatch" };
      }
      return { ok: true, claims };
    },
  };
});

import { mintOAuthState } from "@chatcenter/shared";
import channelsRouter from "../routes/channels";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/channels", channelsRouter);
  return a;
}

beforeEach(() => {
  state.gets = [];
  state.posts = [];
  state.channelWrites = [];
  state.stateStore.clear();

  mocks.prismaMock.channelAccount = {
    count: async () => 0,
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [],
    create: async (args: any) => {
      state.channelWrites.push(args.data);
      return { id: "ca_1", ...args.data };
    },
    update: async (args: any) => {
      state.channelWrites.push(args.data);
      return { id: "ca_1", ...args.data };
    },
  };
  mocks.prismaMock.routerRule = {
    findMany: async () => [],
    create: async (args: any) => args.data,
    update: async (args: any) => args.data,
  };
  mocks.prismaMock.$transaction = async (ops: any[]) => Promise.all(ops);
});

// ─── The consent screen ──────────────────────────────────────

/** Drives /oauth/init and returns the parsed Google consent URL. */
async function consentUrl(): Promise<URL> {
  const res = await request(app()).get("/api/channels/oauth/init?platform=gmail&token=t");
  expect(res.status).toBe(302);
  return new URL(res.headers.location);
}

describe("the Gmail consent screen", () => {
  it("asks for gmail.modify and nothing else", async () => {
    const url = await consentUrl();
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
  });

  it("no longer asks for scopes that gmail.modify already covers", async () => {
    // Named individually: each one is a scope a Google reviewer would have to
    // see justified, and re-adding any of them would be a silent widening.
    const scope = (await consentUrl()).searchParams.get("scope")!;
    expect(scope).not.toContain("gmail.readonly");
    expect(scope).not.toContain("gmail.send");
    expect(scope).not.toContain("mail.google.com");
  });

  it("no longer asks for a Google identity scope", async () => {
    // The mailbox address comes from Gmail itself now, so GOTCHA has no reason
    // to know the person's Google identity.
    const scope = (await consentUrl()).searchParams.get("scope")!;
    expect(scope).not.toContain("userinfo");
    expect(scope).not.toContain("openid");
    expect(scope).not.toContain("profile");
  });

  it("still requests offline access, or there is no refresh token to renew the watch", async () => {
    const url = await consentUrl();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

// ─── The callback ────────────────────────────────────────────

/** Runs a full connect and returns the redirect the browser is sent to. */
async function connect(): Promise<string> {
  const { state: oauthState } = mintOAuthState({
    tenantId: "tenant_a",
    provider: "meta_channels",
    userId: "user_1",
    platform: "gmail",
  } as any);
  const res = await request(app()).get(
    `/api/channels/oauth/callback?code=auth_code&state=${encodeURIComponent(oauthState)}`,
  );
  expect(res.status).toBe(302);
  return res.headers.location;
}

describe("the Gmail connect callback", () => {
  it("reads the mailbox address from Gmail, not from Google's identity endpoint", async () => {
    await connect();

    expect(state.gets).toContain("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    // This endpoint needs a userinfo.* scope we deliberately no longer hold, so
    // calling it would 403 in production.
    expect(state.gets.join(" ")).not.toContain("googleapis.com/oauth2");
    expect(state.gets.join(" ")).not.toContain("userinfo");
  });

  it("stores the mailbox under the address getProfile returned", async () => {
    await connect();

    const written = state.channelWrites.find((w) => w.externalId === "support@acme.test");
    expect(written).toBeTruthy();
    expect(written.channel).toBe("GMAIL");
    expect(written.connectionStatus).toBe("CONNECTED");
    // A mailbox is its address: no userinfo.profile means no `name` to prefer.
    expect(written.displayName).toBe("support@acme.test");
  });

  it("reads the mailbox in one call instead of two", async () => {
    // getProfile returns emailAddress AND historyId, so the old pairing of a
    // userinfo call with a separate profile call is now a single round trip.
    await connect();

    const profileCalls = state.gets.filter((u) => u.endsWith("/users/me/profile"));
    expect(profileCalls).toHaveLength(1);
  });

  it("starts the history cursor where the watch was armed, not before it", async () => {
    // An id from before the watch would replay mail that arrived while nothing
    // was listening; the watch response is the authoritative starting point.
    await connect();

    expect(state.posts).toContain("https://gmail.googleapis.com/gmail/v1/users/me/watch");
    const written = state.channelWrites.find((w) => w.externalId === "support@acme.test");
    expect(written.platformMeta.lastHistoryId).toBe("222");
  });

  it("falls back to the profile history id when the watch could not be armed", async () => {
    // Pub/Sub unconfigured is a normal dev state. The channel must still
    // connect with a usable cursor rather than none.
    const topic = process.env.GMAIL_PUBSUB_TOPIC;
    delete process.env.GMAIL_PUBSUB_TOPIC;
    try {
      await connect();
      const written = state.channelWrites.find((w) => w.externalId === "support@acme.test");
      expect(written.platformMeta.lastHistoryId).toBe("111");
    } finally {
      if (topic) process.env.GMAIL_PUBSUB_TOPIC = topic;
    }
  });
});
