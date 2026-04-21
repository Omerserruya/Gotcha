import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postVoiceStream } from "../dispatch/ai-assist-client";
import type { VoiceStreamBody, PostVoiceStreamOptions } from "../dispatch/ai-assist-client";
import type { Transcript } from "../stt/provider";

const sampleTranscript: Transcript = {
  speaker: "customer",
  text: "hello",
  timestamp: 1000,
  isFinal: true,
  confidence: 0.9,
  seq: 1,
};

const sampleBody: VoiceStreamBody = {
  type: "voice_stream",
  tenantId: "tenant-1",
  conversationId: "conv-1",
  messages: [sampleTranscript],
};

const baseOpts: PostVoiceStreamOptions = {
  aiServiceUrl: "http://ai:4006",
  internalKey: "test-key",
  tenantId: "tenant-1",
  idempotencyKey: "idem-abc123",
  timeoutMs: 5000,
};

function makeFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("postVoiceStream", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("200 response returns ok:true with status 200", async () => {
    vi.stubGlobal("fetch", makeFetch(200, { processed: 1 }));
    const result = await postVoiceStream(sampleBody, baseOpts);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ processed: 1 });
  });

  it("409 response returns ok:false with status 409", async () => {
    vi.stubGlobal("fetch", makeFetch(409, { error: "duplicate" }));
    const result = await postVoiceStream(sampleBody, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("4xx response returns ok:false with correct status", async () => {
    vi.stubGlobal("fetch", makeFetch(400, { error: "bad_request" }));
    const result = await postVoiceStream(sampleBody, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("5xx response returns ok:false with correct status", async () => {
    vi.stubGlobal("fetch", makeFetch(503));
    const result = await postVoiceStream(sampleBody, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("timeout returns ok:false, status 0, error 'timeout'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          // listen for abort signal
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      })
    );

    const result = await postVoiceStream(sampleBody, { ...baseOpts, timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe("timeout");
  });

  it("sends correct headers: Authorization, X-Tenant-Id, X-Idempotency-Key, Content-Type", async () => {
    const mockFetch = makeFetch(200);
    vi.stubGlobal("fetch", mockFetch);
    await postVoiceStream(sampleBody, baseOpts);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe("http://ai:4006/api/ai-assist/voice");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["X-Tenant-Id"]).toBe("tenant-1");
    expect(headers["X-Idempotency-Key"]).toBe("idem-abc123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("network error returns ok:false, status 0, error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const result = await postVoiceStream(sampleBody, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
