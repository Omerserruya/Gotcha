import { Speaker, Transcript } from "../stt/provider";

export class ReorderBuffer {
  public readonly speaker: Speaker;

  private highWatermark = -1;
  private pendingPartials = new Map<number, Transcript>();
  private pendingFinals = new Map<number, Transcript>();
  private emittedFinalsSeq = new Set<number>();
  private outQueue: Transcript[] = [];

  constructor(speaker: Speaker) {
    this.speaker = speaker;
  }

  ingest(t: Transcript): void {
    if (t.seq <= this.highWatermark && !t.isFinal) {
      // Late partial - drop
      return;
    }

    if (t.isFinal) {
      if (this.emittedFinalsSeq.has(t.seq)) {
        // Duplicate final - dedupe
        return;
      }
      this.emittedFinalsSeq.add(t.seq);
      this.pendingPartials.delete(t.seq);
      this.highWatermark = Math.max(this.highWatermark, t.seq);
      this.outQueue.push(t);
    } else {
      // Partial
      const existing = this.pendingPartials.get(t.seq);
      if (!existing || existing.timestamp < t.timestamp) {
        this.pendingPartials.set(t.seq, t);
        this.outQueue.push(t);
      }
    }
  }

  drain(): Transcript[] {
    const result = this.outQueue;
    this.outQueue = [];
    return result;
  }

  reset(): void {
    this.highWatermark = -1;
    this.pendingPartials.clear();
    this.pendingFinals.clear();
    this.emittedFinalsSeq.clear();
    this.outQueue = [];
  }
}
