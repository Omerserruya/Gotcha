/**
 * ★ The website widget's code snippet (web chat) on the socket instead of
 * polling:
 *   - it connects with the same secret its REST routes take (the session
 *     token from /init) and joins only its own conversation's room
 *   - a wrong token, another conversation's token, or a non-web-chat
 *     conversation is refused
 *   - the relay pushes web chat messages in the polling endpoint's shape and
 *     skips system events
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));

const H = vi.hoisted(() => ({ mw: null as any, conversations: [] as any[], emit: vi.fn(), sockets: [{ id: "s1" }] as any[], to: [] as string[] }));

vi.mock("socket.io", () => ({
  Server: class {
    use(fn: any) { H.mw = fn; }
    on() {}
    to(room: string) { H.to.push(room); return { emit: H.emit }; }
    in() { return { fetchSockets: async () => H.sockets }; }
  },
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: {
        findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null,
        findFirst: async (a: any) => H.conversations.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
      },
      channelAccount: { findFirst: async () => null },
    },
  };
});

import { initSocket } from "../lib/socket";
import { relayToVisitor } from "../subscribers/shopify-visitor-relay";

initSocket({} as any);
const connect = (auth: any) => new Promise<{ ok: boolean; socket: any; err?: string }>((resolve) => {
  const socket: any = { handshake: { auth, headers: {} } };
  H.mw(socket, (err?: Error) => resolve({ ok: !err, socket, err: err?.message }));
});

beforeEach(() => {
  H.emit.mockReset(); H.to = []; H.sockets = [{ id: "s1" }];
  H.conversations = [
    { id: "web1", tenantId: "T", channel: "WEBCHAT", customerExternalId: "sess_secret", channelAccountId: "ca_web" },
    { id: "web2", tenantId: "T", channel: "WEBCHAT", customerExternalId: "sess_other", channelAccountId: "ca_web" },
    { id: "wa1", tenantId: "T", channel: "WHATSAPP", customerExternalId: "972500000000", channelAccountId: "ca_wa" },
  ];
});

describe("★ the web chat visitor's socket", () => {
  it("its own token: connected, as a visitor of that one conversation", async () => {
    const r = await connect({ webchatToken: "sess_secret", conversationId: "web1" });
    expect(r.ok).toBe(true);
    expect(r.socket.kind).toBe("visitor");
    expect(r.socket.visitor).toEqual({ tenantId: "T", conversationId: "web1" });
  });

  it("refused: a wrong token, another conversation's token, a WhatsApp conversation, no conversation", async () => {
    for (const auth of [
      { webchatToken: "guess", conversationId: "web1" },
      { webchatToken: "sess_other", conversationId: "web1" },
      { webchatToken: "972500000000", conversationId: "wa1" },
      { webchatToken: "sess_secret" },
      { webchatToken: "sess_secret", conversationId: "missing" },
    ]) {
      const r = await connect(auth);
      expect(r.ok, JSON.stringify(auth)).toBe(false);
    }
  });
});

describe("★ the relay pushes web chat messages", () => {
  const ev = (message: any) => ({ event: "message:new", tenantId: "T", data: { conversationId: "web1", channel: "WEBCHAT", message: { id: "m1", direction: "OUTBOUND", body: "Hi!", senderName: "Maya", messageType: "text", createdAt: "2026-10-07T10:00:00.000Z", metadata: { secret: 1 }, ...message } } });

  it("in the polling endpoint's shape, to that conversation's room only", async () => {
    await relayToVisitor(ev({}) as any);
    expect(H.to).toContain("visitor:web1");
    expect(H.emit).toHaveBeenCalledWith("visitor:message", {
      conversationId: "web1",
      message: { id: "m1", direction: "OUTBOUND", body: "Hi!", senderName: "Maya", createdAt: "2026-10-07T10:00:00.000Z" },
    });
  });

  it("system events are not pushed; nobody listening means no work", async () => {
    await relayToVisitor(ev({ messageType: "system", body: "" }) as any);
    expect(H.emit).not.toHaveBeenCalled();
    H.sockets = [];
    await relayToVisitor(ev({}) as any);
    expect(H.emit).not.toHaveBeenCalled();
  });
});
