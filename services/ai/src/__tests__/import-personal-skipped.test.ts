/**
 * A contact the history import marked personal (2026-11-22) gives no customer memory: customer learning
 * marks it SKIPPED ("personal contact") with no model call; the others are learned as before. Knowledge
 * extraction and the brand voice leave it out by their query (checked by source below).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ updates: [] as any[], calls: 0, convWhere: null as any }));
// Any other read or write the stage makes after the loop: a neutral answer.
const { neutral } = vi.hoisted(() => ({ neutral: (known: any) => new Proxy(known, {
  get: (t: any, model: string) => t[model] ?? new Proxy({}, { get: (_m: any, op: string) => async () => (op === "count" ? 0 : op === "findMany" ? [] : op.endsWith("Many") ? { count: 0 } : null) }),
}) }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  prisma: neutral({
    historicalCustomer: {
      findMany: async () => [
        { id: "h1", externalId: "9725011", normalizedPhone: null, contactId: null, conversationId: "personal-conv", inboundCount: 9, messageCount: 20 },
        { id: "h2", externalId: "9725022", normalizedPhone: null, contactId: null, conversationId: "biz-conv", inboundCount: 9, messageCount: 20 },
      ],
      update: async (a: any) => { H.updates.push(a); return {}; },
      count: async () => 0,
    },
    conversation: { findMany: async (a: any) => { H.convWhere = a.where; return [{ id: "personal-conv" }]; } },
    tenant: { findUnique: async () => ({ defaultLocale: "he" }) },
  }),
}));
vi.mock("../services/historical-intelligence/llm", () => ({ structuredCall: vi.fn(async () => { H.calls++; return null; }) }));
vi.mock("../services/historical-intelligence/stage-utils", async (orig) => ({
  ...(await orig<any>()),
  recordEvent: async () => undefined,
  loadConversationTranscript: async () => [{ direction: "INBOUND", body: "hi", at: new Date() }],
  tenantPromptLanguage: async () => "Hebrew",
}));

import { runCustomerLearningStage } from "../services/historical-intelligence/customer-learning.stage";

beforeEach(() => { H.updates = []; H.calls = 0; });

describe("a personal contact is not learned", () => {
  it("★ SKIPPED with its reason, no model call; the business contact goes to the model", async () => {
    await runCustomerLearningStage({ tenantId: "T", importId: "imp1" });
    expect(H.updates.find((u) => u.where.id === "h1")?.data).toEqual({ learningStatus: "SKIPPED", learningError: "personal contact" });
    expect(H.calls).toBe(1);
    expect(H.convWhere).toMatchObject({ tenantId: "T", origin: "HISTORICAL_IMPORT", relevanceSource: "import", relevanceCategory: "personal", id: { in: ["personal-conv", "biz-conv"] } });
  });
});

describe("knowledge and the brand voice leave a personal contact out", () => {
  const SKIP = 'NOT: { conversation: { is: { relevanceSource: "import", relevanceCategory: "personal" } } }';
  it("knowledge extraction: both its count and its read", () => {
    const src = readFileSync(join(__dirname, "../services/historical-intelligence/knowledge-extraction.stage.ts"), "utf8");
    expect(src.split(SKIP).length - 1).toBe(2);
  });
  it("the brand voice", () => {
    const src = readFileSync(join(__dirname, "../services/historical-intelligence/brand-voice.stage.ts"), "utf8");
    expect(src.split(SKIP).length - 1).toBe(1);
  });
});
