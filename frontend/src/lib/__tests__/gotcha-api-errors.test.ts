/**
 * The API client must surface the server's error body.
 *
 * Issue-1 regression: `/builder/:id/complete` answers 422
 * `{error:"draft_not_ready", missing:[...]}` when the go-live gate fails, but
 * the client threw a bare `"POST … failed: 422"` and the caller swallowed it -
 * so a refused finalize looked like a dead button. Callers can only render an
 * actionable message if `status` and `body` survive the throw.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { builderComplete } from "../gotcha-api";

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("gotcha-api error propagation", () => {
  it("attaches status and the parsed body to the thrown error", async () => {
    mockFetch(422, { error: "draft_not_ready", missing: ["knowledge", "channel"] });

    const err = await builderComplete("tok", "agent-1").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as any).status).toBe(422);
    expect((err as any).body.missing).toEqual(["knowledge", "channel"]);
    // The message names the server's reason rather than an opaque status line.
    expect(err.message).toContain("draft_not_ready");
  });

  it("still throws a useful error when the body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response);

    const err = await builderComplete("tok", "agent-1").catch((e) => e);
    expect((err as any).status).toBe(500);
    expect(err.message).toContain("500");
  });

  it("resolves normally on success", async () => {
    mockFetch(200, { data: { ok: true } });
    await expect(builderComplete("tok", "agent-1")).resolves.toEqual({ data: { ok: true } });
  });
});
