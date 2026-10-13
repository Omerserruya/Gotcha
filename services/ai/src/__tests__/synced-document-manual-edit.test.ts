/**
 * A Drive/Confluence sync never overwrites a person's edit (K11, 2026-10-13),
 * the rule the website re-scan already follows, and a source update merges
 * the document's metadata instead of replacing it (the summary and provenance
 * stayed lost until the next processing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ doc: null as any, updates: [] as any[], created: [] as any[] }));
vi.mock("@chatcenter/shared", () => ({
  prisma: {
    knowledgeDocument: {
      findFirst: vi.fn(async () => H.doc),
      update: vi.fn(async (a: any) => { H.updates.push(a.data); return {}; }),
      create: vi.fn(async (a: any) => { H.created.push(a.data); return { id: "new" }; }),
    },
  },
}));
vi.mock("../services/qdrant.service", () => ({ upsertChunks: vi.fn(), deleteByDocumentId: vi.fn() }));
vi.mock("../services/ai.service", () => ({ generateEmbedding: vi.fn(), generateResponse: vi.fn(), getMicroModel: () => "m" }));

import * as embedding from "../services/embedding.service";
vi.spyOn(embedding, "processDocument").mockResolvedValue(undefined as any);

const sync = () => embedding.upsertSyncedDocument({
  knowledgeBaseId: "kb", tenantId: "T", title: "Returns", content: "new text", sourceType: "google_drive",
  sourceUrl: "https://docs.google.com/d/1", changeKey: "v2", metadata: { origin: "drive" },
});

beforeEach(() => { H.updates = []; H.created = []; });

describe("synced documents", () => {
  it("★ a document a person edited is kept: no write, reported as skipped", async () => {
    H.doc = { id: "d1", metadata: { syncChangeKey: "v1", manualEdit: true, origin: "drive" } };
    expect(await sync()).toBe("skipped");
    expect(H.updates).toHaveLength(0);
  });

  it("an unedited document is updated, its metadata merged (summary kept, old error dropped)", async () => {
    H.doc = { id: "d1", metadata: { syncChangeKey: "v1", summary: { text: "s", hash: "h" }, error: "old failure", topic: "returns" } };
    expect(await sync()).toBe("updated");
    expect(H.updates[0]).toMatchObject({ content: "new text", status: "pending" });
    expect(H.updates[0].metadata).toEqual({ summary: { text: "s", hash: "h" }, topic: "returns", origin: "drive", syncChangeKey: "v2" });
  });

  it("unchanged at the source: skipped as before", async () => {
    H.doc = { id: "d1", metadata: { syncChangeKey: "v2" } };
    expect(await sync()).toBe("skipped");
    expect(H.updates).toHaveLength(0);
  });
});
