import { Clock } from "../lib/clock";
import { seededRandom } from "../lib/random";
import {
  Speaker,
  SttSessionContext,
  SttStream,
  STTProvider,
  Transcript,
  SttError,
} from "./provider";

export interface StubSTTProviderOptions {
  seed: number;
  phraseList?: string[];
  partialIntervalMs?: number;
  finalIntervalMs?: number;
  confidenceRange?: [number, number];
  clock: Clock;
}

const DEFAULT_PHRASES = [
  "hello",
  "how can I help",
  "are you there",
  "okay",
  "thank you",
];

type PartialCb = (t: Transcript) => void;
type FinalCb = (t: Transcript) => void;
type ErrorCb = (e: SttError) => void;

interface PerSpeakerState {
  seq: number;
  phraseIndex: number;
  growthCursor: number;
  hasPendingAudio: boolean;
  tickCount: number;
}

export class StubSTTProvider implements STTProvider {
  constructor(private readonly options: StubSTTProviderOptions) {}

  async start(ctx: SttSessionContext): Promise<SttStream> {
    const seed =
      this.options.seed ??
      (ctx.apiKey ? ctx.apiKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0) : 42);
    const rng = seededRandom(seed);
    const clock = this.options.clock;
    const phrases = this.options.phraseList ?? DEFAULT_PHRASES;
    const partialIntervalMs = this.options.partialIntervalMs ?? 800;
    const finalIntervalMs = this.options.finalIntervalMs ?? 2400;
    const [confMin, confMax] = this.options.confidenceRange ?? [0.7, 0.95];
    const tickMs = 200;
    const partialTicks = Math.round(partialIntervalMs / tickMs);
    const finalTicks = Math.round(finalIntervalMs / tickMs);

    const partialListeners: PartialCb[] = [];
    const finalListeners: FinalCb[] = [];
    const errorListeners: ErrorCb[] = [];

    const speakers: Speaker[] = ["agent", "customer"];
    const speakerState = new Map<Speaker, PerSpeakerState>();
    for (const sp of speakers) {
      speakerState.set(sp, {
        seq: 0,
        phraseIndex: 0,
        growthCursor: 1,
        hasPendingAudio: false,
        tickCount: 0,
      });
    }

    let closed = false;
    const timers: Array<{ cancel(): void }> = [];

    const tickTimer = clock.setInterval(() => {
      if (closed) return;
      for (const sp of speakers) {
        const state = speakerState.get(sp)!;
        if (!state.hasPendingAudio) continue;

        state.tickCount++;

        const phrase = phrases[state.phraseIndex % phrases.length];

        if (state.tickCount % partialTicks === 0) {
          // Emit partial
          state.growthCursor = Math.min(state.growthCursor + 1, phrase.length);
          const partial: Transcript = {
            speaker: sp,
            text: phrase.slice(0, state.growthCursor),
            timestamp: clock.now(),
            isFinal: false,
            confidence: confMin + rng() * (confMax - confMin),
            seq: state.seq,
          };
          for (const cb of partialListeners) cb(partial);
        }

        if (state.tickCount % finalTicks === 0) {
          // Emit final
          const final: Transcript = {
            speaker: sp,
            text: phrase,
            timestamp: clock.now(),
            isFinal: true,
            confidence: confMin + rng() * (confMax - confMin),
            seq: state.seq,
          };
          for (const cb of finalListeners) cb(final);
          state.seq++;
          state.phraseIndex = (state.phraseIndex + 1) % phrases.length;
          state.growthCursor = 1;
          state.hasPendingAudio = false;
        }
      }
    }, tickMs);

    timers.push(tickTimer);

    const stream: SttStream = {
      push(_pcm: Int16Array, speaker: Speaker): void {
        if (closed) return;
        const state = speakerState.get(speaker);
        if (state) {
          state.hasPendingAudio = true;
        }
      },

      async close(): Promise<void> {
        closed = true;
        for (const t of timers) t.cancel();
      },

      on(event: "partial" | "final" | "error", cb: (arg: any) => void): void {
        if (event === "partial") partialListeners.push(cb as PartialCb);
        else if (event === "final") finalListeners.push(cb as FinalCb);
        else if (event === "error") errorListeners.push(cb as ErrorCb);
      },
    };

    return stream;
  }
}
