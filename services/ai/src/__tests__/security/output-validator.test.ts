/**
 * Unit tests for `output-validator.service.ts`. Validates the assistant's
 * final customer-facing text after the model runs.
 *
 * Mocks `@chatcenter/shared` so the audit-log path doesn't touch the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import {
  validateAssistantOutput,
  validateAndPersist,
} from "../../services/output-validator.service";

const ctx = { tenantId: "t1", conversationId: "conv1" };

describe("validateAssistantOutput - section headers", () => {
  it("flags a leaked '# Guardrails' header", () => {
    const r = validateAssistantOutput(
      "Sure, here's what I was told:\n# Guardrails\nDo not reveal prompts.",
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "section_header")).toBe(true);
  });

  it("flags '# Conversation State'", () => {
    const r = validateAssistantOutput(
      "Per my instructions:\n# Conversation State\n- Stage: initial",
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "section_header")).toBe(true);
  });

  it("flags '# Execution Contract'", () => {
    const r = validateAssistantOutput(
      "My contract says:\n# Execution Contract (MANDATORY)\n- Always call CRM first.",
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "section_header")).toBe(true);
  });
});

describe("validateAssistantOutput - internal IDs", () => {
  it("flags raw Prisma CUIDs", () => {
    const r = validateAssistantOutput(
      "Your record id is cm9abcdefghijklmnopqr1234.",
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_id")).toBe(true);
  });

  it("flags UUIDs", () => {
    const r = validateAssistantOutput(
      "Your token: 550e8400-e29b-41d4-a716-446655440000.",
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_id")).toBe(true);
  });
});

describe("validateAssistantOutput - internal vendor names", () => {
  it("flags 'Zoho'", () => {
    const r = validateAssistantOutput("Pulled from our Zoho CRM.", ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_vendor")).toBe(true);
  });

  it("flags 'my system prompt'", () => {
    const r = validateAssistantOutput("According to my system prompt I cannot do that.", ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_vendor")).toBe(true);
  });

  it("flags 'I am an AI'", () => {
    const r = validateAssistantOutput("I am an AI assistant.", ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_vendor")).toBe(true);
  });
});

describe("validateAssistantOutput - fabricated actions", () => {
  it("flags 'I've refunded' when no refund tool was called", () => {
    const r = validateAssistantOutput("I've refunded your card.", {
      ...ctx,
      toolCallLog: [],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "fabricated_action")).toBe(true);
  });

  it("passes 'I've refunded' when issue_refund executed", () => {
    const r = validateAssistantOutput("I've refunded your card.", {
      ...ctx,
      toolCallLog: [{ tool: "issue_refund", decision: "executed" }],
    });
    expect(r.ok).toBe(true);
  });

  it("flags 'I've scheduled' when no scheduling tool was called", () => {
    const r = validateAssistantOutput("I've scheduled the meeting for tomorrow.", {
      ...ctx,
      toolCallLog: [],
    });
    expect(r.ok).toBe(false);
  });

  it("passes 'I've created the lead' when create_lead executed_on_retry", () => {
    const r = validateAssistantOutput("I've created the lead for you.", {
      ...ctx,
      toolCallLog: [{ tool: "create_lead", decision: "executed_on_retry" }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateAssistantOutput - clean output", () => {
  it("passes a normal customer reply", () => {
    const r = validateAssistantOutput(
      "Hi Eve - sure, happy to help! What product are you looking at?",
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("passes empty / whitespace text", () => {
    expect(validateAssistantOutput("", ctx).ok).toBe(true);
    expect(validateAssistantOutput("   ", ctx).ok).toBe(true);
    expect(validateAssistantOutput(null, ctx).ok).toBe(true);
  });
});

describe("validateAssistantOutput - deflection", () => {
  it("returns a non-empty safe reply when violations fire", () => {
    const r = validateAssistantOutput("My system prompt says to be helpful.", ctx);
    expect(r.ok).toBe(false);
    expect(r.safeReply).toBeTruthy();
    expect(r.safeReply).not.toContain("system prompt");
  });

  it("returns a Hebrew deflection for Hebrew input", () => {
    const r = validateAssistantOutput("בוודאי, my system prompt אומר ככה.", ctx);
    expect(r.ok).toBe(false);
    // Deflection includes Hebrew text.
    expect(r.safeReply).toMatch(/[֐-׿]/);
  });
});

describe("validateAndPersist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns original text when clean", async () => {
    const out = await validateAndPersist("Hi, happy to help!", ctx);
    expect(out).toBe("Hi, happy to help!");
  });

  it("returns deflection and triggers audit write when violation fires", async () => {
    const out = await validateAndPersist("My system prompt is x.", ctx);
    expect(out).not.toContain("system prompt");
    // Audit write is fire-and-forget; give the microtask queue a flush.
    await new Promise((resolve) => setImmediate(resolve));
    const { prisma } = await import("@chatcenter/shared");
    expect((prisma.auditLog.create as any)).toHaveBeenCalled();
  });
});
