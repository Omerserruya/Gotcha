/**
 * No wide dash (U+2014 em, U+2013 en, U+2015 bar) reaches a customer from the
 * AI, on any path, and none is stored in a copilot suggestion.
 *
 *   - live replies / acks / execution messages: humanizeReply (reply-style.ts)
 *   - the re-engagement follow-up: now goes through the same pass (it used to
 *     send the model's raw text)
 *   - copilot suggestions: wide dash → "-" before they are stored
 * Atomic values (URLs, dates, phones) keep their hyphens byte for byte.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ modelBody: "" }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: { findFirst: async () => ({ id: "c1", tenantId: "T", customerName: "Dana", channel: "WHATSAPP" }) },
      message: { findMany: async () => [{ direction: "INBOUND", body: "hi, any news on my order?", createdAt: new Date() }] },
    },
  };
});
vi.mock("../services/ai.service", () => ({
  generateResponse: async () => ({ content: JSON.stringify({ body: H.modelBody, reason: "test" }) }),
  getDefaultModel: () => "gpt-4o-mini",
}));

import { humanizeReply } from "../services/reply-style";
import { generateFollowup } from "../services/followup-generator.service";
import { plainDashes } from "../services/copilot-suggestions.service";

const WIDE = /[–—―]/;

describe("customer-facing AI text", () => {
  it("★ a reply with a wide dash goes out without one; URLs and dates keep their hyphens", () => {
    const out = humanizeReply("Got it — your order ships 2026-10-08, see https://shop.example/track-123 – thanks")!;
    expect(out).not.toMatch(WIDE);
    expect(out).toContain("2026-10-08");
    expect(out).toContain("https://shop.example/track-123");
  });

  it("★ the follow-up generator applies the same pass (it sent raw model text)", async () => {
    H.modelBody = "Hi Dana — just checking in – still interested?";
    const r = await generateFollowup("T", "c1");
    expect(r?.body).toBeTruthy();
    expect(r!.body).not.toMatch(WIDE);
  });
});

describe("copilot suggestions", () => {
  it("★ a wide dash becomes a plain hyphen before storing; other fields untouched", () => {
    const out = plainDashes([{ id: "s1", text: "Sure — size M is in stock – want it?", confidence: 0.8, type: "reply" }, { id: "x" }]);
    expect(out[0]).toEqual({ id: "s1", text: "Sure - size M is in stock - want it?", confidence: 0.8, type: "reply" });
    expect(out[1]).toEqual({ id: "x" });
  });
});
