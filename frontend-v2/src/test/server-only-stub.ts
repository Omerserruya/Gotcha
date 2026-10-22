/**
 * Test stub for the `server-only` package.
 *
 * The real module throws when imported outside a React Server Component, which
 * is the guard that stops server code - and the secrets it reads - being
 * bundled for the browser. Under Vitest there is no server/client boundary to
 * enforce, so it is replaced by nothing at all. See `vitest.config.mts`.
 */
export {};
