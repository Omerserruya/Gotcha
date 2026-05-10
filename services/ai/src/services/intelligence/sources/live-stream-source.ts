import { subscribeToEvents, type ServiceEvent, type TranscriptUtterance } from "@chatcenter/shared";
import type Redis from "ioredis";
import type { TranscriptSource } from "./transcript-source";

/**
 * Live streaming TranscriptSource for the in-progress voice call path.
 *
 * Subscribes to `voice.transcript` events on the shared Redis bus and yields
 * matching utterances as an AsyncIterable. Filters by callSid so multiple
 * concurrent calls in the same process do not interleave.
 *
 * Phase 1 status: defined but NOT YET INSTANTIATED. The existing
 * voice-copilot-subscriber.ts path remains active. Phase 3 will switch the
 * live AI runner to consume this source instead.
 */
export class LiveStreamingSource implements TranscriptSource {
  readonly mode = "live" as const;
  readonly isBounded = false;

  private readonly queue: TranscriptUtterance[] = [];
  private readonly resolvers: Array<
    (result: IteratorResult<TranscriptUtterance>) => void
  > = [];
  private closed = false;
  private subscription: Redis | null = null;

  constructor(
    public readonly conversationId: string,
    public readonly callSid: string,
  ) {}

  /**
   * Begin subscribing to the bus. Idempotent. The runner calls this when
   * the analysis loop starts (Phase 3). Calling stream() also auto-starts.
   */
  start(): void {
    if (this.subscription || this.closed) return;
    this.subscription = subscribeToEvents((evt: ServiceEvent) => {
      if (this.closed) return;
      if (evt.event !== "voice.transcript") return;
      const data: any = evt.data ?? {};
      if (data.callSid !== this.callSid) return;
      const utt = toUtterance(data, this.conversationId);
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: utt, done: false });
      } else {
        this.queue.push(utt);
      }
    });
  }

  async *stream(): AsyncIterable<TranscriptUtterance> {
    this.start();
    while (!this.closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      const next = await new Promise<IteratorResult<TranscriptUtterance>>(
        (resolve) => {
          this.resolvers.push(resolve);
        },
      );
      if (next.done) return;
      yield next.value;
    }
  }

  async snapshot(): Promise<TranscriptUtterance[]> {
    return [...this.queue];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as unknown as TranscriptUtterance, done: true });
    }
    if (this.subscription) {
      try {
        await this.subscription.quit();
      } catch {
        /* ignore */
      }
      this.subscription = null;
    }
  }
}

/**
 * Maps a `voice.transcript` event payload to a canonical TranscriptUtterance.
 * Field names mirror the current voice-copilot StreamRouter output.
 */
function toUtterance(data: any, conversationId: string): TranscriptUtterance {
  const speaker = data.speaker === "agent" ? "agent" : "customer";
  const seq = data.seq ?? 0;
  const callSid = String(data.callSid ?? "");
  return {
    id: `${callSid}:${speaker}:${seq}`,
    conversationId,
    callSid,
    source: speaker,
    text: typeof data.text === "string" ? data.text : "",
    isFinal: !!data.isFinal,
    startMs: typeof data.startMs === "number" ? data.startMs : 0,
    endMs: typeof data.endMs === "number" ? data.endMs : undefined,
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
  };
}
