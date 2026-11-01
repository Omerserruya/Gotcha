import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The whole value of a handshake ticket is two properties: it dies quickly, and
 * it works exactly once. Everything below defends one of those, or defends the
 * rule that a failed redemption is a rejection rather than a fall-through.
 */

const { redisMock } = vi.hoisted(() => ({
  redisMock: { set: vi.fn(), getdel: vi.fn(), eval: vi.fn() },
}));
vi.mock("../redis", () => ({ getRedis: () => redisMock }));
const SUPPORT = vi.hoisted(() => ({ session: null as any }));
vi.mock("../prisma", () => ({ prisma: { supportSession: { findUnique: async () => SUPPORT.session } } }));

import {
  issueRealtimeTicket,
  redeemRealtimeTicket,
  isWellFormedRealtimeTicket,
  REALTIME_TICKET_TTL_SECONDS,
} from "../realtime-ticket";

const PRINCIPAL = {
  userId: "usr_1",
  identityId: "idn_1",
  tenantId: "ten_1",
  role: "AGENT",
  email: "dana@example.com",
  departmentId: "dep_1",
  departmentRole: "MEMBER",
};

describe("issueRealtimeTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
  });

  it("returns a well-formed ticket and its lifetime", async () => {
    const { ticket, expiresInSeconds } = await issueRealtimeTicket(PRINCIPAL as any);
    expect(isWellFormedRealtimeTicket(ticket)).toBe(true);
    expect(expiresInSeconds).toBe(REALTIME_TICKET_TTL_SECONDS);
  });

  it("always writes an expiry, so a ticket cannot outlive its window", async () => {
    await issueRealtimeTicket(PRINCIPAL as any);
    const [, , ex, ttl] = redisMock.set.mock.calls[0];
    expect(ex).toBe("EX");
    expect(ttl).toBe(REALTIME_TICKET_TTL_SECONDS);
  });

  it("stores the ticket under a HASH, never under its own value", async () => {
    // A Redis dump - a backup, a KEYS *, a shared dev instance - must not yield
    // a usable credential.
    const { ticket } = await issueRealtimeTicket(PRINCIPAL as any);
    const key = redisMock.set.mock.calls[0][0] as string;
    expect(key).toMatch(/^realtime:ticket:[0-9a-f]{64}$/);
    expect(key).not.toContain(ticket);
  });

  it("mints a different ticket every time", async () => {
    const a = await issueRealtimeTicket(PRINCIPAL as any);
    const b = await issueRealtimeTicket(PRINCIPAL as any);
    expect(a.ticket).not.toBe(b.ticket);
  });

  it("carries the principal, and nothing a client could widen", async () => {
    await issueRealtimeTicket(PRINCIPAL as any);
    const stored = JSON.parse(redisMock.set.mock.calls[0][1] as string);
    expect(stored).toEqual(PRINCIPAL);
  });
});

describe("redeemRealtimeTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
  });

  it("returns the principal that minted it", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify(PRINCIPAL));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toEqual(PRINCIPAL);
  });

  it("reads and deletes in ONE command", async () => {
    // Two round trips would let two sockets racing on the same ticket both
    // succeed, which is precisely the property being sold.
    redisMock.getdel.mockResolvedValue(JSON.stringify(PRINCIPAL));
    await redeemRealtimeTicket("t".repeat(43));
    expect(redisMock.getdel).toHaveBeenCalledTimes(1);
  });

  it("returns null the second time, because the first spent it", async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify(PRINCIPAL)).mockResolvedValueOnce(null);
    const t = "t".repeat(43);
    await expect(redeemRealtimeTicket(t)).resolves.toEqual(PRINCIPAL);
    await expect(redeemRealtimeTicket(t)).resolves.toBeNull();
  });

  it("returns null for an unknown or expired ticket", async () => {
    redisMock.getdel.mockResolvedValue(null);
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toBeNull();
  });

  it("rejects a malformed ticket without touching redis", async () => {
    for (const bad of ["", "short", null, undefined, 42, "t".repeat(44), "has spaces!"]) {
      await expect(redeemRealtimeTicket(bad as any)).resolves.toBeNull();
    }
    expect(redisMock.getdel).not.toHaveBeenCalled();
  });

  it("returns null on a corrupt stored value rather than throwing", async () => {
    redisMock.getdel.mockResolvedValue("{not json");
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toBeNull();
  });

  it("returns null when the stored record is missing a tenant", async () => {
    // A record without a tenant would authenticate a socket into no scope.
    redisMock.getdel.mockResolvedValue(JSON.stringify({ userId: "usr_1" }));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toBeNull();
  });

  it("falls back to an atomic Lua eval where GETDEL is unavailable", async () => {
    redisMock.getdel.mockRejectedValue(new Error("ERR unknown command 'GETDEL'"));
    redisMock.eval.mockResolvedValue(JSON.stringify(PRINCIPAL));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toEqual(PRINCIPAL);
    // Still one atomic round trip, not a get followed by a del.
    expect(redisMock.eval).toHaveBeenCalledTimes(1);
  });

  it("returns null when redis is unreachable entirely", async () => {
    redisMock.getdel.mockRejectedValue(new Error("ECONNREFUSED"));
    redisMock.eval.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toBeNull();
  });

  it("round-trips a real issued ticket", async () => {
    const store = new Map<string, string>();
    redisMock.set.mockImplementation(async (k: string, v: string) => void store.set(k, v));
    redisMock.getdel.mockImplementation(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    });
    const { ticket } = await issueRealtimeTicket(PRINCIPAL as any);
    await expect(redeemRealtimeTicket(ticket)).resolves.toEqual(PRINCIPAL);
    await expect(redeemRealtimeTicket(ticket)).resolves.toBeNull();
  });
});

// Support mode (2026-11-01): a support ticket is for the supported tenant, and
// it stops working the moment its support session does.
describe("a support-mode ticket", () => {
  const support = { ...PRINCIPAL, userId: "usr_support", tenantId: "ten_shop", role: "ADMIN", support: { sessionId: "ss_1", adminUserId: "u_sys", adminEmail: "a@g", expiresAt: "", startedAt: "", reason: "r" } };
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
    SUPPORT.session = { endedAt: null, expiresAt: new Date(Date.now() + 3_600_000), tenantId: "ten_shop" };
  });

  it("carries the support session, and nothing of the admin's own tenant", async () => {
    await issueRealtimeTicket(support as any);
    const stored = JSON.parse(redisMock.set.mock.calls[0][1]);
    expect(stored).toMatchObject({ tenantId: "ten_shop", role: "ADMIN", supportSessionId: "ss_1" });
    expect(stored).not.toHaveProperty("support");
  });

  it("redeems while the session is live", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify({ ...PRINCIPAL, tenantId: "ten_shop", supportSessionId: "ss_1" }));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toMatchObject({ tenantId: "ten_shop" });
  });

  it.each([
    ["ended", () => { SUPPORT.session.endedAt = new Date(); }],
    ["expired", () => { SUPPORT.session.expiresAt = new Date(Date.now() - 1); }],
    ["gone", () => { SUPPORT.session = null; }],
    ["for another tenant", () => { SUPPORT.session.tenantId = "ten_other"; }],
  ])("is refused once the session is %s", async (_n, setup) => {
    setup();
    redisMock.getdel.mockResolvedValue(JSON.stringify({ ...PRINCIPAL, tenantId: "ten_shop", supportSessionId: "ss_1" }));
    await expect(redeemRealtimeTicket("t".repeat(43))).resolves.toBeNull();
  });
});
