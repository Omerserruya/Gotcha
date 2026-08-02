/**
 * OAuth state: single-use and replay-proof.
 *
 * Before this, every provider's state was a plain signed JWT with a 10-minute
 * expiry - captured once, replayable for ten minutes, and each replay re-ran
 * the token exchange and re-wrote the tenant's connection. These tests lock
 * the properties that close that: one successful consume per token, tenant and
 * return context taken only from the signed payload, and fail-closed behaviour
 * when the replay store is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal Redis stand-in with real SET NX EX semantics.
const store = new Map<string, string>();
const redis = {
  set: vi.fn(async (key: string, val: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === "NX" && store.has(key)) return null; // already claimed
    store.set(key, val);
    return "OK";
  }),
};
vi.mock("../lib/redis", () => ({ getRedis: () => redis, closeRedis: vi.fn() }));

process.env.OAUTH_STATE_SECRET = "test-secret-that-is-long-enough-to-pass-32";

const { mintOAuthState, consumeOAuthState, returnPathForFlow } = await import("../lib/oauth-state-store");

beforeEach(() => {
  store.clear();
  redis.set.mockClear();
});

describe("single-use consumption", () => {
  it("accepts the first consume and rejects every replay", async () => {
    const { state } = mintOAuthState({ tenantId: "t1", provider: "monday" });

    const first = await consumeOAuthState(state, "monday");
    expect(first.ok).toBe(true);

    const replay = await consumeOAuthState(state, "monday");
    expect(replay).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects concurrent consumes of the same token - exactly one wins", async () => {
    const { state } = mintOAuthState({ tenantId: "t1", provider: "monday" });
    const results = await Promise.all([
      consumeOAuthState(state, "monday"),
      consumeOAuthState(state, "monday"),
      consumeOAuthState(state, "monday"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("distinct tokens do not interfere", async () => {
    const a = mintOAuthState({ tenantId: "t1", provider: "monday" });
    const b = mintOAuthState({ tenantId: "t1", provider: "monday" });
    expect(a.jti).not.toBe(b.jti);
    expect((await consumeOAuthState(a.state, "monday")).ok).toBe(true);
    expect((await consumeOAuthState(b.state, "monday")).ok).toBe(true);
  });
});

describe("token validation", () => {
  it("rejects a state minted for a different provider", async () => {
    const { state } = mintOAuthState({ tenantId: "t1", provider: "calendly" });
    expect(await consumeOAuthState(state, "monday")).toEqual({ ok: false, reason: "provider_mismatch" });
  });

  it("rejects a forged/garbage state", async () => {
    expect(await consumeOAuthState("not-a-jwt", "monday")).toEqual({ ok: false, reason: "invalid" });
    expect(await consumeOAuthState(undefined, "monday")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an expired state", async () => {
    const { state } = mintOAuthState({ tenantId: "t1", provider: "monday" }, -1);
    expect(await consumeOAuthState(state, "monday")).toEqual({ ok: false, reason: "expired" });
  });

  it("carries tenant, user and return context through the signed payload", async () => {
    const { state } = mintOAuthState({
      tenantId: "tenant-42", provider: "google", userId: "user-7", flow: "onboarding", aiAgentId: "agent-1",
    });
    const r = await consumeOAuthState<{ tenantId: string; userId: string; flow: string; aiAgentId: string }>(state, "google");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The callback must read these from the token - never from the query string.
    expect(r.claims.tenantId).toBe("tenant-42");
    expect(r.claims.userId).toBe("user-7");
    expect(r.claims.flow).toBe("onboarding");
    expect(r.claims.aiAgentId).toBe("agent-1");
  });

  it("fails CLOSED when the replay store is unreachable", async () => {
    const { state } = mintOAuthState({ tenantId: "t1", provider: "monday" });
    redis.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    // Degrading to "allow" here would silently restore the replay window.
    expect(await consumeOAuthState(state, "monday")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("return path derivation", () => {
  it("sends an onboarding connect back to the wizard", () => {
    expect(returnPathForFlow("onboarding", "monday")).toBe("/setup?connected=monday");
  });

  it("sends everything else to the provider's marketplace page", () => {
    expect(returnPathForFlow(undefined, "monday")).toBe("/ai-studio/marketplace/monday?status=connected");
  });

  it("never emits an absolute URL (open-redirect safety)", () => {
    for (const flow of ["onboarding", undefined, "https://evil.example.com"]) {
      expect(returnPathForFlow(flow as string | undefined, "monday").startsWith("/")).toBe(true);
    }
  });
});
