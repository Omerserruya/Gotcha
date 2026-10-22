/**
 * "New conversation" (conversation_started): the playbook's routing as an
 * automation trigger (2026-10-22). The catalogue knows it, it is live, it takes
 * channels, and the routing automation the widget and the migration write
 * passes the go-live gate.
 */
import { describe, it, expect } from "vitest";
import { TRIGGER_TYPES, normalizeTrigger, triggerAvailability, validateAutomation } from "../lib/automation-catalog";
import { buildRoutingGraph } from "@chatcenter/shared";

describe("★ conversation_started", () => {
  it("is a trigger type, and live", () => {
    expect(TRIGGER_TYPES).toContain("conversation_started");
    expect(triggerAvailability("conversation_started", { voiceConnected: false })).toEqual({ available: true, reason: null });
  });

  it("takes channels, nothing else", () => {
    expect(normalizeTrigger({ type: "conversation_started", config: { channels: ["WHATSAPP", "GMAIL"], keywords: ["x"] } }))
      .toEqual({ type: "conversation_started", config: { channels: ["WHATSAPP", "GMAIL"] } });
    expect(normalizeTrigger({ type: "conversation_started", config: {} })).toEqual({ type: "conversation_started", config: {} });
    expect(() => normalizeTrigger({ type: "conversation_started", config: { channels: ["FAX"] } })).toThrow();
  });

  it("★ the routing automation (trigger -> hand to AI) passes the go-live gate", () => {
    const g = buildRoutingGraph("emp_1");
    const r = validateAutomation({ type: "conversation_started", config: { channels: ["WEBCHAT"] } }, g.nodes as any, g.edges as any);
    expect(r.errors).toEqual([]);
  });

  it("a hand-to-AI with no employee does not", () => {
    const g = buildRoutingGraph("");
    const r = validateAutomation({ type: "conversation_started", config: {} }, g.nodes as any, g.edges as any);
    expect(r.errors.map((e) => e.code)).toContain("missing_config");
  });
});
