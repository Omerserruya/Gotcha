/**
 * A workspace with exactly one human member (Omer, 2026-11-15): every
 * automated handoff to a person is assigned to them; with two or more, the
 * queue as today. The predicate is the one /auth/me reads too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../prisma", () => ({ prisma: {} }));
import { soleHumanMember, assignSoleMemberOnHandoff } from "../sole-member";

type U = { id: string; tenantId: string; kind: string; isActive: boolean };
let users: U[] = [];
let convs: any[] = [];
const matches = (row: any, where: any): boolean => Object.entries(where).every(([k, v]: [string, any]) => {
  if (k === "NOT") return !String(row.customerExternalId).startsWith(v.customerExternalId.startsWith);
  return row[k] === v;
});
const db = {
  user: { findMany: vi.fn(async (a: any) => users.filter((u) => matches(u, a.where)).slice(0, a.take).map((u) => ({ id: u.id }))) },
  conversation: {
    updateMany: vi.fn(async (a: any) => {
      const hit = convs.filter((c) => matches(c, a.where));
      hit.forEach((c) => Object.assign(c, a.data));
      return { count: hit.length };
    }),
  },
};
const conv = (o: any = {}) => ({ id: "c1", tenantId: "T", assignedAgentId: null, isTest: false, customerExternalId: "972500000001", status: "WAITING", ...o });

beforeEach(() => {
  users = [{ id: "owner", tenantId: "T", kind: "member", isActive: true }];
  convs = [conv()];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("who counts", () => {
  it("one active member: that member", async () => {
    expect(await soleHumanMember("T", db)).toBe("owner");
  });
  it("the support-mode user, a deactivated member, another workspace's member: not counted", async () => {
    users.push({ id: "support", tenantId: "T", kind: "support", isActive: true });
    users.push({ id: "gone", tenantId: "T", kind: "member", isActive: false });
    users.push({ id: "other", tenantId: "X", kind: "member", isActive: true });
    expect(await soleHumanMember("T", db)).toBe("owner");
  });
  it("two active members, or none: null", async () => {
    users.push({ id: "second", tenantId: "T", kind: "member", isActive: true });
    expect(await soleHumanMember("T", db)).toBeNull();
    users = [];
    expect(await soleHumanMember("T", db)).toBeNull();
    expect(await soleHumanMember("", db)).toBeNull();
  });
});

describe("the handoff", () => {
  it("assigns the one member and WAITING becomes OPEN", async () => {
    expect(await assignSoleMemberOnHandoff("T", "c1", db)).toBe("owner");
    expect(convs[0]).toMatchObject({ assignedAgentId: "owner", status: "OPEN" });
  });
  it("an OPEN conversation stays OPEN (a phone takeover)", async () => {
    convs = [conv({ status: "OPEN" })];
    await assignSoleMemberOnHandoff("T", "c1", db);
    expect(convs[0]).toMatchObject({ assignedAgentId: "owner", status: "OPEN" });
  });
  it("never over an assignee, never a test or sandbox conversation", async () => {
    convs = [conv({ assignedAgentId: "someone" }), conv({ id: "c2", isTest: true }), conv({ id: "c3", customerExternalId: "sandbox:abc" })];
    for (const id of ["c1", "c2", "c3"]) expect(await assignSoleMemberOnHandoff("T", id, db)).toBeNull();
    expect(convs.map((c) => c.assignedAgentId)).toEqual(["someone", null, null]);
    expect(convs.every((c) => c.status === "WAITING")).toBe(true);
  });
  it("two members: nothing changes, the queue as today", async () => {
    users.push({ id: "second", tenantId: "T", kind: "member", isActive: true });
    expect(await assignSoleMemberOnHandoff("T", "c1", db)).toBeNull();
    expect(convs[0]).toMatchObject({ assignedAgentId: null, status: "WAITING" });
  });
  it("a database error never throws: the handoff stands", async () => {
    const broken = { ...db, user: { findMany: async () => { throw new Error("down"); } } };
    expect(await assignSoleMemberOnHandoff("T", "c1", broken as any)).toBeNull();
  });
});

describe("every automated handoff calls it", () => {
  const root = join(__dirname, "../../../../../");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  it("bot escalation (all channels), web chat and Shopify chat, phone takeover, owner-recent, automation, approval expiry", () => {
    const sites: Array<[string, RegExp]> = [
      ["services/incoming-worker/src/services/ai-bot.service.ts", /reason: "escalation",[\s\S]{0,120}\}\);\n[\s\S]{0,120}const soleMember = await assignSoleMemberOnHandoff\(tenantId, conversationId\);/],
      ["services/ai/src/routes/embedded-chat.ts", /assignSoleMemberOnHandoff\(conv\.tenantId, conv\.id\)/],
      ["services/ai/src/routes/shopify-chat-public.ts", /assignSoleMemberOnHandoff\(session\.tenantId, conversation\.id\)[\s\S]*assignSoleMemberOnHandoff\(session\.tenantId, conversation\.id\)/],
      ["services/incoming-worker/src/services/outbound-echo.service.ts", /aiWasDriving \|\| createdConversation \? await assignSoleMemberOnHandoff\(tenantId, conversation\.id\)/],
      ["services/incoming-worker/src/workers/incoming.worker.ts", /starts human-owned`\);[\s\S]{0,200}assignSoleMemberOnHandoff\(tenantId, openedId\)/],
      ["services/incoming-worker/src/services/flow-executor.service.ts", /if \(!data\.assignedAgentId\) \{[\s\S]{0,200}assignSoleMemberOnHandoff\(ctx\.tenantId, ctx\.conversationId\)/],
      ["services/incoming-worker/src/services/automation-runner.service.ts", /if \(data\.status === "WAITING"\) \{[\s\S]{0,250}assignSoleMemberOnHandoff\(tenantId, conversationId\)/],
      ["services/incoming-worker/src/workers/idle-conversation.worker.ts", /isHandedOver: true \},\n\s+\}\);\n[\s\S]{0,120}assignSoleMemberOnHandoff\(ar\.tenantId, ar\.conversationId\)/],
    ];
    for (const [file, re] of sites) expect(read(file), file).toMatch(re);
  });
  it("/auth/me says soleHuman from the same predicate", () => {
    expect(read("services/auth/src/routes/auth.ts")).toMatch(/const soleHuman = await Promise\.resolve\(\)\.then\(\(\) => soleHumanMember\(user\.tenantId\)\)\.then\(\(id\) => id !== null\)/);
    expect(read("services/auth/src/routes/auth.ts")).toContain("...(soleHuman === null ? {} : { workspace: { soleHuman } }),");
  });
});
