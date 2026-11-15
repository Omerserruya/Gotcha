/**
 * A manager's tap on an approval sent from GOTCHA's own number is answered
 * from the number in effect (2026-11-15): the console's when connected, else
 * the env pair, else nobody. Never the workspace's number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ platform: null as any, sent: [] as any[], primaryAsked: 0 }));
vi.mock("@chatcenter/shared", () => ({
  prisma: { approvalRequest: { findFirst: async () => ({ id: "apr1", status: "APPROVED", tool: "t", expiresAt: null }) } },
  isApprovalRef: () => true,
  consumeApprovalRef: async () => ({ tenantId: "T", approvalId: "apr1", recipientUserId: "boss", decision: "approve", tool: "t" }),
  userMayApprove: async () => true,
  approveRequest: async () => undefined,
  rejectRequest: async () => undefined,
  revokeApprovalRefs: async () => undefined,
  decryptCredentials: () => ({}),
  resolvePrimaryWhatsAppAccount: async () => { H.primaryAsked++; return { account: { externalId: "pn_workspace", credentials: "x" } }; },
  resolvePlatformWhatsAppSender: async () => H.platform,
  getOutboundAdapter: () => ({ sendTextMessage: async (c: any, from: string, to: string, text: string) => { H.sent.push({ token: c.accessToken, from, to, text }); } }),
}));

import { handleApprovalButtonReply } from "../services/whatsapp-approval-inbound.service";

beforeEach(() => { H.platform = null; H.sent = []; H.primaryAsked = 0; vi.spyOn(console, "warn").mockImplementation(() => undefined); });

describe("the reply to a tap on GOTCHA's number", () => {
  it("from the console's number when it is the one in effect", async () => {
    H.platform = { externalId: "pn_console", accessToken: "tok_db", wabaId: "w", source: "db" };
    await handleApprovalButtonReply("ref", "972500000001", { viaPlatform: true });
    expect(H.sent).toEqual([{ token: "tok_db", from: "pn_console", to: "972500000001", text: "This request was already approved. No action taken." }]);
    expect(H.primaryAsked).toBe(0);
  });
  it("no platform number at all: no reply, and never the workspace's number", async () => {
    await handleApprovalButtonReply("ref", "972500000001", { viaPlatform: true });
    expect(H.sent).toEqual([]);
    expect(H.primaryAsked).toBe(0);
  });
  it("a tap on the workspace's number is still answered from it", async () => {
    H.platform = { externalId: "pn_console", accessToken: "tok_db", wabaId: "w", source: "db" };
    await handleApprovalButtonReply("ref", "972500000001", {});
    expect(H.sent[0].from).toBe("pn_workspace");
  });
});
