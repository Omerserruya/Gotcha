import { describe, it, expect, beforeEach } from "vitest";
import { createFakeClock } from "../lib/clock";
import { StubSTTProvider } from "../stt/stub-provider";
import { SttSessionContext, Transcript } from "../stt/provider";

function makeCtx(overrides?: Partial<SttSessionContext>): SttSessionContext {
  return {
    tenantId: "t1",
    conversationId: "c1",
    callSid: "CA123",
    language: "en-US",
    interimResults: true,
    onError: () => {},
    ...overrides,
  };
}

describe("StubSTTProvider", () => {
  it("produces deterministic output for the same seed", async () => {
    const clock1 = createFakeClock();
    const clock2 = createFakeClock();

    const provider1 = new StubSTTProvider({ seed: 99, clock: clock1 });
    const provider2 = new StubSTTProvider({ seed: 99, clock: clock2 });

    const partials1: Transcript[] = [];
    const partials2: Transcript[] = [];

    const stream1 = await provider1.start(makeCtx());
    const stream2 = await provider2.start(makeCtx());

    stream1.on("partial", (t) => partials1.push(t));
    stream2.on("partial", (t) => partials2.push(t));

    // Push audio then advance time on both
    stream1.push(new Int16Array(160), "agent");
    stream2.push(new Int16Array(160), "agent");

    clock1.advance(800);
    clock2.advance(800);

    await stream1.close();
    await stream2.close();

    expect(partials1.length).toBeGreaterThan(0);
    expect(partials1.length).toBe(partials2.length);
    expect(partials1[0].confidence).toBe(partials2[0].confidence);
    expect(partials1[0].text).toBe(partials2[0].text);
  });

  it("emits a partial at partialIntervalMs for a speaker that has received pushes", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const partials: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("partial", (t) => partials.push(t));

    // Push audio to agent
    stream.push(new Int16Array(160), "agent");

    // Advance just past partialIntervalMs (800ms)
    clock.advance(800);

    await stream.close();

    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0].isFinal).toBe(false);
    expect(partials[0].speaker).toBe("agent");
  });

  it("emits a final at finalIntervalMs cadence", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const finals: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("final", (t) => finals.push(t));

    // Push audio and advance to finalIntervalMs (2400ms)
    stream.push(new Int16Array(160), "agent");
    clock.advance(2400);

    await stream.close();

    expect(finals.length).toBeGreaterThan(0);
    expect(finals[0].isFinal).toBe(true);
    expect(finals[0].speaker).toBe("agent");
  });

  it("confidence is within [0.7, 0.95]", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const transcripts: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("partial", (t) => transcripts.push(t));
    stream.on("final", (t) => transcripts.push(t));

    stream.push(new Int16Array(160), "agent");
    // Advance enough to get several partials and a final
    clock.advance(4800);

    await stream.close();

    expect(transcripts.length).toBeGreaterThan(0);
    for (const t of transcripts) {
      expect(t.confidence).toBeGreaterThanOrEqual(0.7);
      expect(t.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it("close() cancels timers and silences further emissions", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const partials: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("partial", (t) => partials.push(t));

    stream.push(new Int16Array(160), "agent");
    clock.advance(800);

    const countAtClose = partials.length;
    await stream.close();

    // After close, advancing clock should not emit more
    stream.push(new Int16Array(160), "agent");
    clock.advance(2400);

    expect(partials.length).toBe(countAtClose);
  });

  it("seq increases monotonically per speaker across finals", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const finals: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("final", (t) => {
      if (t.speaker === "agent") finals.push(t);
    });

    // Keep pushing audio and advancing to get 3 finals (3 * 2400ms = 7200ms)
    for (let i = 0; i < 3; i++) {
      stream.push(new Int16Array(160), "agent");
      clock.advance(2400);
    }

    await stream.close();

    expect(finals.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < finals.length; i++) {
      expect(finals[i].seq).toBeGreaterThan(finals[i - 1].seq);
    }
  });

  it("two speakers have independent seq counters", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const agentFinals: Transcript[] = [];
    const customerFinals: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("final", (t) => {
      if (t.speaker === "agent") agentFinals.push(t);
      else customerFinals.push(t);
    });

    // Push to both speakers and advance time
    stream.push(new Int16Array(160), "agent");
    clock.advance(2400);
    stream.push(new Int16Array(160), "customer");
    clock.advance(2400);
    stream.push(new Int16Array(160), "agent");
    clock.advance(2400);

    await stream.close();

    // Agent finals should start at seq 0, customer at seq 0 independently
    if (agentFinals.length > 0) {
      expect(agentFinals[0].seq).toBe(0);
    }
    if (customerFinals.length > 0) {
      expect(customerFinals[0].seq).toBe(0);
    }
    // They should be independent — agent advances don't bump customer's seq
    if (agentFinals.length > 1 && customerFinals.length > 0) {
      expect(customerFinals[0].seq).toBe(0);
    }
  });

  it("multiple on() calls for same event all fire", async () => {
    const clock = createFakeClock();
    const provider = new StubSTTProvider({ seed: 42, clock });

    const calls1: Transcript[] = [];
    const calls2: Transcript[] = [];
    const stream = await provider.start(makeCtx());
    stream.on("partial", (t) => calls1.push(t));
    stream.on("partial", (t) => calls2.push(t));

    stream.push(new Int16Array(160), "agent");
    clock.advance(800);

    await stream.close();

    expect(calls1.length).toBeGreaterThan(0);
    expect(calls1.length).toBe(calls2.length);
  });
});
