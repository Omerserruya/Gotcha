/**
 * AIWorker top-level orchestration tests.
 *
 * Exercises the contract that matters at the call site:
 *   - open() is idempotent - second open for same sessionId returns the
 *     same prefix bytes
 *   - buildMessages prepends SYSTEM_CORE + SESSION_PROFILE in that order
 *   - allowedTools is the post-policy decision
 *
 * Does NOT call OpenAI - generate()/stream() are integration territory.
 */

import { describe, it, expect, beforeEach } from "vitest";
import "../skills";
import { AIWorker } from "../worker";
import { __clearRegistryForTests } from "../session-registry";
import { __clearSeenForTests } from "../observability/prompt-hash";
import type { AIWorkerConfig, AIWorkerSessionProfile } from "@chatcenter/shared";

const baseConfig: AIWorkerConfig = {
  id: "w1",
  tenantId: "t1",
  identity: { name: "Sami", language: "en" },
  mode: "autonomous",
  skillIds: ["sales", "tool_usage_policy"],
  funnelId: null,
  guardrails: {
    blockedTopics: [],
    escalationKeywords: [],
    refundRequiresApproval: true,
    customRules: [],
  },
  knowledgeBaseIds: [],
  metadata: {},
  isActive: true,
};

const baseProfile: AIWorkerSessionProfile = {
  sessionId: "sess-1",
  conversationId: "conv-1",
  contactId: "c1",
  customer: { name: "Acme" },
  pipeline: {},
  behavior: {},
  capturedAt: "2026-05-24T10:00:00Z",
};

describe("AIWorker", () => {
  beforeEach(() => {
    __clearRegistryForTests();
    __clearSeenForTests();
  });

  it("open() is idempotent - same sessionId → same fingerprint hash", () => {
    const a = AIWorker.open({ sessionId: "sess-1", config: baseConfig, profile: baseProfile });
    const b = AIWorker.open({ sessionId: "sess-1", config: baseConfig, profile: baseProfile });
    expect(a.fingerprintHash).toBe(b.fingerprintHash);
  });

  it("buildMessages prepends SYSTEM_CORE + SESSION_PROFILE before turn messages", () => {
    const w = AIWorker.open({ sessionId: "sess-1", config: baseConfig, profile: baseProfile });
    const messages = w.buildMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "and another" },
    ]);
    expect(messages).toHaveLength(5);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("# AI Worker");
    expect(messages[1]!.role).toBe("system");
    expect(messages[1]!.content).toContain("# Session Context");
    expect(messages[2]).toEqual({ role: "user", content: "hi" });
  });

  it("allowedTools reflects the policy decision (copilot strips forbidden tools)", () => {
    const copilot = AIWorker.open({
      sessionId: "sess-cp",
      config: { ...baseConfig, mode: "copilot" },
      profile: baseProfile,
    });
    // sales skill grants schedule_followup; copilot mode must strip it
    expect(copilot.allowedTools).not.toContain("schedule_followup");
  });

  it("tenantDenylist removes a tool even in autonomous mode", () => {
    const w = AIWorker.open({
      sessionId: "sess-deny",
      config: baseConfig,
      profile: baseProfile,
      tenantDenylist: ["update_crm"],
    });
    expect(w.allowedTools).not.toContain("update_crm");
  });

  it("sessionId is exposed for cache routing", () => {
    const w = AIWorker.open({ sessionId: "sess-xyz", config: baseConfig, profile: baseProfile });
    expect(w.sessionId).toBe("sess-xyz");
  });
});
