/**
 * The scan job and go-live call authenticate()-gated AI routes, which take the
 * internal secret as a Bearer token - an X-Internal-Key header alone is a 401
 * there (found on dev, 2026-10-23). Pin the shape every internal call sends.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => ({ ...(await importOriginal<any>()), getInternalServiceKey: () => "secret-k" }));
import { aiInternal } from "../services/onboarding-discover/learn";

afterEach(() => vi.unstubAllGlobals());

describe("aiInternal", () => {
  it("sends the secret as a Bearer token, the tenant in x-tenant-id, and the header form too", async () => {
    let seen: any = null;
    vi.stubGlobal("fetch", async (_u: string, init: any) => { seen = init.headers; return { ok: true, status: 200, json: async () => ({}) } as any; });
    await aiInternal("T1", "POST", "/api/ai-assist/onboarding-extract", {});
    expect(seen).toMatchObject({ Authorization: "Bearer secret-k", "x-tenant-id": "T1", "X-Internal-Key": "secret-k" });
  });
});
