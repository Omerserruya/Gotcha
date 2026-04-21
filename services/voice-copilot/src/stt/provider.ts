export type Speaker = "agent" | "customer";

export interface SttSessionContext {
  tenantId: string;
  conversationId: string;
  callSid: string;
  language: "he-IL" | "en-US";
  interimResults: boolean;
  apiKey?: string;
  onError: (e: SttError) => void;
}

export interface Transcript {
  speaker: Speaker;
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence: number;
  seq: number;
}

export interface SttError {
  code: "RATE_LIMIT" | "AUTH" | "TIMEOUT" | "INTERNAL" | "UNAVAILABLE";
  message: string;
  retryable: boolean;
}

export type SttEvent = "partial" | "final" | "error";

export interface SttStream {
  push(pcm: Int16Array, speaker: Speaker): void;
  close(): Promise<void>;
  on(event: "partial", cb: (t: Transcript) => void): void;
  on(event: "final", cb: (t: Transcript) => void): void;
  on(event: "error", cb: (e: SttError) => void): void;
}

export interface STTProvider {
  start(ctx: SttSessionContext): Promise<SttStream>;
}

export interface SttConfig {
  provider: "stub" | "google" | "deepgram";
  language: "he-IL" | "en-US";
  interimResults: boolean;
  apiKey?: string;
  seed?: number;
}
