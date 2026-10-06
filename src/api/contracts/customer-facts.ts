import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * 04's bulk facts (backend 63985641, 01bb7b6e, 0edfd341): what a person is
 * worth, what is going on with them, and who the customers are.
 *
 * ★ "No store" is not "no orders". The commerce routes answer `source: null`
 *   with a reason when they could not look, and that is drawn as "-" with the
 *   reason - never "no orders yet", which would be a claim about the customer.
 */

/** At most this many ids per call, on every one of these routes. */
export const FACTS_BATCH = 100;

export const commerceSummarySchema = z.object({
  lifetimeValue: z.number().catch(0),
  /** `null` with orders: their currencies differ, and the route withholds the sum (sends 0). `""`: the store named none. */
  currency: z.string().nullable().catch(null),
  orderCount: z.number().int().nonnegative().catch(0),
  lastOrderAt: z.string().nullable().catch(null).default(null),
});
export type CommerceSummary = z.infer<typeof commerceSummarySchema>;

const reasonField = z.string().nullable().catch(null).default(null);

export const commerceSummariesSchema = z.object({
  /** `"woocommerce"` today; any other store later. `null`: nothing was read. */
  source: z.string().nullable().catch(null),
  reason: reasonField,
  /** The store's orders were read up to a cap: a count may be short. */
  truncated: z.boolean().catch(false).default(false),
  data: z.record(z.string(), commerceSummarySchema.nullable().catch(null)).catch({}),
});

export const commerceSegmentsSchema = z.object({
  source: z.string().nullable().catch(null),
  reason: reasonField,
  truncated: z.boolean().catch(false).default(false),
  total: z.number().int().nonnegative().catch(0).default(0),
  counts: z
    .object({
      bought_once: z.number().int().nonnegative().catch(0),
      came_back: z.number().int().nonnegative().catch(0),
      wholesale: z.number().int().nonnegative().catch(0),
      never_bought: z.number().int().nonnegative().catch(0),
    })
    .nullable()
    .catch(null)
    .default(null),
});
export type CommerceSegments = z.infer<typeof commerceSegmentsSchema>;

export const byOrderSchema = z.object({
  source: z.string().nullable().catch(null),
  contactId: z.string().min(1).nullable().catch(null).default(null),
});

/** A closed list on the server; anything new is no mood, not a rejected page. */
export const MOODS = ['frustrated', 'about_to_buy'] as const;
export type Mood = (typeof MOODS)[number];

export const insightSchema = z.object({
  conversationId: z.string().nullable().catch(null).default(null),
  /** One plain sentence from the AI's summary, or `null` (0edfd341). */
  situation: z
    .string()
    .nullable()
    .catch(null)
    .default(null)
    .transform((text) => plainDashes(text)),
  inboundCount: z.number().int().nonnegative().catch(0).default(0),
  mood: z.enum(MOODS).nullable().catch(null).default(null),
});
export type Insight = z.infer<typeof insightSchema>;

export const insightsSchema = z.object({
  data: z.record(z.string(), insightSchema.nullable().catch(null)).catch({}),
});

export const tagsAnswerSchema = z.object({
  data: z.record(z.string(), z.array(z.string()).catch([])).catch({}),
});

/** The route's own rule: a tag is 1-40 characters, matched exactly. */
export const TAG_MAX = 40;

/** What an order number looks like to the route: digits, a `#` allowed. */
export function looksLikeOrderNumber(query: string): boolean {
  return /^#?\d{1,12}$/.test(query.trim());
}
