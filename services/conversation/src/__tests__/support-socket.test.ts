/**
 * Support mode on the socket (2026-11-01): a support socket lives only while
 * its support session does.
 *   - ended (console end, logout) -> the sweep disconnects it, with support:ended
 *   - expired -> the same
 *   - a join after the end is refused and the socket is closed
 *   - ordinary staff sockets and live sessions are untouched
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));

const H = vi.hoisted(() => ({ onConnection: null as any, sessions: new Map<string, any>() }));

vi.mock("socket.io", () => ({
  Server: class {
    use() {}
    on(ev: string, fn: any) { if (ev === "connection") H.onConnection = fn; }
    of() { return { sockets: new Map() }; }
  },
}));
vi.mock("../lib/conversation-visibility", () => ({ canViewConversation: async () => true }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      supportSession: { findMany: async ({ where }: any) => where.id.in.map((id: string) => H.sessions.get(id)).filter(Boolean) },
    },
  };
});

import { initSocket, sweepSupportSockets, SUPPORT_ENDED_EVENT } from "../lib/socket";

initSocket({} as any);
const HOUR = 3_600_000;

function fakeSocket(user: any) {
  const handlers = new Map<string, any>();
  return {
    user, kind: "staff", rooms: new Set<string>(), emitted: [] as any[], disconnected: false,
    join(r: string) { this.rooms.add(r); }, leave(r: string) { this.rooms.delete(r); },
    on(ev: string, fn: any) { handlers.set(ev, fn); },
    emit(ev: string, payload: any) { this.emitted.push([ev, payload]); },
    disconnect() { this.disconnected = true; },
    handlers,
  } as any;
}
const supportSocket = () => fakeSocket({ userId: "u_support", tenantId: "t_shop", role: "ADMIN", supportSessionId: "ss_1" });

beforeEach(() => {
  H.sessions.clear();
  H.sessions.set("ss_1", { id: "ss_1", endedAt: null, expiresAt: new Date(Date.now() + 2 * HOUR) });
});

describe("support sockets", () => {
  it("a live session: the sweep leaves it connected", async () => {
    const s = supportSocket();
    expect(await sweepSupportSockets([s])).toBe(0);
    expect(s.disconnected).toBe(false);
  });

  it("ended (console or logout): support:ended { code: support_expired }, then disconnected", async () => {
    const s = supportSocket();
    H.sessions.get("ss_1").endedAt = new Date();
    expect(await sweepSupportSockets([s])).toBe(1);
    expect(s.emitted).toEqual([[SUPPORT_ENDED_EVENT, { code: "support_expired" }]]);
    expect(s.disconnected).toBe(true);
  });

  it("expired: disconnected the same way", async () => {
    const s = supportSocket();
    H.sessions.get("ss_1").expiresAt = new Date(Date.now() - 1);
    await sweepSupportSockets([s]);
    expect(s.disconnected).toBe(true);
  });

  it("an ordinary staff socket is never swept", async () => {
    const s = fakeSocket({ userId: "u1", tenantId: "t_shop", role: "ADMIN" });
    H.sessions.clear();
    expect(await sweepSupportSockets([s])).toBe(0);
    expect(s.disconnected).toBe(false);
  });

  it("a join after the end is refused and the socket closed; while live it joins", async () => {
    const s = supportSocket();
    H.onConnection(s);
    const join = (id: string) => new Promise<any>((r) => s.handlers.get("subscribe:conversation")(id, r));
    expect(await join("c1")).toEqual({ ok: true });
    expect(s.rooms.has("conv:c1")).toBe(true);

    H.sessions.get("ss_1").endedAt = new Date();
    expect(await join("c2")).toEqual({ ok: false, reason: "support_expired" });
    expect(s.rooms.has("conv:c2")).toBe(false);
    expect(s.disconnected).toBe(true);
  });
});
