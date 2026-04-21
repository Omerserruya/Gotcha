import { describe, it, expect, vi } from "vitest";
import { BoundedAudioQueue } from "../audio/queue";
import type { AudioChunk } from "../audio/queue";

function makeChunk(seq: number): AudioChunk {
  return { pcm: new Int16Array([seq]), timestamp: seq * 20, seqFromTwilio: seq };
}

describe("BoundedAudioQueue", () => {
  it("enqueue under capacity increments size and drain returns FIFO order", () => {
    const q = new BoundedAudioQueue(5, vi.fn());
    q.enqueue(makeChunk(1));
    q.enqueue(makeChunk(2));
    q.enqueue(makeChunk(3));
    expect(q.size()).toBe(3);
    const chunks = q.drain();
    expect(chunks.length).toBe(3);
    expect(chunks[0].seqFromTwilio).toBe(1);
    expect(chunks[1].seqFromTwilio).toBe(2);
    expect(chunks[2].seqFromTwilio).toBe(3);
  });

  it("enqueue at capacity drops oldest and calls onDrop once", () => {
    const onDrop = vi.fn();
    const q = new BoundedAudioQueue(3, onDrop);
    q.enqueue(makeChunk(1));
    q.enqueue(makeChunk(2));
    q.enqueue(makeChunk(3));
    // Queue is now full; adding one more should drop chunk 1
    q.enqueue(makeChunk(4));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(3);
    const chunks = q.drain();
    expect(chunks[0].seqFromTwilio).toBe(2); // oldest (1) was dropped
    expect(chunks[2].seqFromTwilio).toBe(4);
  });

  it("drain without arg returns all chunks and empties the queue", () => {
    const q = new BoundedAudioQueue(10, vi.fn());
    q.enqueue(makeChunk(10));
    q.enqueue(makeChunk(11));
    const all = q.drain();
    expect(all.length).toBe(2);
    expect(q.size()).toBe(0);
  });

  it("drain(n) returns up to n chunks and leaves the rest", () => {
    const q = new BoundedAudioQueue(10, vi.fn());
    for (let i = 0; i < 5; i++) q.enqueue(makeChunk(i));
    const partial = q.drain(3);
    expect(partial.length).toBe(3);
    expect(q.size()).toBe(2);
    // Remaining are the last two
    const rest = q.drain();
    expect(rest[0].seqFromTwilio).toBe(3);
    expect(rest[1].seqFromTwilio).toBe(4);
  });

  it("clear empties queue and size() returns 0", () => {
    const q = new BoundedAudioQueue(10, vi.fn());
    q.enqueue(makeChunk(1));
    q.enqueue(makeChunk(2));
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("multiple overflow events each call onDrop", () => {
    const onDrop = vi.fn();
    const q = new BoundedAudioQueue(2, onDrop);
    q.enqueue(makeChunk(1));
    q.enqueue(makeChunk(2));
    // Three more overflows
    q.enqueue(makeChunk(3));
    q.enqueue(makeChunk(4));
    q.enqueue(makeChunk(5));
    expect(onDrop).toHaveBeenCalledTimes(3);
    expect(q.size()).toBe(2);
    const chunks = q.drain();
    expect(chunks[0].seqFromTwilio).toBe(4);
    expect(chunks[1].seqFromTwilio).toBe(5);
  });
});
