import { describe, it, expect, beforeEach } from "vitest";
import { ReorderBuffer } from "../transcript/reorder-buffer";
import { Transcript } from "../stt/provider";

function makeTranscript(overrides: Partial<Transcript> & { seq: number; isFinal: boolean }): Transcript {
  return {
    speaker: "agent",
    text: "hello",
    timestamp: 1000,
    confidence: 0.9,
    ...overrides,
  };
}

describe("ReorderBuffer", () => {
  let buf: ReorderBuffer;

  beforeEach(() => {
    buf = new ReorderBuffer("agent");
  });

  it("in-order partials pass through unchanged", () => {
    const t0 = makeTranscript({ seq: 0, isFinal: false, text: "hel" });
    const t1 = makeTranscript({ seq: 1, isFinal: false, text: "hello" });
    buf.ingest(t0);
    buf.ingest(t1);
    const out = buf.drain();
    expect(out).toHaveLength(2);
    expect(out[0].seq).toBe(0);
    expect(out[1].seq).toBe(1);
  });

  it("final supersedes partial at same seq — partial not re-emitted", () => {
    const partial = makeTranscript({ seq: 0, isFinal: false, text: "hel" });
    const final = makeTranscript({ seq: 0, isFinal: true, text: "hello" });

    buf.ingest(partial);
    const afterPartial = buf.drain();
    expect(afterPartial).toHaveLength(1);
    expect(afterPartial[0].isFinal).toBe(false);

    buf.ingest(final);
    const afterFinal = buf.drain();
    // Only the final, no duplicate partial
    expect(afterFinal).toHaveLength(1);
    expect(afterFinal[0].isFinal).toBe(true);
    expect(afterFinal[0].text).toBe("hello");
  });

  it("late partial (seq <= highWatermark) is dropped", () => {
    // Emit a final at seq 0 to set highWatermark=0
    const final = makeTranscript({ seq: 0, isFinal: true, text: "hello" });
    buf.ingest(final);
    buf.drain();

    // Now ingest a partial with seq 0 (late)
    const late = makeTranscript({ seq: 0, isFinal: false, text: "hel" });
    buf.ingest(late);
    const out = buf.drain();
    expect(out).toHaveLength(0);
  });

  it("duplicate final is deduped", () => {
    const final = makeTranscript({ seq: 0, isFinal: true, text: "hello" });
    buf.ingest(final);
    buf.ingest(final);
    const out = buf.drain();
    expect(out).toHaveLength(1);
  });

  it("two instances are fully independent (cross-speaker isolation)", () => {
    const agentBuf = new ReorderBuffer("agent");
    const customerBuf = new ReorderBuffer("customer");

    const agentFinal = makeTranscript({ seq: 0, isFinal: true, text: "agent says", speaker: "agent" });
    const customerPartial = makeTranscript({ seq: 0, isFinal: false, text: "cust", speaker: "customer" });

    agentBuf.ingest(agentFinal);
    customerBuf.ingest(customerPartial);

    const agentOut = agentBuf.drain();
    const customerOut = customerBuf.drain();

    expect(agentOut).toHaveLength(1);
    expect(agentOut[0].isFinal).toBe(true);
    expect(customerOut).toHaveLength(1);
    expect(customerOut[0].isFinal).toBe(false);

    // Agent highWatermark=0, but customer is still at -1 (independent)
    // A partial at seq 0 to agent should be late-dropped; but customer should accept it
    agentBuf.ingest(makeTranscript({ seq: 0, isFinal: false, speaker: "agent" }));
    customerBuf.ingest(makeTranscript({ seq: 1, isFinal: false, speaker: "customer" }));

    const a2 = agentBuf.drain();
    const c2 = customerBuf.drain();

    expect(a2).toHaveLength(0); // dropped as late
    expect(c2).toHaveLength(1); // accepted
  });

  it("empty drain returns empty array and is safe to call repeatedly", () => {
    expect(buf.drain()).toEqual([]);
    expect(buf.drain()).toEqual([]);
  });

  it("reset() clears all state", () => {
    const final = makeTranscript({ seq: 5, isFinal: true, text: "hi" });
    buf.ingest(final);
    buf.drain();

    // highWatermark is now 5; a partial at seq 3 would be late
    buf.reset();

    // After reset, seq 3 partial should be accepted (highWatermark back to -1)
    const t = makeTranscript({ seq: 3, isFinal: false, text: "hel" });
    buf.ingest(t);
    const out = buf.drain();
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(3);
  });

  it("final advances highWatermark so subsequent late partials are dropped", () => {
    buf.ingest(makeTranscript({ seq: 2, isFinal: true, text: "done" }));
    buf.drain();

    // Partials at seq <= 2 should be dropped
    buf.ingest(makeTranscript({ seq: 1, isFinal: false, text: "lat" }));
    buf.ingest(makeTranscript({ seq: 2, isFinal: false, text: "lat2" }));
    const out = buf.drain();
    expect(out).toHaveLength(0);

    // But seq 3 partial should pass
    buf.ingest(makeTranscript({ seq: 3, isFinal: false, text: "live" }));
    const out2 = buf.drain();
    expect(out2).toHaveLength(1);
  });
});
