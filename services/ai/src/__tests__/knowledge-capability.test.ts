import { describe, it, expect } from "vitest";
import { executeKnowledgeOperation } from "../services/capability-runtime/knowledge.runtime";
import { KNOWLEDGE_CONTRACTS } from "../services/capability-runtime/knowledge.contracts";
import type { KnowledgePort, KnowledgePassage } from "../services/capability-runtime/knowledge.port";
import type { ExecutionRequest, ExecutionMode } from "@chatcenter/shared";

const SILENT = { logger: () => {} };

function fakePort(opts: { available?: boolean; passages?: KnowledgePassage[]; fail?: string } = {}): { port: KnowledgePort; calls: { search: number } } {
  const calls = { search: 0 };
  const port: KnowledgePort = {
    async available() { return opts.available ?? true; },
    async search() {
      calls.search++;
      if (opts.fail) throw new Error(opts.fail);
      return opts.passages ?? [];
    },
  };
  return { port, calls };
}

const req = (params: Record<string, unknown> = {}, mode: ExecutionMode = "autonomous"): ExecutionRequest => ({
  operation: "SEARCH_KNOWLEDGE", params, context: { tenantId: "t1", conversationId: "c1" }, mode,
});

describe("KNOWLEDGE operation set — SEARCH_KNOWLEDGE", () => {
  it("query → EXECUTED with the real passages", async () => {
    const { port, calls } = fakePort({ passages: [{ text: "Pricing starts at ₪99/mo", source: "Pricing.pdf", score: 0.91 }] });
    const { result, trace } = await executeKnowledgeOperation(req({ query: "how much does it cost" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.passages[0].text).toContain("₪99");
    expect(calls.search).toBe(1);
    expect(trace.successVerified).toBe(true);
  });

  it("no results → EXECUTED with an honest 'unknown — do not guess' outcome", async () => {
    const { port } = fakePort({ passages: [] });
    const { result } = await executeKnowledgeOperation(req({ query: "warranty policy" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).outcome).toContain("do not guess");
  });

  it("empty query → NEEDS_INPUT(query), search never runs", async () => {
    const { port, calls } = fakePort();
    const { result } = await executeKnowledgeOperation(req({ query: "  " }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "query" });
    expect(calls.search).toBe(0);
  });

  it("a READ runs in advisory (shadow) mode too", async () => {
    const { port, calls } = fakePort({ passages: [{ text: "x" }] });
    const { result } = await executeKnowledgeOperation(req({ query: "q" }, "advisory"), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(calls.search).toBe(1);
  });

  it("retrieval failure → FAILED recoverable (observable, never a throw)", async () => {
    const { port } = fakePort({ fail: "vector store down" });
    const { result } = await executeKnowledgeOperation(req({ query: "q" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", recoverable: true });
    expect((result as any).reason).toContain("vector store down");
  });

  it("contract is business-only (no vendor/embedding/vector leaks)", () => {
    const c = KNOWLEDGE_CONTRACTS.SEARCH_KNOWLEDGE;
    expect(c.effect).toBe("read");
    expect(/qdrant|embedding|vector|openai/i.test(JSON.stringify(c))).toBe(false);
  });
});
