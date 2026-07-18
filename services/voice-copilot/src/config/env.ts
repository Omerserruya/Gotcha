import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4007),
  REDIS_URL: z.string().default("redis://redis:6379"),
  AI_SERVICE_URL: z.string().default("http://ai:4006"),
  INTERNAL_SERVICE_KEY: z.string().default(""),
  STT_PROVIDER: z.enum(["stub", "google", "deepgram"]).default("stub"),
  STT_STUB_SEED: z.coerce.number().default(42),
  DEEPGRAM_API_KEY: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SESSION_TTL_SECONDS: z.coerce.number().default(900),
  RECONNECT_GRACE_MS: z.coerce.number().default(10_000),
  REAPER_INTERVAL_MS: z.coerce.number().default(60_000),
  REAPER_STALE_THRESHOLD_MS: z.coerce.number().default(120_000),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().default(50),
  DISPATCHER_BATCH_WINDOW_MS: z.coerce.number().default(100),
  DISPATCHER_BATCH_MAX: z.coerce.number().default(5),
  PUBLIC_BASE_URL: z.string().default("http://localhost"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
