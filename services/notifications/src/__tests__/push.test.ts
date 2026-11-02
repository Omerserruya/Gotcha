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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "crypto";

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
  dedup: new Set<string>(),
}));

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  prisma: {
    notificationPreference: { findMany: async (a: any) => H.rules.filter((r) => r.tenantId === a.where.tenantId && r.eventType === a.where.eventType) },
    user: {
      findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.isActive
        && (a.where.role ? u.role === a.where.role : true)
        && (a.where.id?.in ? a.where.id.in.includes(u.id) : true)),
    },
    departmentMember: { findMany: async () => [] },
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
import type { SystemEvent } from "../services/event-emitter.service";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
  H.rules = []; H.personal = []; H.timezone = null; H.inApp = []; H.emails = []; H.devices = []; H.logs = []; H.deviceQueries = 0; H.dedup = new Set();
  const u = (id: string, role: string, tenantId = "T") => ({ id, tenantId, role, isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
  H.users = [u("dana", "ADMIN"), u("noa", "ADMIN"), u("matan", "AGENT")];
  fcmReply = () => ({ status: 200, json: { name: "projects/p/messages/1" } });
  resetPushSenderState();
  configure();
  installFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); unconfigure(); });

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

  it("no assignee in the payload: no one", async () => {
    H.devices = [device("d1", "matan")];
    await processEvent(ev("message.inbound", { conversationId: "c7", preview: "hi" }, { conversationId: "c7" }));
    expect(fcmCalls).toHaveLength(0);
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
    expect(out).toEqual({ status: "sent", sent: 1, failed: 3, removed: 2 });
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
