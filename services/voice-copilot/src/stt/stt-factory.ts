import { Clock, systemClock } from "../lib/clock";
import { STTProvider } from "./provider";
import { StubSTTProvider } from "./stub-provider";
import { GoogleCloudSTTProvider } from "./google-provider";
import { DeepgramSTTProvider } from "./deepgram-provider";

export interface SttFactoryConfig {
  provider: "stub" | "google" | "deepgram";
  seed?: number;
  clock?: Clock;
  apiKey?: string;
}

export function buildSTTProvider(cfg: SttFactoryConfig): STTProvider {
  if (cfg.provider === "stub") {
    return new StubSTTProvider({
      seed: cfg.seed ?? 42,
      clock: cfg.clock ?? systemClock,
    });
  }
  if (cfg.provider === "deepgram") {
    return new DeepgramSTTProvider(cfg.apiKey ?? "");
  }
  return new GoogleCloudSTTProvider();
}
