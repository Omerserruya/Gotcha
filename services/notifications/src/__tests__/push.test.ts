/**
 * ★ Mobile push (FCM HTTP v1), 2026-11-03:
 *   - personalAllows: the master push switch, the per-event switch, approvals,
 *     and quiet hours (the same window email uses)
 *   - the push arm of the fan-out: skipped when FCM is not configured or the
 *     person has no phone; otherwise one send per phone in that tenant
 *   - collapse ids per conversation, the mobile deep links
 *   - a token FCM calls dead is deleted; a server error keeps it
 *   - the OAuth token is a signed RS256 assertion, cached across sends
 *   - message.inbound: push only, to the assignee only, whatever a rule says
 *   - the conversation.waiting guard (an event not on this branch yet)
 *   - iOS straight to Apple (APNs over http2, ES256 provider token cached
 *     ~50 minutes), routed per device by its provider
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify, verify as cryptoVerify } from "crypto";

const H = vi.hoisted(() => ({
  rules: [] as any[],
  users: [] as any[],
  personal: [] as any[],
  timezone: null as string | null,
  inApp: [] as any[],
  emails: [] as any[],
  devices: [] as any[],
  logs: [] as any[],
  deviceQueries: 0,
  members: [] as Array<{ tenantId: string; departmentId: string; userId: string }>,
  cannotRead: new Set<string>(),
  conversations: [] as Array<Record<string, any>>,
  viewChecks: [] as any[],
  permissionDown: false,
  dedup: new Set<string>(),
}));

/** The http2 double: every APNs request, and Apple's answer per device token. */
const A = vi.hoisted(() => ({
  connects: [] as string[],
  requests: [] as Array<{ host: string; headers: Record<string, string>; body: any }>,
  reply: (_token: string, _n: number): { status: number; body?: any } => ({ status: 200 }),
}));
vi.mock("http2", async () => {
  const { EventEmitter: EE } = await import("events");
  const connect = (host: string) => {
    A.connects.push(host);
    const s: any = new EE();
    s.closed = false; s.destroyed = false;
    s.close = () => { s.closed = true; };
    s.unref = () => s;
    s.request = (headers: Record<string, string>) => {
      const req: any = new EE();
      req.setEncoding = () => req;
      req.setTimeout = () => req;
      req.close = () => undefined;
      req.end = (body: string) => {
        const token = String(headers[":path"]).split("/").pop()!;
        A.requests.push({ host, headers, body: JSON.parse(body) });
        const r = A.reply(token, A.requests.length);
        setImmediate(() => {
          req.emit("response", { ":status": r.status });
          if (r.body) req.emit("data", JSON.stringify(r.body));
          req.emit("end");
        });
      };
      return req;
    };
    return s;
  };
  return { connect, constants: { NGHTTP2_CANCEL: 8 }, default: { connect } };
});

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("./helpers/platform-sender-double")).platformSenderDouble,
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  prisma: {
    notificationPreference: { findMany: async (a: any) => H.rules.filter((r) => r.tenantId === a.where.tenantId && r.eventType === a.where.eventType) },
    user: {
      findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.isActive
        && (a.where.role ? u.role === a.where.role : true)
        && (a.where.kind ? (u.kind ?? "member") === a.where.kind : true)
        && (a.where.id?.in ? a.where.id.in.includes(u.id) : true))
        // Department memberships, in the order they were added (the earliest is the principal's).
        .map((u) => ({ ...u, departmentMembers: H.members.filter((m) => m.userId === u.id && m.tenantId === u.tenantId).map((m) => ({ departmentId: m.departmentId })) })),
    },
    departmentMember: { findMany: async (a: any) => H.members.filter((m) => m.tenantId === a.where?.tenantId && m.departmentId === a.where?.departmentId) },
    userNotificationPreference: { findMany: async (a: any) => H.personal.filter((p) => a.where.userId.in.includes(p.userId)) },
    inAppNotification: { create: async ({ data }: any) => { H.inApp.push(data); return { id: `n${H.inApp.length}`, createdAt: new Date(), read: false, ...data }; } },
    pushDevice: {
      findMany: async (a: any) => { H.deviceQueries++; return H.devices.filter((d) => d.tenantId === a.where.tenantId && d.userId === a.where.userId); },
      deleteMany: async (a: any) => {
        const before = H.devices.length;
        H.devices = H.devices.filter((d) => !(d.id === a.where.id && d.token === a.where.token));
        return { count: before - H.devices.length };
      },
    },
    notificationLog: { create: async ({ data }: any) => { H.logs.push(data); return data; } },
    tenantSetting: { findMany: async () => [] },
  },
  publishEvent: async () => undefined,
  // The real rule, and canViewConversation as the conversation lookup it is:
  // tenant first, then any one of the rule's clauses matching the row.
  visibilityClause: (await import("@chatcenter/shared/src/lib/conversation-visibility-rule")).visibilityClause,
  canViewConversation: async (tenantId: string, id: string, viewer: any) => {
    const { visibilityClause } = await import("@chatcenter/shared/src/lib/conversation-visibility-rule");
    H.viewChecks.push(viewer.userId);
    const clause = visibilityClause(viewer);
    const row = H.conversations.find((c) => c.id === id && c.tenantId === tenantId);
    return !!row && (!clause || clause.some((w) => Object.entries(w).every(([k, v]) => (row[k] ?? null) === v)));
  },
  hasPermission: async (p: any, key: string) => {
    if (H.permissionDown) throw new Error("rbac unavailable");
    return key === "conversation:messages:read" && !H.cannotRead.has(p.userId);
  },
  getRedis: () => ({
    set: async (key: string, _v: string, _ex: string, _ttl: number, mode: string) => {
      if (mode !== "NX") return "OK";
      if (H.dedup.has(key)) return null;
      H.dedup.add(key);
      return "OK";
    },
  }),
  readDurableSetting: async (_t: string, key: string) => (key === "businessHours" && H.timezone ? { timezone: H.timezone } : null),
  parseBusinessHours: (v: any) => v,
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
}));

