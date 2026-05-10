import { z } from "zod";

/**
 * One utterance in a conversation transcript. The atomic unit consumed by
 * every analyzer in the intelligence engine.
 *
 * `source` is load-bearing for safety: prompt assemblers wrap each utterance
 * in a fenced `<utt role="...">` tag before it enters an LLM prompt. Customer
 * text is treated as untrusted input — never as instructions.
 */
export const TranscriptUtteranceSchema = z.object({
  /** Monotonic per source. For voice: `${callSid}:${speaker}:${seq}`. */
  id: z.string(),
  conversationId: z.string(),
  /** Present iff the utterance came from a voice call. */
  callSid: z.string().optional(),
  source: z.enum(["customer", "agent", "system"]),
  /** userId for agents, customerId for customers when known. */
  speakerId: z.string().optional(),
  text: z.string(),
  /** STT partials are isFinal=false; chat messages are always final. */
  isFinal: z.boolean(),
  /** Milliseconds relative to session/transcript start. */
  startMs: z.number().int(),
  endMs: z.number().int().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type TranscriptUtterance = z.infer<typeof TranscriptUtteranceSchema>;
