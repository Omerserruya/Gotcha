import { z } from 'zod';

/**
 * `GET /api/intelligence-reviews`.
 *
 * The review queue behind the design's "two sources still disagree" card —
 * things GOTCHA learned about the business that need a person to settle.
 *
 * Note the envelope: `{ ok, pending, reviews }`, not `{ data }`. The platform
 * uses at least three response shapes and this is a third; the transport
 * unwraps `data` when present and passes the body through otherwise, so this
 * schema describes the whole body.
 */
export const REVIEW_REASONS = ['conflict', 'low_confidence', 'scope_review'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const intelligenceReviewSchema = z.looseObject({
  id: z.string().min(1),
  fieldKey: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  proposedValue: z.unknown().optional(),
  currentValue: z.unknown().optional(),
  confidence: z.number().optional(),
  evidence: z.string().optional(),
  /** Free text on the wire; only the three known values are acted on. */
  reason: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  conversationId: z.string().nullable().optional(),
});

export const intelligenceReviewsSchema = z.looseObject({
  ok: z.boolean().optional(),
  pending: z.number().default(0),
  reviews: z.array(intelligenceReviewSchema).default([]),
});

export type IntelligenceReview = z.infer<typeof intelligenceReviewSchema>;
