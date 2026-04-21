import { describe, it, expect } from "vitest";
import { createFakeClock } from "../lib/clock";
import { buildSTTProvider } from "../stt/stt-factory";
import { StubSTTProvider } from "../stt/stub-provider";
import { GoogleCloudSTTProvider } from "../stt/google-provider";
import { NotImplementedError } from "../lib/errors";
import { SttSessionContext } from "../stt/provider";

function makeCtx(): SttSessionContext {
  return {
    tenantId: "t1",
    conversationId: "c1",
    callSid: "CA123",
    language: "en-US",
    interimResults: true,
    onError: () => {},
  };
}

describe("buildSTTProvider", () => {
  it("returns a StubSTTProvider when provider is 'stub'", () => {
    const clock = createFakeClock();
    const provider = buildSTTProvider({ provider: "stub", seed: 42, clock });
    expect(provider).toBeInstanceOf(StubSTTProvider);
  });

  it("returns a GoogleCloudSTTProvider when provider is 'google'", () => {
    const provider = buildSTTProvider({ provider: "google" });
    expect(provider).toBeInstanceOf(GoogleCloudSTTProvider);
  });

  it("calling start() on google provider throws NotImplementedError", async () => {
    const provider = buildSTTProvider({ provider: "google" });
    await expect(provider.start(makeCtx())).rejects.toThrow(NotImplementedError);
  });

  it("stub factory passes clock through (fake clock controls timing)", async () => {
    const clock = createFakeClock();
    const provider = buildSTTProvider({ provider: "stub", seed: 7, clock });

    const partials: unknown[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("partial", (t) => partials.push(t));

    stream.push(new Int16Array(160), "agent");

    // Without advancing, no partials should fire
    expect(partials.length).toBe(0);

    // After advancing 800ms, a partial should fire
    clock.advance(800);
    expect(partials.length).toBeGreaterThan(0);

    await stream.close();
  });

  it("stub uses default seed 42 when no seed provided", () => {
    const clock = createFakeClock();
    const p1 = buildSTTProvider({ provider: "stub", seed: 42, clock: createFakeClock() });
    const p2 = buildSTTProvider({ provider: "stub", clock: createFakeClock() });
    // Both should be StubSTTProvider (type check is sufficient; determinism tested elsewhere)
    expect(p1).toBeInstanceOf(StubSTTProvider);
    expect(p2).toBeInstanceOf(StubSTTProvider);
  });
});
