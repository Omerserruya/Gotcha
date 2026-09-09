import { z } from 'zod';

import { APP_ENVIRONMENTS } from './app-env';

/**
 * Browser-visible configuration.
 *
 * Only values that are safe to publish belong here. Next.js inlines
 * `NEXT_PUBLIC_*` at build time, which means each one must be referenced as a
 * full literal below - destructuring `process.env` would break the inlining.
 *
 * There is deliberately no public API base URL. The browser talks to this
 * app's own BFF on a relative path; the upstream API origin is server-only.
 */
const clientEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('local'),
  /** Origin of the realtime (Socket.IO) gateway. Public by nature. */
  REALTIME_URL: z.url().optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  RELEASE: z.string().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

const parsed = clientEnvSchema.safeParse({
  APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  REALTIME_URL: process.env.NEXT_PUBLIC_REALTIME_URL,
  SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  RELEASE: process.env.NEXT_PUBLIC_RELEASE,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - NEXT_PUBLIC_${String(issue.path[0])}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid public environment configuration.\n${issues}`);
}

export const clientEnv: ClientEnv = parsed.data;

export const isProductionEnvironment = clientEnv.APP_ENV === 'production';
export const isLocalEnvironment = clientEnv.APP_ENV === 'local';
