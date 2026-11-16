import { z } from 'zod';

/**
 * A value from `list`, or `'UNKNOWN'`: one new state from the server never
 * rejects the whole read ([[enum-domains-from-the-type]]). The row says
 * "unknown" on its own line; the rest of the page still renders.
 *
 * ★ An ABSENT key reads UNKNOWN too. Without `.optional()`, zod 4 answers a
 *   missing key with "expected nonoptional" and rejects the whole object -
 *   which is how a custom API tool with no `riskLevel` emptied the list
 *   ([[empty-absent-and-literal-are-three-nothings]]).
 */
export function knownOrUnknown<const T extends readonly string[]>(list: T) {
  return z
    .unknown()
    .optional()
    .transform((value): T[number] | 'UNKNOWN' =>
      typeof value === 'string' && (list as readonly string[]).includes(value)
        ? (value as T[number])
        : 'UNKNOWN',
    );
}
