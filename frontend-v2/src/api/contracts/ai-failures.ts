import { z } from 'zod';

/**
 * Console · "פעולות AI שנכשלו" (Omer, 2026-11-18: SYSTEM_ADMIN only, nothing
 * a business sees). Backend's audit rows of the AI's tool calls that failed,
 * timed out or were refused (auth `routes/system.ts`, `/ai-actions/*`).
 *
 * ★ Lenient per row: one odd row is dropped, never the page - this screen is
 *   read when something is already wrong.
 */

/** The route clamps to 1..336 (14 days); these are the choices offered. */
export const AI_FAILURE_HOURS = [1, 6, 24, 72, 168, 336] as const;
export const AI_FAILURE_DEFAULT_HOURS = 24;

export function hoursOf(raw: string | undefined): number {
  const n = Number(raw);
  return (AI_FAILURE_HOURS as readonly number[]).includes(n) ? n : AI_FAILURE_DEFAULT_HOURS;
}

const keptRows = <T extends z.ZodType>(row: T) =>
  z
    .array(z.unknown())
    .nullish()
    .transform((rows) =>
      (rows ?? []).flatMap((r) => {
        const parsed = row.safeParse(r);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      }),
    );

/** `errorCode` is the tool's code, or "timeout" / "denied"; `null` when the row named none. */
const errorCode = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v || null);

export const aiFailureGroupSchema = z.object({
  tool: z.string(),
  errorCode,
  count: z.number(),
  tenants: z.number().catch(0),
  lastAt: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type AiFailureGroup = z.infer<typeof aiFailureGroupSchema>;

export const aiFailureRowSchema = z.object({
  id: z.string(),
  tenantId: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  conversationId: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  at: z.string(),
  tool: z.string(),
  errorCode,
  argsSummary: z.string().catch(''),
  ms: z
    .number()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type AiFailureRow = z.infer<typeof aiFailureRowSchema>;

export const aiFailuresSchema = z.object({
  hours: z.number().catch(AI_FAILURE_DEFAULT_HOURS),
  total: z.number().catch(0),
  groups: keptRows(aiFailureGroupSchema),
  recent: keptRows(aiFailureRowSchema),
});
export type AiFailures = z.infer<typeof aiFailuresSchema>;

export const aiAlertsSchema = z.object({
  threshold: z.number().nullish().catch(null),
  count: z.number().catch(0),
});
