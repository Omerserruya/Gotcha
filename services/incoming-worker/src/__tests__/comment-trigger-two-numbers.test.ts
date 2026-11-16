/** A comment's DM belongs to the account that sent it, when the tenant has two (prod GOTCHA 2026-11-16). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("comment-trigger promotion", () => {
  it("looks up the open conversation scoped to the sending account", () => {
    const src = readFileSync(join(__dirname, "../services/comment-trigger.service.ts"), "utf8");
    const scope = src.indexOf("conversationAccountScope(prisma as any, { tenantId: args.tenantId, channel, channelAccountId: args.send.channelAccountId })");
    const lookup = src.indexOf("let conv = await prisma.conversation.findFirst", scope);
    expect(scope).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(scope);
    expect(src.slice(lookup, lookup + 300)).toContain("...accountScope");
  });
});
