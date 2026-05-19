import { z } from "zod";

/**
 * Canonical conversation-intelligence output frame.
 *
 * Every system (Live, QA, Async) produces ConversationStateFrames. The
 * frontend reduces them by `version` (monotonic per conversation) which
 * eliminates the partial-reconciliation race in the live UI.
 *
 * Modes:
 *   - "live":  stream of frames, one per LLM turn during the call.
 *   - "qa":    QA mode emits QAFrame; this schema is kept symmetric.
 *   - "async": full-transcript analysis (Mode B), one frame per phase.
 */
export const ConversationStateFrameSchema = z.object({
  conversationId: z.string(),
  mode: z.enum(["live", "qa", "async"]),
  /** Monotonic per conversation. Frontend reducer: replace iff version > current. */
  version: z.number().int(),
  ts: z.string().datetime(),

  intent: z
    .object({
      primary: z.string(),
      secondary: z.array(z.string()).default([]),
      confidence: z.number().min(0).max(1),
    })
    .nullable(),

  stage: z
    .object({
      id: z.string(),
      name: z.string(),
      enteredAt: z.string().datetime(),
    })
    .nullable(),

  summary: z
    .object({
      text: z.string(),
      kind: z.enum(["rolling", "final"]),
    })
    .nullable(),

  sentiment: z
    .object({
      customer: z.number().min(-1).max(1),
      escalationRisk: z.number().min(0).max(1),
    })
    .nullable(),

  missingFields: z
    .array(
      z.object({
        field: z.string(),
        required: z.boolean(),
        suggestedQuestion: z.string().optional(),
      }),
    )
    .default([]),

  suggestedActions: z
    .array(
      z.object({
        text: z.string(),
        rationale: z.string(),
        urgency: z.enum(["low", "medium", "high"]),
      }),
    )
    .default([]),

  proposedTools: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.unknown()),
        rationale: z.string(),
        requiresApproval: z.boolean(),
      }),
    )
    .default([]),

  risks: z
    .array(
      z.object({
        kind: z.string(),
        severity: z.enum(["low", "medium", "high"]),
        evidenceUtteranceIds: z.array(z.string()),
      }),
    )
    .default([]),

  urgency: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),

  // Output of the spelling/code-switch detector (Hebrew↔English).
  // Optional because not every turn invokes the detector. When present,
  // the cue projector surfaces high-confidence normalized entities as
  // "Confirm: omer@gmail.com" cues so the rep can validate the parse.
  spellingHints: z
    .object({
      spellingMode: z.boolean(),
      confidence: z.number().min(0).max(1),
      requiresConfirmation: z.boolean(),
      detectedEntities: z.array(z.string()).default([]),
      normalizedEntities: z
        .array(
          z.object({
            kind: z.enum(["email", "domain", "url", "name", "phone", "other"]),
            raw: z.string(),
            normalized: z.string(),
            confidence: z.number().min(0).max(1),
          }),
        )
        .default([]),
    })
    .optional(),
});

export type ConversationStateFrame = z.infer<typeof ConversationStateFrameSchema>;
