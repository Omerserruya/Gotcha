/**
 * BoundedAudioQueue - a fixed-capacity FIFO queue for decoded audio chunks.
 * When full, the oldest entry is dropped and onDrop() is called before the
 * new chunk is enqueued (drop-oldest / back-pressure semantics).
 *
 * Implementation uses a plain Array with shift() (O(n)) which is acceptable
 * given the default capacity of 200 frames (~4 s of 8 kHz 20 ms frames).
 * A ring-buffer (head/tail indices) would give O(1) but is unnecessary here.
 */

export interface AudioChunk {
  pcm: Int16Array;
  timestamp: number;
  seqFromTwilio: number;
}

export class BoundedAudioQueue {
  private readonly buf: AudioChunk[] = [];

  constructor(
    private readonly capacity: number,
    private readonly onDrop: () => void,
  ) {}

  /**
   * Add a chunk. If the queue is already at capacity, the oldest chunk is
   * removed first and onDrop() is invoked.
   */
  enqueue(chunk: AudioChunk): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this.onDrop();
    }
    this.buf.push(chunk);
  }

  /**
   * Remove and return up to n chunks (FIFO). Defaults to all chunks.
   */
  drain(n?: number): AudioChunk[] {
    const count = n === undefined ? this.buf.length : Math.min(n, this.buf.length);
    return this.buf.splice(0, count);
  }

  /** Current number of buffered chunks. */
  size(): number {
    return this.buf.length;
  }

  /** Remove all buffered chunks without invoking onDrop. */
  clear(): void {
    this.buf.length = 0;
  }
}
