/**
 * Two numbers of one channel (prod GOTCHA 2026-11-16): a send must go from
 * the conversation's own number, never "the tenant's WhatsApp account".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

describe("send paths never guess one of two numbers", () => {
  it("the auto-greeting falls back only to the tenant's ONE active account, never findFirst", () => {
    const src = read("../services/conversation.service.ts");
    const fn = src.slice(src.indexOf("async function sendAutoGreeting"), src.indexOf("async function sendAutoGreeting") + 2500);
    expect(fn).toContain("singleActiveChannelAccountId(prisma as any, tenantId, channel)");
    expect(fn).not.toMatch(/channelAccount\.findFirst/);
  });
  it("starting a conversation from a contact reuses only the open conversation of the number it sends from", () => {
    const src = read("../routes/contacts.ts");
    const scope = src.indexOf("conversationAccountScope(prisma as any, { tenantId: req.tenantId!, channel: contact.channel, channelAccountId })");
    const lookup = src.indexOf("let conversation = await prisma.conversation.findFirst", scope);
    expect(scope).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(scope);
    expect(src.slice(lookup, lookup + 300)).toContain("...accountScope");
  });
  it("inbox sends use the conversation's own account (no tenant-wide pick)", () => {
    const src = read("../routes/messages.ts");
    expect(src).toContain("channelAccountId: conversation.channelAccountId!");
    expect(src).not.toMatch(/channelAccount\.findFirst\(\{\s*where:\s*\{\s*tenantId[^}]*channel[^}]*\}/);
  });
});
