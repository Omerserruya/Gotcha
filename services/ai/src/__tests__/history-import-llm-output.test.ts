/** The real structuredCall and consolidateTopic, the model's reply mocked (2026-11-18, the Smoovee rerun on luna). */
import { describe, it, expect, vi } from "vitest";
const M = vi.hoisted(() => ({ reply: "" }));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), prisma: {} }));
vi.mock("../services/ai.service", () => ({
  generateResponse: async () => ({ content: M.reply }),
  callWithRetry: (f: any) => f(),
  getDefaultModel: () => "m", getMicroModel: () => "m",
  platformPaidScope: { run: (_: any, f: any) => f() },
}));
import { z } from "zod";
import { structuredCall } from "../services/historical-intelligence/llm";
import { consolidateTopic } from "../services/historical-intelligence/consolidation";

const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);

describe("what the import writes", () => {
  it("★ structuredCall's result has no em or en dash in generated fields; quotes stay verbatim", async () => {
    M.reply = JSON.stringify({ answer: `משלוח חינם ${EM} מעל 299`, hours: `9${EN}17`, quotedAnswer: `כן ${EM} בדיוק` });
    const r: any = await structuredCall({ tenantId: "t", schema: z.object({ answer: z.string(), hours: z.string(), quotedAnswer: z.string() }), system: "s", user: "u", feature: "f" });
    expect(r).toEqual({ answer: "משלוח חינם, מעל 299", hours: "9-17", quotedAnswer: `כן ${EM} בדיוק` });
  });
  it("★ consolidateTopic folds a fragment the model left as its own item", async () => {
    const m = (id: string, question: string, answer: string) => ({ id, question, answer, occurrenceCount: 2, firstSeenAt: null, lastSeenAt: null, curationVerdict: "kept", curationNote: null, requiresLiveLookup: false });
    M.reply = JSON.stringify({ items: [
      { question: "אבל עד לידית מה המידה", answer: "המידה עד הידית היא 12 סנטימטר", sourceIds: ["f"], status: "ok" },
      { question: "מה גובה המשטח עד הידית", answer: "המידה עד הידית היא 12 סנטימטר בכל הדגמים", sourceIds: ["h"], status: "ok" },
    ] });
    const out = await consolidateTopic({ tenantId: "t", language: "Hebrew", label: "ידית", members: [m("f", "אבל עד לידית מה המידה", "12"), m("h", "מה גובה המשטח עד הידית", "12")] as any });
    expect(out.map((x) => x.question)).toEqual(["מה גובה המשטח עד הידית"]);
    expect(out[0].sourceIds.sort()).toEqual(["f", "h"]);
  });
});