vi.mock("../services/queues", async () => {
  const actual = await vi.importActual<any>("../services/queues");
  return {
    ...actual,
    getNotificationsQueue: () => ({ add: async () => ({ id: "j" }) }),
    getNotificationsEmailQueue: () => ({ add: async (_n: string, p: any) => { H.emails.push(p); return { id: "e" }; } }),
  };
});

import { processEvent, DELIVERABLE_CHANNELS, skipPushForAssignedWaiting } from "../services/notification-engine.service";
import { buildCatalogue } from "../services/event-catalogue";
import { personalAllows, PERSONAL_DEFAULTS, type Personal } from "../services/personal-preferences.service";
import {
  fcmConfig, buildFcmMessage, isDeadToken, mobileLink, signAssertion, sendPushToUser, resetPushSenderState,
} from "../services/push-sender";
import { apnsConfig, signApnsJwt, buildApnsRequest, collapseId, isDeadApnsToken, APNS_HOSTS } from "../services/apns-sender";
import type { SystemEvent } from "../services/event-emitter.service";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// An Apple .p8 is a PKCS#8 P-256 key.
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8 = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({ id: `e${++seq}`, type, tenantId: "T", data: { n: seq, ...data }, metadata: { timestamp: new Date().toISOString(), ...metadata } }) as unknown as SystemEvent;
const rule = (eventType: string, channels: string[], recipients: any = { type: "tenant_owner" }) =>
  ({ id: `r-${eventType}`, tenantId: "T", departmentId: null, eventType, enabled: true, conditions: null, recipients, channels, priority: "HIGH" });
const device = (id: string, userId: string, tenantId = "T") => ({ id, userId, tenantId, token: `tok-${id}`, platform: "android" });

/** The FCM sends (not the OAuth calls), with their parsed message. */
let fcmCalls: Array<{ url: string; body: any; auth: string }> = [];
let oauthCalls = 0;
let fcmReply: (token: string) => { status: number; json: any } = () => ({ status: 200, json: { name: "projects/p/messages/1" } });

function installFetch() {
  fcmCalls = []; oauthCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    if (url === "https://oauth2.googleapis.com/token") {
      oauthCalls++;
      return { ok: true, status: 200, json: async () => ({ access_token: `at-${oauthCalls}`, expires_in: 3600 }) } as any;
    }
    const body = JSON.parse(init.body);
    fcmCalls.push({ url, body, auth: init.headers.Authorization });
    const r = fcmReply(body.message.token);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as any;
  }));
}

