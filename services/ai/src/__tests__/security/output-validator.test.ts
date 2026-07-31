/**
 * Unit tests for `output-validator.service.ts`. Validates the assistant's
 * final customer-facing text after the model runs.
 *
 * Mocks `@chatcenter/shared` so the audit-log path doesn't touch the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import {
  validateAssistantOutput,
  validateAndPersist,
  stripLeakedToolContent,
  stripInternalOpsNarration,
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

describe("tool-output leak protection (P0 - the live E2E leak)", () => {
  // The exact content that reached the customer in the amorphous E2E: an
  // interim ack, a tool-call-as-text blob, a fabricated result envelope, then a
  // human confirmation. The JSON lines must be stripped; the human text kept.
  const leaked =
    "רגע אחד, בודק 🙏\n" +
    '{"to":"functions.schedule_meeting","json":{"email":"a@b.com","start_iso":"2026-06-25T16:30:00+03:00"}}\n' +
    '{"ok":true,"meeting_link":"https://gotcha.demo/meet/abc123","duration_minutes":20}\n' +
    "אעדכן אותך כשנמשיך.";

  it("strips tool-call-shaped and result-envelope JSON lines, keeps human text", () => {
    const { cleaned, leaked: didLeak } = stripLeakedToolContent(leaked);
    expect(didLeak).toBe(true);
    expect(cleaned).not.toContain("functions.schedule_meeting");
    expect(cleaned).not.toContain('"ok":true');
    expect(cleaned).not.toContain("gotcha.demo");
    expect(cleaned).toContain("רגע אחד");
    expect(cleaned).toContain("אעדכן אותך");
  });

  it("validateAssistantOutput flags tool_output_leak and returns the cleaned text (leak-only)", () => {
    const r = validateAssistantOutput(leaked, ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "tool_output_leak")).toBe(true);
    expect(r.safeReply).not.toContain("functions.");
    expect(r.safeReply).not.toContain('"ok":true');
    expect(r.safeReply).toContain("רגע אחד");
  });

  it("clean human text is untouched (no false positive)", () => {
    const ok = "מעולה, נשמח לקבוע דמו קצר. איזה יום נוח לך השבוע?";
    const { leaked: didLeak } = stripLeakedToolContent(ok);
    expect(didLeak).toBe(false);
    expect(validateAssistantOutput(ok, ctx).ok).toBe(true);
  });

  it("fabricated Hebrew booking claim with NO schedule_meeting success → blocked", () => {
    const r = validateAssistantOutput("הצלחתי לקבוע את הדמו למחר ב-16:30", {
      ...ctx,
      toolCallLog: [{ tool: "integration_create_lead", decision: "executed" }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "fabricated_action")).toBe(true);
  });

  it("same booking claim WITH a real schedule_meeting success → allowed", () => {
    const r = validateAssistantOutput("קבעתי לך פגישה למחר ב-16:30", {
      ...ctx,
      toolCallLog: [{ tool: "schedule_meeting", decision: "executed" }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("internal-operations leak protection (customers see outcomes, not mechanics)", () => {
  it("strips the internal-ops clause but keeps the customer-facing reply (the live leak)", () => {
    const leak = "Awesome, I'll set the demo up. I'll create a lead internally with the details once we lock time and name. What name should I use for the booking?";
    const { cleaned, leaked } = stripInternalOpsNarration(leak);
    expect(leaked).toBe(true);
    expect(cleaned.toLowerCase()).not.toContain("create a lead");
    expect(cleaned.toLowerCase()).not.toContain("internally");
    expect(cleaned).toContain("What name should I use"); // the real ask survives
  });

  it("validateAssistantOutput flags internal_ops_leak and returns the cleaned reply", () => {
    const r = validateAssistantOutput("Sure! I'll update the CRM with your details. Meanwhile, which channel do you use most?", ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.category === "internal_ops_leak")).toBe(true);
    expect(r.safeReply.toLowerCase()).not.toContain("crm");
    expect(r.safeReply).toContain("which channel");
  });

  it("Hebrew internal-ops narration is stripped too", () => {
    const { cleaned, leaked } = stripInternalOpsNarration("מעולה. אני ארשום אותך במערכת. מתי נוח לך להיפגש?");
    expect(leaked).toBe(true);
    expect(cleaned).not.toContain("במערכת");
    expect(cleaned).toContain("מתי נוח לך");
  });

  it("does NOT touch a clean reply with no internal-ops language", () => {
    const ok = "Great - I can show you how it handles WhatsApp DMs. What day works for a quick demo?";
    expect(stripInternalOpsNarration(ok).leaked).toBe(false);
    expect(validateAssistantOutput(ok, ctx).ok).toBe(true);
  });
});
