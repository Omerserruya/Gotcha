/**
 * Issue-3 (partial): an AI employee must mean the same thing to the backend
 * whether it was created in AI Studio or hired during onboarding.
 *
 * The two creation paths hard-coded separate default blocks, so an
 * onboarding-hired employee silently inherited raw schema defaults for the
 * fields that govern its RUNTIME BEHAVIOUR - when it escalates
 * (confidenceThreshold, escalationMessage) and how long it may run unattended
 * (maxAutonomousMessages/Minutes). These lock the shared block.
 */
import { describe, it, expect, vi } from "vitest";

// vi.mock is hoisted above imports, so a static import here still sees the
// mock (and avoids top-level await, which this CommonJS build rejects).
vi.mock("../services/ai.service", () => ({ getDefaultModel: () => "test-model" }));

import { aiAgentCreationDefaults } from "../services/ai-agent-defaults";

describe("shared AI employee creation defaults", () => {
  it("defines the full behavioural envelope, not just model settings", () => {
    const d = aiAgentCreationDefaults();
    // Runtime-behaviour fields: the ones onboarding used to omit.
    // 30, not 10. Ten AI replies is a short conversation - a product question,
    // a size check, an order lookup and a cancellation is most of it - and the
    // dev agent hit the ceiling mid-test on an ordinary support flow. A limit
    // that fires during normal use is a defect the customer experiences as
    // being abandoned, not a safety rail.
    expect(d.maxAutonomousMessages).toBe(30);
    expect(d.maxAutonomousMinutes).toBe(15);
    expect(d.confidenceThreshold).toBe(0.6);
    expect(d.escalationMessage).toBeTruthy();
    // Presentation + model fields.
    expect(d.avatarColor).toBe("#7c5cfc");
    expect(d.tone).toBe("professional");
    expect(d.languages).toEqual({ english: true });
    expect(d.model).toBe("test-model");
    expect(d.provider).toBe("openai");
    expect(d.temperature).toBe(0.7);
    expect(d.maxTokens).toBe(1024);
  });

  it("carries no identity-bearing fields - those are per-flow decisions", () => {
    const d = aiAgentCreationDefaults() as Record<string, unknown>;
    for (const owned of ["name", "role", "goal", "persona", "status", "tenantId", "departmentId"]) {
      expect(d).not.toHaveProperty(owned);
    }
  });

  it("returns a fresh object each call (no shared mutable state across creates)", () => {
    const a = aiAgentCreationDefaults();
    const b = aiAgentCreationDefaults();
    expect(a).not.toBe(b);
    expect(a.languages).not.toBe(b.languages);
    (a.languages as Record<string, boolean>).hebrew = true;
    expect(b.languages).toEqual({ english: true });
  });
});
