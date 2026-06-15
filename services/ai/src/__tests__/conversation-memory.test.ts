import { describe, it, expect } from "vitest";
import {
  buildConversationMemory,
  renderMemoryBlock,
  type MemoryInputMessage,
} from "../services/conversation-memory.service";

describe("ConversationMemory - buildConversationMemory", () => {
  it("extracts team size, channel, timezone from inbound text", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "We're a team of 12 people on WhatsApp, EST timezone" },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.facts.teamSize).toBe("12");
    expect(m.facts.currentChannel?.toLowerCase()).toBe("whatsapp");
    expect(m.facts.timezone).toBe("EST");
  });

  it("captures stated need verbatim (capped)", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "I need a CRM that connects to Instagram" },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.facts.statedNeed).toContain("I need a CRM");
  });

  it("Hebrew need extraction works", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "אני צריך מערכת לניהול לקוחות" },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.facts.statedNeed).toContain("אני צריך");
  });

  it("records past intents in order, deduplicated", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "tell me more about pricing" },
      { direction: "INBOUND", body: "this is too expensive for us" },
      { direction: "INBOUND", body: "but we might consider it later" },
      { direction: "INBOUND", body: "let me think about it and get back to you" },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.pastIntents).toEqual(["objection", "deferral"]);
    expect(m.facts.lastObjection).toContain("too expensive");
  });

  it("metadata-tagged intents win over heuristics and preserve order", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "hello", metadata: { intent: "informational" } },
      { direction: "INBOUND", body: "i want to buy", metadata: { intent: "transactional" } },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.pastIntents).toEqual(["informational", "transactional"]);
  });

  it("propagates last outcome from metadata (latest wins)", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "OUTBOUND", body: "Here's a quote", metadata: { outcome: "quote_sent" } },
      { direction: "OUTBOUND", body: "Booked!", metadata: { outcome: "demo_booked" } },
    ];
    const m = buildConversationMemory({ messages });
    expect(m.lastOutcome).toBe("demo_booked");
  });

  it("merges known email/phone passed in by caller", () => {
    const m = buildConversationMemory({
      messages: [{ direction: "INBOUND", body: "hi" }],
      knownEmail: "x@y.com",
      knownPhone: "+12025550123",
    });
    expect(m.facts.knownEmail).toBe("x@y.com");
    expect(m.facts.knownPhone).toBe("+12025550123");
  });
});

describe("ConversationMemory - renderMemoryBlock", () => {
  it("renders only present facts and includes ground-truth instruction", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "We're 8 employees, on Telegram" },
    ];
    const block = renderMemoryBlock(buildConversationMemory({ messages }));
    expect(block).toContain("## Memory");
    expect(block).toContain("team_size: 8");
    expect(block).toContain("current_channel: ");
    expect(block).toContain("Do NOT re-ask");
  });

  it("renders Past intents and Last outcome lines when set", () => {
    const messages: MemoryInputMessage[] = [
      { direction: "INBOUND", body: "this is too expensive" },
      { direction: "OUTBOUND", body: "ok", metadata: { outcome: "objection_raised" } },
    ];
    const block = renderMemoryBlock(buildConversationMemory({ messages }));
    expect(block).toContain("Past intents: objection");
    expect(block).toContain("Last outcome: objection_raised");
  });

  it("omits empty fact lines when nothing is known", () => {
    const block = renderMemoryBlock(buildConversationMemory({ messages: [] }));
    expect(block).toContain("## Memory");
    expect(block).not.toContain("Known facts:");
    expect(block).toContain("Turn count: 0");
  });
});
