/**
 * An Instagram customer's contact gets their name, or @username, never stays
 * nameless (2026-10-11: the Customers list showed "1031990639501705").
 * Instagram sends no name with the message; the worker fetched the profile
 * but wrote only the avatar to the contact. Through dispatch().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  contact: null as any,
  contactUpdates: [] as any[],
  profile: {} as Record<string, unknown>,
  sameName: vi.fn(async () => ({ suggested: 0 })),
}));
const prisma = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
  message: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ id: "m1", createdAt: new Date(), ...a.data })), count: vi.fn(async () => 1) },
  conversation: {
    findFirst: vi.fn(async () => ({ id: "c1", tenantId: "t1", channel: "INSTAGRAM", customerExternalId: "1031990639501705", status: "OPEN", customerName: null, customerAvatarUrl: null, assignedAgentId: null, isHandedOver: false })),
    update: vi.fn(async () => ({})),
  },
  channelAccount: { findUnique: vi.fn(async () => ({ id: "ca1", externalId: "1784", credentials: "enc" })) },
  contact: { update: vi.fn(async (a: any) => { H.contactUpdates.push(a); return {}; }), updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
}));
vi.mock("axios", () => ({ default: { get: vi.fn(async () => ({ data: H.profile })), head: vi.fn(), post: vi.fn(async () => ({ data: {} })) } }));
vi.mock("@chatcenter/shared", () => ({
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma,
  getRedis: () => ({ set: async () => "OK", del: async () => 1 }),
  suggestBySameName: H.sameName,
  publishEvent: vi.fn(async () => undefined),
  isInboundExcluded: vi.fn(async () => false),
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  decryptCredentials: vi.fn(() => ({ accessToken: "TOKEN", igLogin: true })),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  resolveContactByChannelId: vi.fn(async () => null),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn(async () => ({ handled: false })) }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));
vi.mock("../services/ensure-contact.service", () => ({ ensureContactForInbound: vi.fn(async () => H.contact) }));
vi.mock("../services/locale-detect.service", () => ({ recordDetectedLocaleIfMissing: vi.fn(async () => undefined) }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn(async () => undefined) }));
vi.mock("../services/whatsapp-handoff-link.service", () => ({ linkWebsiteHandoff: vi.fn(async () => ({ linked: false })) }));
vi.mock("../services/automation-runner.service", () => ({ automationsForInbound: vi.fn(async () => true), automationAnsweredBefore: vi.fn(async () => false) }));
vi.mock("../services/ai-bot.service", () => ({ processAIBot: vi.fn(async () => true) }));
vi.mock("../services/routing.service", () => ({ routeConversation: vi.fn(async () => ({ handledByAI: true })) }));
vi.mock("../services/flow-executor.service", () => ({ executeMainFlow: vi.fn(), executeSubFlow: vi.fn() }));

import { dispatch } from "../workers/incoming.worker";

const dm = () => ({
  id: `j${Math.random()}`, name: "process",
  data: { tenantId: "t1", channel: "INSTAGRAM", channelAccountId: "ca1",
    normalizedMessage: { externalMessageId: `mid${Math.random()}`, senderId: "1031990639501705", body: "hi", messageType: "text", timestamp: new Date().toISOString() } },
}) as any;

const contactWrite = () => H.contactUpdates.find((u) => u.where.id === "k1")?.data ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  H.contactUpdates = [];
  H.contact = { id: "k1", displayName: null, avatarUrl: null, metadata: { source: "inbound" } };
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the Instagram customer's contact is named from the profile", () => {
  it("name present: the contact gets the name, the handle kept in metadata, the avatar too", async () => {
    H.profile = { name: "Omer Tsruya", username: "omer.ts", profile_pic: "https://cdn/p.jpg" };
    await dispatch(dm());
    expect(contactWrite()).toEqual({
      avatarUrl: "https://cdn/p.jpg",
      displayName: "Omer Tsruya",
      metadata: { source: "inbound", instagramUsername: "omer.ts" },
    });
    // A newly named contact is checked for a same-name customer elsewhere: a
    // suggestion, never a link (shared lib/identity-links).
    expect(H.sameName).toHaveBeenCalledWith({ tenantId: "t1", contactId: "k1", displayName: "Omer Tsruya", channel: "INSTAGRAM" });
  });

  it("no name: @username, never the IGSID", async () => {
    H.profile = { username: "omer.ts" };
    await dispatch(dm());
    expect(contactWrite()).toMatchObject({ displayName: "@omer.ts", metadata: { instagramUsername: "omer.ts" } });
    expect(JSON.stringify(contactWrite())).not.toContain("1031990639501705");
  });

  it("a name the contact already has (set by hand) is never overwritten", async () => {
    H.contact = { id: "k1", displayName: "Omer (VIP)", avatarUrl: "a", metadata: { instagramUsername: "omer.ts" } };
    H.profile = { name: "Omer Tsruya", username: "omer.ts", profile_pic: "https://cdn/p.jpg" };
    await dispatch(dm());
    expect(contactWrite()).toBeNull();
    expect(H.sameName).not.toHaveBeenCalled();
  });

  it("a profile that cannot be read changes nothing", async () => {
    H.profile = {};
    await dispatch(dm());
    expect(contactWrite()).toBeNull();
  });
});
