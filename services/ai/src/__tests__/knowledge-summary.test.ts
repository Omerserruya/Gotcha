/**
 * Each knowledge document carries a stored one or two line summary (B3,
 * 2026-10-12): made when the document is processed, in the workspace's system
 * language, kept until the content or that language changes, never made per
 * page view, and never able to fail the document.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  locale: "he" as string | null,
  llm: vi.fn(async () => ({ content: "מדיניות החזרות: 14 יום להחזרה, זיכוי מלא לכרטיס האשראי." })),
  updates: [] as any[],
  qdrant: vi.fn(async () => undefined),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    tenant: { findUnique: async () => (H.locale === null ? null : { defaultLocale: H.locale }) },
    knowledgeDocument: {
      findUnique: async ({ where }: any) => { const d = H.docs.get(where.id); return d ? { ...d } : null; },
      update: async ({ where, data }: any) => { H.updates.push({ id: where.id, data }); Object.assign(H.docs.get(where.id), data); return H.docs.get(where.id); },
    },
    knowledgeChunk: { deleteMany: async () => ({ count: 0 }), create: async () => ({}) },
  },
}));
vi.mock("../services/ai.service", () => ({
  generateResponse: H.llm,
  getMicroModel: () => "micro",
  generateEmbedding: async () => ({ embedding: [0.1, 0.2] }),
}));
vi.mock("../services/qdrant.service", () => ({ upsertChunks: H.qdrant, deleteByDocumentId: async () => undefined }));

import { ensureDocumentSummary, cleanSummary, plainText, contentHash, summaryOf, SUMMARY_MAX } from "../services/knowledge-summary.service";
import { processDocument } from "../services/embedding.service";

const LONG = "Returns within 14 days of delivery, unused and in the original packaging. Refunds go back to the card used.";
const doc = (over: any = {}) => ({ id: "d1", tenantId: "T", knowledgeBaseId: "kb", title: "Returns", content: LONG, metadata: { origin: "website", dedupeKey: "k1" }, ...over });

beforeEach(() => {
  H.docs = new Map([["d1", doc()]]);
  H.locale = "he";
  H.llm.mockClear();
  H.llm.mockImplementation(async () => ({ content: "מדיניות החזרות: 14 יום להחזרה, זיכוי מלא לכרטיס האשראי." }));
  H.updates = [];
});

describe("ensureDocumentSummary", () => {
  it("stores the summary in the system language, beside the existing metadata", async () => {
    expect(await ensureDocumentSummary("d1")).toBe("created");
    const m = H.docs.get("d1").metadata;
    expect(m.origin).toBe("website");
    expect(m.dedupeKey).toBe("k1");
    expect(m.summary).toMatchObject({ text: "מדיניות החזרות: 14 יום להחזרה, זיכוי מלא לכרטיס האשראי.", lang: "he", hash: contentHash(LONG) });
    const call = (H.llm.mock.calls[0] as any)[0];
    expect(call.messages[0].content).toContain("in Hebrew");
    expect(call.tenantId).toBe("T");
  });

  it("an English workspace gets an English summary", async () => {
    H.locale = "en";
    await ensureDocumentSummary("d1");
    expect((H.llm.mock.calls[0] as any)[0].messages[0].content).toContain("in English");
    expect(H.docs.get("d1").metadata.summary.lang).toBe("en");
  });

  it("★ a fresh summary is kept: no model call", async () => {
    await ensureDocumentSummary("d1");
    H.llm.mockClear();
    expect(await ensureDocumentSummary("d1")).toBe("fresh");
    expect(H.llm).not.toHaveBeenCalled();
  });

  it("changed content makes a new one", async () => {
    await ensureDocumentSummary("d1");
    H.docs.get("d1").content = LONG + " Exchanges only, within 30 days.";
    H.llm.mockClear();
    expect(await ensureDocumentSummary("d1")).toBe("created");
    expect(H.llm).toHaveBeenCalledTimes(1);
  });

  it("a changed system language makes a new one", async () => {
    await ensureDocumentSummary("d1");
    H.locale = "en";
    H.llm.mockClear();
    expect(await ensureDocumentSummary("d1")).toBe("created");
  });

  it("empty content: no model call, nothing stored", async () => {
    H.docs.get("d1").content = "   ";
    expect(await ensureDocumentSummary("d1")).toBe("empty");
    expect(H.llm).not.toHaveBeenCalled();
    expect(H.updates).toHaveLength(0);
  });

  it("★ short content is its own summary: no model call, nothing invented", async () => {
    H.docs.get("d1").content = "דשגכ";
    expect(await ensureDocumentSummary("d1")).toBe("created");
    expect(H.llm).not.toHaveBeenCalled();
    expect(H.docs.get("d1").metadata.summary.text).toBe("דשגכ");
    expect(await ensureDocumentSummary("d1")).toBe("fresh");
  });

  it("★ short markdown content is stored as plain text, and a stored marked-up one is rewritten", async () => {
    H.docs.get("d1").content = "## Hours\n**Sun-Thu** 9-17";
    H.docs.get("d1").metadata.summary = { text: "## Hours **Sun-Thu** 9-17", lang: "he", hash: contentHash("## Hours\n**Sun-Thu** 9-17"), at: "x" };
    expect(await ensureDocumentSummary("d1")).toBe("created");
    expect(H.llm).not.toHaveBeenCalled();
    expect(H.docs.get("d1").metadata.summary.text).toBe("Hours Sun-Thu 9-17");
    expect(await ensureDocumentSummary("d1")).toBe("fresh");
  });

  it("★ a model that finds no real content says NONE, and nothing is stored", async () => {
    H.llm.mockResolvedValueOnce({ content: "NONE" } as any);
    expect(await ensureDocumentSummary("d1")).toBe("empty");
    expect(H.updates).toHaveLength(0);
    expect((H.llm.mock.calls[0] as any)[0].messages[0].content).toContain("reply with exactly NONE");
  });

  it("a model failure stores nothing and does not throw", async () => {
    H.llm.mockRejectedValueOnce(new Error("rate limited"));
    expect(await ensureDocumentSummary("d1")).toBe("failed");
    expect(H.updates).toHaveLength(0);
  });

  it("content changed while summarising: the stale summary is not stored", async () => {
    H.llm.mockImplementationOnce(async () => { H.docs.get("d1").content = "new text"; return { content: "old summary" }; });
    expect(await ensureDocumentSummary("d1")).toBe("failed");
    expect(H.updates).toHaveLength(0);
  });
});

describe("plainText", () => {
  it("★ markdown keeps only its words", () => {
    expect(cleanSummary("## מדיניות החזרות\n- **14 ימים** להחזרה\n- ראו [התקנון](https://x.co/t)")).toBe("מדיניות החזרות 14 ימים להחזרה ראו התקנון");
    expect(plainText("> *Note*: use `code` and __bold__\n1. first\n---\n![logo](a.png)")).toBe("Note: use code and bold\nfirst\n\nlogo");
  });

  it("plain text is left as it is: snake_case, 2*3*4, a lone star", () => {
    expect(plainText("set max_items to 5; 2*3*4 = 24; rated 5 * good")).toBe("set max_items to 5; 2*3*4 = 24; rated 5 * good");
  });
});

describe("cleanSummary", () => {
  it("one line, no dashes, no wrapping quotes", () => {
    expect(cleanSummary('"Returns \u2014 14 days\n and refunds"')).toBe("Returns - 14 days and refunds");
  });
  it("capped at 160 on a word, marked as cut", () => {
    const t = cleanSummary(("word ".repeat(60)).trim());
    expect(t.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(t.endsWith("word\u2026")).toBe(true);
  });
  it("summaryOf reads the stored text or null", () => {
    expect(summaryOf({ summary: { text: "x" } })).toBe("x");
    expect(summaryOf({ summary: { text: "  " } })).toBeNull();
    expect(summaryOf(null)).toBeNull();
  });
});

describe("processDocument makes it, once per change", () => {
  it("★ an ingest stores chunks AND the summary", async () => {
    await processDocument("d1");
    expect(H.docs.get("d1").status).toBe("ready");
    expect(H.docs.get("d1").metadata.summary.text).toContain("מדיניות");
  });

  it("re-processing unchanged content makes no second model call", async () => {
    await processDocument("d1");
    H.llm.mockClear();
    await processDocument("d1");
    expect(H.llm).not.toHaveBeenCalled();
  });

  it("a summary failure does not fail the document", async () => {
    H.llm.mockRejectedValueOnce(new Error("down"));
    await processDocument("d1");
    expect(H.docs.get("d1").status).toBe("ready");
  });

  it("★ a processing error keeps the metadata it had (summary, provenance) beside the error", async () => {
    await ensureDocumentSummary("d1");
    H.qdrant.mockRejectedValueOnce(new Error("qdrant down"));
    await expect(processDocument("d1")).rejects.toThrow("qdrant down");
    const m = H.docs.get("d1").metadata;
    expect(H.docs.get("d1").status).toBe("error");
    expect(m.error).toBe("qdrant down");
    expect(m.dedupeKey).toBe("k1");
    expect(m.summary.text).toBeTruthy();
  });
});
