import { describe, it, expect, vi } from "vitest";
import { ingestTaughtDocument } from "../services/teach-ingest";

const AUTH = "Bearer admin-jwt";
const BODY = { title: "Refund policy", content: "30 day returns", sourceType: "text" as const };

describe("ingestTaughtDocument", () => {
  it("posts to the AI knowledge-documents endpoint with the forwarded JWT and returns the doc id", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "doc-123" } }) });
    const id = await ingestTaughtDocument("kb-1", AUTH, BODY, fetchFn);

    expect(id).toBe("doc-123");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/api/knowledge-bases/kb-1/documents");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(AUTH);
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it("returns null on a non-ok response (so the caller does NOT mark it learned)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await ingestTaughtDocument("kb-1", AUTH, BODY, fetchFn)).toBeNull();
  });

  it("returns null when the AI service errors/throws (no false success)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await ingestTaughtDocument("kb-1", AUTH, BODY, fetchFn)).toBeNull();
  });

  it("returns null when the response carries no document id", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    expect(await ingestTaughtDocument("kb-1", AUTH, BODY, fetchFn)).toBeNull();
  });
});
