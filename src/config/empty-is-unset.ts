/**
 * An environment variable set to the empty string is **not configured**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EMPTY, ABSENT AND LITERAL ARE THREE DIFFERENT NOTHINGS
 * ════════════════════════════════════════════════════════════════════════════
 * Zod's `.optional()` and `.default()` fire on `undefined` **only**. Every
 * mechanism that supplies environment variables produces an empty string
 * instead, and means "I have nothing for this":
 *
 *   `ARG X=""` in a Dockerfile        a declared arg with a default is SET
 *   `${X:-}` in a compose file         the documented way to make X optional
 *   `export X=` in a shell             sets it, empty
 *
 * The three failures this caused in one afternoon, measured rather than
 * reasoned about:
 *
 *   `z.enum([...]).default('local')`   `''` → **throws**. The whole client
 *                                      config fails at module load, so a
 *                                      healthy container serves a blank app.
 *   `z.url().optional()`               `''` → **throws**. Same blank app, and
 *                                      on the realtime variable specifically.
 *   `z.coerce.number().default(0.1)`   `''` → **0**, silently. `Number('')` is
 *                                      0 and it passes `min(0)`, so tracing
 *                                      turns off and nothing says so.
 *   `z.string().min(1).optional()`     `''` → throws, on the server side. A
 *                                      container whose sign-in page returns
 *                                      200 and whose login route 500s.
 *
 * Three shapes, three different silent outcomes. So the normalisation happens
 * once, here, before any schema sees the value — rather than each schema being
 * asked to remember.
 *
 * ── WHY NOT `z.preprocess` PER FIELD ──
 * Because it has to be remembered per field, and the next variable added is
 * the one that forgets. This applies to the whole object by construction.
 */
export function emptyIsUnset<T extends Record<string, unknown>>(source: T): T {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value === '' ? undefined : value]),
  ) as T;
}
