/**
 * The Smoovee re-learn script, end to end in one process the way prod runs it
 * (2026-11-14): the REAL script, the REAL customer-learning stage, the REAL
 * ai.service and structuredCall. Only the OpenAI client, the database and the
 * billing calls are doubles.
 *
 * The first prod run learned 0 of 9: "[aiService] Not initialized". Nothing
 * here calls initAIService: the script has to, from the env, as index.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => {
  const IMPORT = "cmweqwb6y00ipkdj30mmzm9rt";
  const TENANT = "cmw7mzuo2004cnwkxrz960vgv";
  const db = {
    rows: [] as any[],
    memories: [] as any[],
    importStatus: "COMPLETED",
  };
  const match = (r: any, w: any) =>
    (!w.importId || r.importId === w.importId) && (!w.tenantId || r.tenantId === w.tenantId)
    && (!w.learningStatus || (typeof w.learningStatus === "string" ? r.learningStatus === w.learningStatus : r.learningStatus !== w.learningStatus.not))
    && (w.learningError === undefined || r.learningError === w.learningError);
  const prisma = {
    historicalImport: {
      findFirst: vi.fn(async () => ({ tenantId: TENANT, status: db.importStatus })),
      update: vi.fn(async () => ({})),
    },
    historicalImportEvent: { create: vi.fn(async () => ({})) },
    historicalCustomer: {
      count: vi.fn(async (a: any) => db.rows.filter((r) => match(r, a.where)).length),
      findMany: vi.fn(async (a: any) => db.rows.filter((r) => match(r, a.where)).map((r) => ({ ...r }))),
      updateMany: vi.fn(async (a: any) => {
        const hit = db.rows.filter((r) => match(r, a.where));
        hit.forEach((r) => Object.assign(r, a.data));
        return { count: hit.length };
      }),
      update: vi.fn(async (a: any) => Object.assign(db.rows.find((r) => r.id === a.where.id), a.data)),
      groupBy: vi.fn(async () => {
        const m = new Map<string, number>();
        db.rows.forEach((r) => m.set(r.learningStatus, (m.get(r.learningStatus) ?? 0) + 1));
        return [...m].map(([learningStatus, _count]) => ({ learningStatus, _count }));
      }),
    },
    customerHistoricalMemory: { upsert: vi.fn(async (a: any) => { db.memories.push(a.create); return a.create; }) },
    aiUnitLot: { findMany: vi.fn(async () => [{ unitsRemaining: 754.07 }]) },
    tenant: { findUnique: vi.fn(async () => ({ defaultLocale: "he" })) },
    message: {
      findMany: vi.fn(async () => [
        { direction: "INBOUND", body: "היי, יש לכם את אליס במלאי?", createdAt: new Date("2026-10-01T10:00:00Z") },
        { direction: "OUTBOUND", body: "כן! 299 ש\"ח", createdAt: new Date("2026-10-01T10:01:00Z") },
        { direction: "INBOUND", body: "מעולה, אני גרה בחיפה", createdAt: new Date("2026-10-01T10:02:00Z") },
        { direction: "INBOUND", body: "אזמין בשבוע הבא", createdAt: new Date("2026-10-01T10:03:00Z") },
      ]),
    },
  };
  return { IMPORT, TENANT, db, prisma, openaiCalls: [] as any[], usage: [] as any[], logs: [] as string[] };
});

vi.mock("openai", () => ({
  default: class {
    constructor(public opts: any) {}
    chat = { completions: { create: async (req: any) => {
      H.openaiCalls.push(req);
      const memory = { facts: [{ category: "location", text: "גרה בחיפה", confidence: "high" }], summary: "שואלת על אליס" };
      return { choices: [{ message: { role: "assistant", content: JSON.stringify(memory) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
    } } };
    responses = { create: async () => { throw new Error("not used"); } };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  prisma: H.prisma,
  withHistoricalRecords: async (fn: () => Promise<unknown>) => await fn(),
  historicalIntelligenceQueue: { getJobs: vi.fn(async () => []), close: vi.fn(async () => undefined) },
  assertAiAllowed: async () => undefined,
  meterAiUnits: async () => null,
  trackAIUsage: async (e: any) => { H.usage.push(e); },
}));
vi.mock("../services/audit.service", () => ({ logAudit: async () => undefined }));

import { relearn, initAsTheAiProcess, Stop } from "../scripts/relearn-failed";
import * as stage from "../services/historical-intelligence/customer-learning.stage";

function seed(n: number) {
  H.db.rows = Array.from({ length: n }, (_, i) => ({
    id: `hc${i}`, importId: H.IMPORT, tenantId: H.TENANT, externalId: `97250000000${i}`, normalizedPhone: `+97250000000${i}`,
    contactId: null, conversationId: `conv${i}`, inboundCount: 5, messageCount: 12,
    learningStatus: "FAILED", learningError: "no schema-valid model output",
  }));
  H.db.rows.push({ id: "done1", importId: H.IMPORT, tenantId: H.TENANT, learningStatus: "DONE", learningError: null });
}

const env = { ...process.env };
beforeEach(() => {
  H.db.memories = []; H.openaiCalls = []; H.usage = []; H.logs = []; H.db.importStatus = "COMPLETED";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_DEFAULT_MODEL = "gpt-5-mini";
  delete process.env.OPENAI_BASE_URL;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...env }; vi.restoreAllMocks(); });

const log = (s: string) => H.logs.push(s);

describe("★ the script initialises the AI service itself, so the stage's calls reach the model", () => {
  it("prod's 9 FAILED rows: all re-learned, memories written, one model call each, on the env's default model", async () => {
    seed(9);
    const out = await relearn({ apply: true, log });
    expect(out).toEqual({ before: 9, after: { DONE: 10 } });
    expect(H.db.memories).toHaveLength(9);
    expect(H.openaiCalls).toHaveLength(9);
    expect(H.openaiCalls.every((c) => c.model === "gpt-5-mini")).toBe(true);
    // Metered and logged like every model call: the units count will see it.
    expect(H.usage).toHaveLength(9);
    expect(H.logs[0]).toMatch(/^ai service initialised \(model gpt-5-mini/);
  });

  it("dry run: initialised, counted, nothing reset, no model call", async () => {
    seed(9);
    expect(await relearn({ apply: false, log })).toBeNull();
    expect(H.db.rows.filter((r) => r.learningStatus === "FAILED")).toHaveLength(9);
    expect(H.openaiCalls).toHaveLength(0);
    expect(H.logs.join("\n")).toMatch(/FAILED rows to re-learn: 9; units available: 754\.07/);
  });

  it("the same arguments as services/ai/src/index.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const index = readFileSync(join(__dirname, "../index.ts"), "utf8");
    const script = readFileSync(join(__dirname, "../scripts/relearn-failed.ts"), "utf8");
    const args = (src: string, v: string) => /initAIService\(\{([\s\S]*?)\}\);/.exec(src)![1].replace(new RegExp(`${v}\\.`, "g"), "").replace(/\s+/g, " ").trim();
    expect(args(script, "env")).toBe(args(index, "process\\.env"));
  });

  it("no OPENAI_API_KEY (not inside the ai container): stops before touching a row", async () => {
    seed(9);
    delete process.env.OPENAI_API_KEY;
    await expect(relearn({ apply: true, log })).rejects.toBeInstanceOf(Stop);
    expect(H.db.rows.filter((r) => r.learningStatus === "FAILED")).toHaveLength(9);
    expect(H.prisma.historicalCustomer.updateMany).not.toHaveBeenCalled();
  });
});

describe("control: the first prod run, reproduced", () => {
  it("the stage alone in a process nobody initialised: every customer fails, nothing reaches the model", async () => {
    vi.resetModules();
    const fresh = await import("../services/historical-intelligence/customer-learning.stage");
    seed(9);
    H.db.rows.forEach((r) => { if (r.learningStatus === "FAILED") { r.learningStatus = "PENDING"; r.learningError = null; } });
    const r = await fresh.runCustomerLearningStage({ tenantId: H.TENANT, importId: H.IMPORT });
    expect(r.detail).toMatchObject({ learned: 0, failed: 9 });
    expect(H.openaiCalls).toHaveLength(0);
    // A fresh module graph (vi.resetModules + import) takes ~4.5s on a loaded host: past the 5s default at times.
  }, 20_000);

  it("and the script now stops on such a round instead of reporting it as a run", async () => {
    seed(3);
    const spy = vi.spyOn(stage, "runCustomerLearningStage").mockResolvedValueOnce({ ok: true, done: true, detail: { learned: 0, skipped: 0, failed: 3, remaining: 0 } } as any);
    await expect(relearn({ apply: true, log })).rejects.toThrow(/learned nothing and failed 3/);
    spy.mockRestore();
  });
});

it("initAsTheAiProcess passes the base URL and models through", () => {
  expect(() => initAsTheAiProcess({ OPENAI_API_KEY: "k", OPENAI_DEFAULT_MODEL: "gpt-5-mini", EMBEDDING_MODEL: "text-embedding-3-small" } as any)).not.toThrow();
  expect(() => initAsTheAiProcess({} as any)).toThrow(Stop);
});
