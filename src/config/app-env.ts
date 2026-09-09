/**
 * The deployment environments this application understands.
 *
 * Nothing in the codebase branches on a hostname or a hardcoded URL; every
 * environment-specific value arrives through configuration. Adding an
 * environment is a deployment concern, not a code change.
 */
export const APP_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export function isAppEnvironment(value: unknown): value is AppEnvironment {
  return typeof value === 'string' && (APP_ENVIRONMENTS as readonly string[]).includes(value);
}
