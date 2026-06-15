import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    conversation: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === "missing" ? null : { id: "conv1", tenantId: "t1" },
      ),
    },
    message: {
      findMany: vi.fn(async () => [
        { id: "m2", direction: "OUTBOUND", body: "hi", createdAt: new Date() },
        { id: "m1", direction: "INBOUND", body: "question?", createdAt: new Date() },
      ]),
    },
  },
}));

vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn().mockResolvedValue({
    content: JSON.stringify({ body: "Just checking in - still need a hand?", reason: "stale 24h" }),
    usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
  }),
}));

import { generateFollowup } from "../services/followup-generator.service";

describe("followup-generator", () => {
  it("returns a follow-up body + reason for a conversation with inbound history", async () => {
    const r = await generateFollowup("t1", "conv1");
    expect(r).not.toBeNull();
    expect(r!.body).toMatch(/checking in/i);
    expect(r!.reason).toBeTruthy();
  });

  it("returns null when conversation is missing", async () => {
    const r = await generateFollowup("t1", "missing");
    expect(r).toBeNull();
  });

  it("returns null when there is no inbound message", async () => {
    const shared = await import("@chatcenter/shared");
    (shared.prisma.message.findMany as any).mockResolvedValueOnce([
      { id: "m1", direction: "OUTBOUND", body: "hi", createdAt: new Date() },
    ]);
    const r = await generateFollowup("t1", "conv1");
    expect(r).toBeNull();
  });
});