const configure = () => {
  process.env.FCM_PROJECT_ID = "gotcha-app";
  process.env.FCM_CLIENT_EMAIL = "push@gotcha-app.iam.gserviceaccount.com";
  // As an env file carries it: one line, newlines escaped.
  process.env.FCM_PRIVATE_KEY = PEM.replace(/\n/g, "\\n");
};
const unconfigure = () => { delete process.env.FCM_PROJECT_ID; delete process.env.FCM_CLIENT_EMAIL; delete process.env.FCM_PRIVATE_KEY; };
const configureApns = () => {
  process.env.APNS_KEY_ID = "KEY123ABCD";
  process.env.APNS_TEAM_ID = "TEAM456EFG";
  process.env.APNS_PRIVATE_KEY = P8.replace(/\n/g, "\\n");
};
const unconfigureApns = () => { for (const k of ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID", "APNS_ENV"]) delete process.env[k]; };
const iphone = (id: string, userId: string, tenantId = "T") => ({ id, userId, tenantId, token: `a1b2${id}`, platform: "ios", provider: "apns" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
  H.rules = []; H.personal = []; H.timezone = null; H.inApp = []; H.emails = []; H.devices = []; H.logs = []; H.deviceQueries = 0; H.members = []; H.cannotRead = new Set(); H.permissionDown = false; H.viewChecks = [];
  H.conversations = [{ id: "c7", tenantId: "T", departmentId: null, assignedAgentId: null }]; H.dedup = new Set();
  const u = (id: string, role: string, tenantId = "T") => ({ id, tenantId, role, isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
  H.users = [u("dana", "ADMIN"), u("noa", "ADMIN"), u("matan", "AGENT")];
  fcmReply = () => ({ status: 200, json: { name: "projects/p/messages/1" } });
  resetPushSenderState();
  configure();
  unconfigureApns();
  installFetch();
  A.connects = []; A.requests = []; A.reply = () => ({ status: 200 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); unconfigure(); unconfigureApns(); });

describe("★ personalAllows: push", () => {
  const p = (over: Partial<Personal> = {}): Personal => ({ ...PERSONAL_DEFAULTS, ...over });
  const e = (type = "conversation.escalated") => ({ type, data: {} });

  it("on by default; the master switch turns it off", () => {
    expect(personalAllows(p(), "push", e(), "12:00")).toBe(true);
    expect(personalAllows(p({ push: false }), "push", e(), "12:00")).toBe(false);
    // Push off leaves the other channels alone.
    expect(personalAllows(p({ push: false }), "in_app", e(), "12:00")).toBe(true);
  });

  it("one event switched off on push only", () => {
    const own = p({ events: { "conversation.escalated": { push: false } } });
    expect(personalAllows(own, "push", e(), "12:00")).toBe(false);
    expect(personalAllows(own, "email", e(), "12:00")).toBe(true);
    expect(personalAllows(own, "push", e("conversation.assigned"), "12:00")).toBe(true);
  });

  it("quiet hours silence push, including across midnight", () => {
    const night = p({ quietHoursFrom: "22:00", quietHoursTo: "07:00" });
    expect(personalAllows(night, "push", e(), "23:30")).toBe(false);
    expect(personalAllows(night, "push", e(), "06:59")).toBe(false);
    expect(personalAllows(night, "push", e(), "07:00")).toBe(true);
    // The in-app row is still written in quiet hours.
    expect(personalAllows(night, "in_app", e(), "23:30")).toBe(true);
  });

  it("approvals off silences an approval push too", () => {
    expect(personalAllows(p({ approvals: false }), "push", e("tool.approval_required"), "12:00")).toBe(false);
  });
});

describe("★ the push arm of the fan-out", () => {
  it("push is personal: not a workspace rule's channel, never offered by the catalogue", () => {
    expect(DELIVERABLE_CHANNELS).not.toContain("push");
    expect(buildCatalogue().channels).not.toContain("push");
  });

  it("not configured: nothing is looked up or sent, and no failed row is written", async () => {
    unconfigure();
    H.devices = [device("d1", "dana")];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(H.deviceQueries).toBe(0);
    expect(fcmCalls).toHaveLength(0);
    expect(H.logs).toHaveLength(0);
    // The other channels are untouched.
    expect(H.inApp.map((r) => r.userId).sort()).toEqual(["dana", "noa"]);
  });

  it("no registered phone: skipped, no send and no row", async () => {
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(H.deviceQueries).toBe(2); // dana and noa, both looked up
    expect(fcmCalls).toHaveLength(0);
    expect(H.logs).toHaveLength(0);
  });

  it("every phone of that person in that tenant, one log row per phone", async () => {
    H.devices = [device("d1", "dana"), device("d2", "dana"), device("d3", "noa", "OTHER")];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d2"]);
    expect(fcmCalls[0]!.url).toBe("https://fcm.googleapis.com/v1/projects/gotcha-app/messages:send");
    expect(H.logs.map((l) => [l.channel, l.status, l.metadata.deviceId])).toEqual([["push", "sent", "d1"], ["push", "sent", "d2"]]);
    // The token itself is never logged.
    expect(JSON.stringify(H.logs)).not.toContain("tok-d1");
  });

  it("built-in routes: approvals, escalations and assignments push; other events do not", async () => {
    H.devices = [device("d1", "dana"), device("d2", "matan")];
    await processEvent(ev("tool.action_failed", { kind: "crm.update" }));
    expect(fcmCalls).toHaveLength(0);
    await processEvent(ev("conversation.assigned", {}, { conversationId: "c9", userId: "matan" }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d2"]);
    expect(fcmCalls[0]!.body.message.data.link).toBe("/m/inbox/c9");
    await processEvent(ev("tool.approval_required", { approvalRequestId: "a1" }, { conversationId: "c9" }));
    expect(fcmCalls.at(-1)!.body.message.data.link).toBe("/m/approvals");
  });

  it("the in-app row keeps its web link; only push carries the mobile one", async () => {
    H.devices = [device("d1", "matan")];
    await processEvent(ev("conversation.assigned", {}, { conversationId: "c9", userId: "matan" }));
    expect(H.inApp[0].link).toBe("/inbox?c=c9");
    expect(fcmCalls[0]!.body.message.data.link).toBe("/m/inbox/c9");
  });

  it("push is added for everyone a workspace rule reaches, whatever the rule's channels", async () => {
    H.rules = [rule("conversation.escalated", ["in_app"])];
    H.devices = [device("d1", "dana")];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
    expect(H.emails).toHaveLength(0); // the rule's own channels still decide the rest
  });

  it("the person's own push switch is the way to turn it off", async () => {
    H.devices = [device("d1", "dana"), device("d2", "noa")];
    H.personal = [{ userId: "dana", push: false }];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d2"]);
  });

  it("quiet hours: no push, the in-app row is still written", async () => {
    H.timezone = "Asia/Jerusalem"; // 12:00 UTC = 14:00 local
    H.personal = [{ userId: "dana", quietHoursFrom: "13:00", quietHoursTo: "15:00" }];
    H.devices = [device("d1", "dana"), device("d2", "noa")];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c1" }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d2"]);
    expect(H.inApp.map((r) => r.userId).sort()).toEqual(["dana", "noa"]);
  });
});

describe("★ message.inbound: push only, the assignee only", () => {
  const inbound = (data: Record<string, unknown> = {}) =>
    ev("message.inbound", { conversationId: "c7", assignedAgentId: "matan", messageId: `m${seq}`, preview: "Is it in stock?", previewKind: "text", messageType: "text", channel: "WHATSAPP", customerName: "Omer", ...data }, { conversationId: "c7", userId: "matan" });

  it("reaches the assignee's phone, with no in-app row and no email", async () => {
    H.devices = [device("d1", "matan"), device("d2", "dana")];
    await processEvent(inbound());
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
    expect(fcmCalls[0]!.body.message.notification).toEqual({ title: "New message from Omer", body: "Is it in stock?" });
    expect(H.inApp).toHaveLength(0);
    expect(H.emails).toHaveLength(0);
  });

  it("a workspace rule for it cannot widen the audience or add channels", async () => {
    H.rules = [rule("message.inbound", ["in_app", "email", "push"])];
    H.devices = [device("d1", "matan"), device("d2", "dana")];
    await processEvent(inbound());
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
    expect(H.inApp).toHaveLength(0);
    expect(H.emails).toHaveLength(0);
  });

  it("two identical messages are two pushes (the message id defeats the dedup)", async () => {
    H.devices = [device("d1", "matan")];
    await processEvent(inbound({ preview: "ok", messageId: "m1" }));
    await processEvent(inbound({ preview: "ok", messageId: "m2" }));
    expect(fcmCalls).toHaveLength(2);
  });

  it("a photo with no caption is named in the reader's words", async () => {
    H.devices = [device("d1", "matan")];
    await processEvent(inbound({ preview: "[Image]", previewKind: "media", messageType: "image" }));
    expect(fcmCalls[0]!.body.message.notification.body).toBe("Photo");
  });

});

describe("★ message.inbound in the team's queue (handed over, nobody assigned; 2026-11-03)", () => {
  const queued = (departmentId?: string, data: Record<string, unknown> = {}) => ({
    ...ev("message.inbound", { conversationId: "c7", assignedAgentId: null, messageId: `m${seq}`, preview: "Still there?", previewKind: "text", messageType: "text", channel: "WEBCHAT", customerName: "Omer", ...data }, { conversationId: "c7" }),
    ...(departmentId ? { departmentId } : {}),
  }) as SystemEvent;

  it("everyone in the workspace who can read conversations, push only (an agent too, not just the admins)", async () => {
    H.devices = [device("d1", "dana"), device("d2", "noa"), device("d3", "matan")];
    await processEvent(queued());
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d2", "tok-d3"]);
    expect(fcmCalls[0]!.body.message.data.link).toBe("/m/inbox/c7");
    expect(H.inApp).toHaveLength(0);
    expect(H.emails).toHaveLength(0);
  });

  it("a department set: still everyone who can open it, not only its members", async () => {
    H.conversations = [{ id: "c7", tenantId: "T", departmentId: "sales", assignedAgentId: null }];
    H.members = [{ tenantId: "T", departmentId: "sales", userId: "matan" }];
    H.devices = [device("d1", "dana"), device("d2", "noa"), device("d3", "matan")];
    await processEvent(queued("sales"));
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d2", "tok-d3"]);
  });

  it("★ the visibility rule: an agent of another department holds the read permission and gets nothing", async () => {
    H.conversations = [{ id: "c7", tenantId: "T", departmentId: "sales", assignedAgentId: null }];
    H.users.push({ id: "yael", tenantId: "T", role: "AGENT", isActive: true, email: "y@x.test", name: "yael", notificationSoundEnabled: true });
    H.members = [
      { tenantId: "T", departmentId: "sales", userId: "matan" },   // eligible: the chat's department
      { tenantId: "T", departmentId: "support", userId: "yael" },  // another department
    ];
    H.devices = [device("d3", "matan"), device("y1", "yael"), device("d1", "dana")];
    await processEvent(queued("sales"));
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d3"]);
    // Only the restricted viewers were looked up; the admins are unrestricted by the rule.
    expect(H.viewChecks.sort()).toEqual(["matan", "yael"]);
  });

  it("★ a department-scoped agent's view of a chat with no department: visible (the rule's own answer)", async () => {
    H.members = [{ tenantId: "T", departmentId: "support", userId: "matan" }];
    H.devices = [device("d3", "matan")];
    await processEvent(queued());
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d3"]);
  });

  it("the earliest department is the one that counts, as in the auth principal", async () => {
    H.conversations = [{ id: "c7", tenantId: "T", departmentId: "sales", assignedAgentId: null }];
    H.members = [
      { tenantId: "T", departmentId: "support", userId: "matan" },
      { tenantId: "T", departmentId: "sales", userId: "matan" },
    ];
    H.devices = [device("d3", "matan")];
    await processEvent(queued("sales"));
    expect(fcmCalls).toHaveLength(0);
  });

  it("no conversation id on the event: nobody, not even the admins", async () => {
    H.devices = [device("d1", "dana")];
    await processEvent(ev("message.inbound", { assignedAgentId: null, messageId: "mx", preview: "hi" }, {}));
    expect(fcmCalls).toHaveLength(0);
  });

  it("a conversation the rule cannot find (another tenant's id): restricted viewers get nothing", async () => {
    H.conversations = [{ id: "c7", tenantId: "OTHER", departmentId: "sales", assignedAgentId: null }];
    H.members = [{ tenantId: "T", departmentId: "sales", userId: "matan" }];
    H.devices = [device("d3", "matan")];
    await processEvent(queued("sales"));
    expect(fcmCalls).toHaveLength(0);
  });

  it("not a support principal, not an inactive user, not someone who cannot read conversations, not another workspace", async () => {
    H.users.push(
      { id: "support-actor", tenantId: "T", role: "ADMIN", kind: "support", isActive: true, email: "s@x.test", name: "s", notificationSoundEnabled: true },
      { id: "gone", tenantId: "T", role: "AGENT", isActive: false, email: "g@x.test", name: "g", notificationSoundEnabled: true },
      { id: "viewer", tenantId: "T", role: "AGENT", isActive: true, email: "v@x.test", name: "v", notificationSoundEnabled: true },
      { id: "other", tenantId: "OTHER", role: "ADMIN", isActive: true, email: "o@x.test", name: "o", notificationSoundEnabled: true },
    );
    H.cannotRead = new Set(["viewer"]);
    H.devices = [device("d1", "dana"), device("s1", "support-actor"), device("g1", "gone"), device("v1", "viewer"), device("o1", "other", "OTHER")];
    await processEvent(queued());
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
  });

  it("the permission check failing leaves people out rather than in", async () => {
    H.permissionDown = true;
    H.devices = [device("d1", "dana")];
    await processEvent(queued());
    expect(fcmCalls).toHaveLength(0);
  });

  it("a workspace rule (for this event or for escalations) does not narrow or widen it", async () => {
    H.rules = [rule("conversation.escalated", ["in_app", "email"], { type: "users", userIds: ["matan"] }), rule("message.inbound", ["email"], { type: "users", userIds: ["noa"] })];
    H.devices = [device("d1", "dana"), device("d2", "noa"), device("d3", "matan")];
    await processEvent(queued());
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d2", "tok-d3"]);
    expect(H.emails).toHaveLength(0);
  });

  it("each person's own switches still hold: push off, the event off, quiet hours", async () => {
    H.timezone = "Asia/Jerusalem"; // 14:00 local
    for (const id of ["omer", "ron"]) H.users.push({ id, tenantId: "T", role: "ADMIN", isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
    H.personal = [
      { userId: "dana", push: false },
      { userId: "noa", quietHoursFrom: "13:00", quietHoursTo: "15:00" },
      { userId: "ron", events: { "message.inbound": { push: false } } },
    ];
    H.devices = [device("d1", "dana"), device("d2", "noa"), device("d4", "omer"), device("d5", "ron")];
    await processEvent(queued());
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d4"]);
  });

  it("a burst stays one notification per phone: every push of the conversation shares its collapse id", async () => {
    H.devices = [device("d1", "dana")];
    await processEvent(queued(undefined, { messageId: "m-a", preview: "hello?" }));
    await processEvent(queued(undefined, { messageId: "m-b", preview: "anyone?" }));
    expect(fcmCalls).toHaveLength(2);
    expect(new Set(fcmCalls.map((c) => c.body.message.android.collapse_key))).toEqual(new Set(["c7"]));
  });

  it("assigned: the assignee only, even with an escalation rule", async () => {
    H.rules = [rule("conversation.escalated", ["in_app"])];
    H.devices = [device("d1", "dana"), device("d3", "matan")];
    await processEvent(queued(undefined, { assignedAgentId: "matan" }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d3"]);
  });
});

describe("★ the FCM message", () => {
  it("collapses per conversation on both platforms", () => {
    const m = buildFcmMessage({ token: "t", title: "T", body: "B", link: "/m/inbox/c1", eventType: "message.inbound", conversationId: "c1" }).message;
    expect(m.android.collapse_key).toBe("c1");
    expect(m.apns.headers).toEqual({ "apns-collapse-id": "c1" });
    expect(m.apns.payload.aps["thread-id"]).toBe("c1");
    expect(m.data).toEqual({ eventType: "message.inbound", link: "/m/inbox/c1", conversationId: "c1" });
    expect(m.notification).toEqual({ title: "T", body: "B" });
  });

  it("no conversation: no collapse ids", () => {
    const m = buildFcmMessage({ token: "t", title: "T", body: "B", eventType: "tool.approval_required" }).message;
    expect(m.android).not.toHaveProperty("collapse_key");
    expect(m.apns.headers).toEqual({});
    expect(m.apns.payload.aps).not.toHaveProperty("thread-id");
  });

  it("deep links: conversations to /m/inbox/<id>, approvals to /m/approvals", () => {
    expect(mobileLink({ type: "conversation.escalated", data: {}, metadata: { conversationId: "c 1" } as any })).toBe("/m/inbox/c%201");
    expect(mobileLink({ type: "message.inbound", data: { conversationId: "c2" }, metadata: {} as any })).toBe("/m/inbox/c2");
    expect(mobileLink({ type: "tool.approval_required", data: {}, metadata: { conversationId: "c3" } as any })).toBe("/m/approvals");
  });
});

describe("★ dead tokens", () => {
  it("UNREGISTERED, 404 and INVALID_ARGUMENT are dead; a 500 or quota error is not", () => {
    expect(isDeadToken(404, {})).toBe(true);
    expect(isDeadToken(400, { error: { status: "INVALID_ARGUMENT" } })).toBe(true);
    expect(isDeadToken(400, { error: { status: "FAILED_PRECONDITION", details: [{ errorCode: "UNREGISTERED" }] } })).toBe(true);
    expect(isDeadToken(500, { error: { status: "INTERNAL" } })).toBe(false);
    expect(isDeadToken(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } })).toBe(false);
  });

  it("a dead token's row is deleted; a phone that hit a server error is kept", async () => {
    H.devices = [device("dead", "dana"), device("gone", "dana"), device("flaky", "dana"), device("fine", "dana")];
    fcmReply = (token) => {
      if (token === "tok-dead") return { status: 404, json: { error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } };
      if (token === "tok-gone") return { status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } } };
      if (token === "tok-flaky") return { status: 503, json: { error: { code: 503, status: "UNAVAILABLE" } } };
      return { status: 200, json: {} };
    };
    const out = await sendPushToUser({ user: { id: "dana", tenantId: "T", email: "dana@x.test" }, event: ev("conversation.escalated", {}, { conversationId: "c1" }), tpl: { title: "T", body: "B" } });
    expect(out).toEqual({ status: "sent", sent: 1, failed: 3, removed: 2, skipped: 0 });
    expect(H.devices.map((d) => d.id).sort()).toEqual(["fine", "flaky"]);
    expect(H.logs.filter((l) => l.status === "failed").map((l) => l.metadata.deviceId).sort()).toEqual(["dead", "flaky", "gone"]);
  });
});

describe("★ the Google access token", () => {
  it("escaped newlines in FCM_PRIVATE_KEY are restored; any missing var means not configured", () => {
    expect(fcmConfig()!.privateKey).toBe(PEM.trim());
    expect(fcmConfig({ FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e" } as any)).toBeNull();
    expect(fcmConfig({ FCM_PROJECT_ID: "p", FCM_PRIVATE_KEY: "k" } as any)).toBeNull();
  });

  it("the assertion is RS256-signed by the service account, for the FCM scope", () => {
    const jwt = signAssertion(fcmConfig()!, 1_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      iss: "push@gotcha-app.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000_000,
      exp: 1_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });

  it("is fetched once and reused until shortly before it expires", async () => {
    H.devices = [device("d1", "dana")];
    const send = () => sendPushToUser({ user: { id: "dana", tenantId: "T" }, event: ev("conversation.escalated"), tpl: { title: "T", body: "B" } });
    await send();
    await send();
    expect(oauthCalls).toBe(1);
    expect(fcmCalls.every((c) => c.auth === "Bearer at-1")).toBe(true);
    vi.setSystemTime(new Date("2026-11-03T12:59:30Z")); // 30s before expiry
    await send();
    expect(oauthCalls).toBe(2);
    expect(fcmCalls.at(-1)!.auth).toBe("Bearer at-2");
  });
});

describe("★ conversation.waiting: push only while nobody is assigned", () => {
  const waiting = (data: Record<string, unknown>) =>
    ev("conversation.waiting", { conversationId: "c1", channel: "WHATSAPP", waitingSince: "2026-11-03T11:40:00Z", minutes: 20, departmentId: null, ...data }, { conversationId: "c1" });

  it("the guard: an assignee means no push", () => {
    expect(skipPushForAssignedWaiting({ type: "conversation.waiting", data: { assignedAgentId: "matan" } })).toBe(true);
    expect(skipPushForAssignedWaiting({ type: "conversation.waiting", data: { assignedAgentId: null } })).toBe(false);
    expect(skipPushForAssignedWaiting({ type: "conversation.escalated", data: { assignedAgentId: "matan" } })).toBe(false);
  });

  it("unassigned: pushed to its normal recipients, opening /m/inbox/<id>", async () => {
    H.devices = [device("d1", "dana"), device("d2", "matan"), device("d3", "noa")];
    await processEvent(waiting({ assignedAgentId: null, recipientUserIds: ["dana", "matan"] }));
    expect(fcmCalls.map((c) => c.body.message.token).sort()).toEqual(["tok-d1", "tok-d2"]);
    expect(fcmCalls[0]!.body.message.data.link).toBe("/m/inbox/c1");
    expect(fcmCalls[0]!.body.message.android.collapse_key).toBe("c1");
  });

  it("unassigned with no department: the admins", async () => {
    H.devices = [device("d1", "dana"), device("d2", "matan")];
    await processEvent(waiting({ assignedAgentId: null, recipientUserIds: [] }));
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
  });

  it("assigned: no push (the assignee hears every message already); in-app and email still go", async () => {
    H.devices = [device("d2", "matan")];
    await processEvent(waiting({ assignedAgentId: "matan", recipientUserIds: ["matan"] }));
    expect(fcmCalls).toHaveLength(0);
    expect(H.inApp.map((r) => r.userId)).toEqual(["matan"]);
    expect(H.emails.map((e) => e.to)).toEqual(["matan@x.test"]);
  });
});

describe("★ iOS straight to Apple (APNs)", () => {
  beforeEach(() => configureApns());
  const send = (event = ev("conversation.escalated", {}, { conversationId: "c1" })) =>
    sendPushToUser({ user: { id: "dana", tenantId: "T" }, event, tpl: { title: "T", body: "B" } });

  it("config: escaped newlines restored, bundle id defaulted, production unless APNS_ENV=sandbox", () => {
    const cfg = apnsConfig()!;
    expect(cfg.privateKey).toBe(P8.trim());
    expect(cfg.bundleId).toBe("il.co.gotcha.app");
    expect(cfg.host).toBe(APNS_HOSTS.production);
    expect(apnsConfig({ ...process.env, APNS_ENV: "sandbox", APNS_BUNDLE_ID: "x.y" })).toMatchObject({ host: "https://api.sandbox.push.apple.com", bundleId: "x.y" });
    expect(apnsConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t" } as any)).toBeNull();
  });

  it("the provider token is ES256 with kid = key id and iss = team id", () => {
    const jwt = signApnsJwt(apnsConfig()!, 1_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123ABCD" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ iss: "TEAM456EFG", iat: 1_000_000 });
    // JWS wants raw r||s (64 bytes), not DER.
    expect(Buffer.from(sig!, "base64url")).toHaveLength(64);
    expect(cryptoVerify("sha256", Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("headers and payload: topic, alert, priority 10, collapse and thread per conversation, the mobile link", async () => {
    H.devices = [iphone("p1", "dana")];
    await send();
    expect(A.connects).toEqual(["https://api.push.apple.com"]);
    const { headers, body } = A.requests[0]!;
    expect(headers).toMatchObject({
      ":method": "POST", ":path": "/3/device/a1b2p1",
      "apns-topic": "il.co.gotcha.app", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "c1",
    });
    expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body).toEqual({ aps: { alert: { title: "T", body: "B" }, sound: "default", "thread-id": "c1" }, link: "/m/inbox/c1" });
    expect(fcmCalls).toHaveLength(0); // an iPhone never goes through FCM
    expect(H.logs[0]).toMatchObject({ channel: "push", status: "sent", metadata: { deviceId: "p1", provider: "apns" } });
  });

  it("apns-collapse-id is cut to 64 bytes, never mid-character", () => {
    expect(collapseId("c".repeat(80))).toHaveLength(64);
    const cut = collapseId("א".repeat(40)); // 2 bytes each
    expect(Buffer.byteLength(cut)).toBe(64);
    expect(collapseId("c1")).toBe("c1");
    const { headers, payload } = buildApnsRequest(apnsConfig()!, { token: "t", title: "T", body: "B", jwt: "j" });
    expect(headers).not.toHaveProperty("apns-collapse-id");
    expect(payload).toEqual({ aps: { alert: { title: "T", body: "B" }, sound: "default" } });
  });

  it("the provider token is reused for ~50 minutes, then signed again", async () => {
    H.devices = [iphone("p1", "dana")];
    await send();
    vi.setSystemTime(new Date("2026-11-03T12:49:00Z"));
    await send();
    vi.setSystemTime(new Date("2026-11-03T12:51:00Z"));
    await send();
    const auth = A.requests.map((r) => r.headers.authorization);
    expect(auth[0]).toBe(auth[1]);
    expect(auth[2]).not.toBe(auth[1]);
  });

  it("Apple refusing our provider token: signed afresh once, and sent", async () => {
    H.devices = [iphone("p1", "dana")];
    A.reply = (_t, n) => (n === 1 ? { status: 403, body: { reason: "ExpiredProviderToken" } } : { status: 200 });
    const out = await send();
    expect(out).toMatchObject({ sent: 1, failed: 0 });
    expect(A.requests).toHaveLength(2);
  });

  it("410 Unregistered and 400 BadDeviceToken delete the row; other failures keep it", async () => {
    H.devices = [iphone("gone", "dana"), iphone("bad", "dana"), iphone("big", "dana"), iphone("down", "dana"), iphone("ok", "dana")];
    A.reply = (token) => {
      if (token === "a1b2gone") return { status: 410, body: { reason: "Unregistered", timestamp: 1 } };
      if (token === "a1b2bad") return { status: 400, body: { reason: "BadDeviceToken" } };
      if (token === "a1b2big") return { status: 413, body: { reason: "PayloadTooLarge" } };
      if (token === "a1b2down") return { status: 503, body: { reason: "ServiceUnavailable" } };
      return { status: 200 };
    };
    const out = await send();
    expect(out).toEqual({ status: "sent", sent: 1, failed: 4, removed: 2, skipped: 0 });
    expect(H.devices.map((d) => d.id).sort()).toEqual(["big", "down", "ok"]);
    expect(H.logs.find((l) => l.metadata.deviceId === "gone").error).toBe("APNs 410 Unregistered (device removed)");
    expect(isDeadApnsToken(400, "BadTopic")).toBe(false);
  });

  it("one person, two phones: the Android through FCM, the iPhone through APNs", async () => {
    H.devices = [device("d1", "dana"), iphone("p1", "dana")];
    const out = await send();
    expect(out).toMatchObject({ sent: 2, skipped: 0 });
    expect(fcmCalls.map((c) => c.body.message.token)).toEqual(["tok-d1"]);
    expect(A.requests.map((r) => r.headers[":path"])).toEqual(["/3/device/a1b2p1"]);
  });

  it("APNs not configured: the iPhone is skipped without a row, the Android still gets it", async () => {
    unconfigureApns();
    H.devices = [device("d1", "dana"), iphone("p1", "dana")];
    const out = await send();
    expect(out).toEqual({ status: "sent", sent: 1, failed: 0, removed: 0, skipped: 1 });
    expect(A.requests).toHaveLength(0);
    expect(H.logs.map((l) => l.metadata.deviceId)).toEqual(["d1"]);
  });

  it("FCM not configured: the Android is skipped, the iPhone still gets it", async () => {
    unconfigure();
    H.devices = [device("d1", "dana"), iphone("p1", "dana")];
    const out = await send();
    expect(out).toEqual({ status: "sent", sent: 1, failed: 0, removed: 0, skipped: 1 });
    expect(fcmCalls).toHaveLength(0);
    expect(A.requests).toHaveLength(1);
  });

  it("through the fan-out: an escalation reaches the admin's iPhone", async () => {
    H.devices = [iphone("p1", "dana")];
    await processEvent(ev("conversation.escalated", {}, { conversationId: "c5" }));
    expect(A.requests.map((r) => r.body.link)).toEqual(["/m/inbox/c5"]);
  });
});
