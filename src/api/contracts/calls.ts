import { z } from 'zod';

/**
 * Phone calls — screens 05d and 05e.
 *
 * Shapes read from `services/conversation/src/routes/voice-sessions.ts` and
 * the `VoiceCallSession` model.
 *
 * ── THE WHOLE ROUTER 404s WHEN VOICE IS OFF ──
 * `voiceCopilotGate` reads `tenant.voiceCopilotEnabled` and answers **404** for
 * the entire router when it is false. So **a 404 from the gate and a 404 from
 * a route that does not exist are identical on the wire** — one means *"this
 * workspace has not switched voice on"* and the other means *"we shipped a
 * broken build"*, and a screen guessing between them will eventually tell
 * somebody the wrong one.
 *
 * The ambiguity is not resolved by reading the 404 more carefully. It is
 * resolved by **asking a different question**: `GET /api/tenant-settings`
 * returns `voiceCopilotEnabled` and is not behind the gate. So the screen
 * learns whether voice is on from the place that knows, and only then
 * interprets a failure.
 *
 * ── WHAT IS NOT MODELLED ──
 * **No mute.** Searched the whole platform, not one service: nothing
 * implements it. It is one of three buttons the design puts in the call
 * header, beside two that work — a dead control in a live call, which is the
 * "Pause the rest" class with someone speaking.
 *
 * **No translation.** *"Hebrew · translating as she speaks"* has nothing
 * anywhere behind it.
 *
 * **No live intent extraction**, so the inline chips (*"Refund asked for"*)
 * are absent, and **nothing on the voice path creates an `ApprovalRequest`**,
 * so in-call approval routing is absent too.
 *
 * **No AI calling campaign** — no model, no list-driven object, no per-call
 * outcome capture tied to one.
 *
 * **`converted`** — *"Ended in a sale"* — is its **fourth appearance across
 * four screens**, and is a concept nowhere in this platform.
 */

/** `VoiceCallSession.status`. Strings, not an enum, in the model. */
export const CALL_STATUSES = [
  'ringing',
  'in-progress',
  'completed',
  'failed',
  'no-answer',
] as const;

export const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;

export const callSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  direction: z.string().default(''),
  status: z.string().default(''),
  startedAt: z.string().nullable().default(null),
  answeredAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** Present once the provider has one. `recordingStatus` says which. */
  recordingUrl: z.string().nullable().default(null),
  /** `pending` | `available` | `failed` — a recording can fail on its own. */
  recordingStatus: z.string().nullable().default(null),
  endReason: z.string().nullable().default(null),
  customerNumber: z.string().default(''),
});

export type Call = z.infer<typeof callSchema>;

/** `{ data, nextCursor }` — cursor-paginated, filterable on direction/status. */
export const callListSchema = z.object({
  data: z.array(callSchema).default([]),
  nextCursor: z.string().nullable().default(null),
});

/**
 * `GET /summary`.
 *
 * `averageDurationMs` is `null` when nothing has a duration, and
 * `durationSampleSize` sits beside it — the route's own comment says why:
 * *"'nobody connected' and 'calls averaged zero' are different statements."*
 * The same distinction as a send rate before anything is sent.
 */
export const callSummarySchema = z.object({
  total: z.number().default(0),
  byDirection: z.array(z.object({ direction: z.string(), count: z.number() })).default([]),
  byStatus: z.array(z.object({ status: z.string(), count: z.number() })).default([]),
  averageDurationMs: z.number().nullable().default(null),
  durationSampleSize: z.number().default(0),
});

export type CallSummary = z.infer<typeof callSummarySchema>;

/**
 * One line of a transcript.
 *
 * Not a column anywhere — a call is a conversation and its transcript is
 * `Message` rows on the VOICE channel, written one per **final** utterance by
 * `stream-router.ts`. `senderName` is the speaker separation the design asks
 * for, and `metadata.confidence` is per utterance.
 *
 * Searching the schema for a transcript field finds nothing, which is how two
 * people concluded it was not stored. The modelling is right; the search was
 * wrong.
 */
export const transcriptLineSchema = z.object({
  id: z.string().min(1),
  direction: z.string().default(''),
  body: z.string().default(''),
  /** "Agent" or "Customer". */
  senderName: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
});

export const transcriptSchema = z.object({
  data: z.array(transcriptLineSchema).default([]),
  nextCursor: z.string().nullable().default(null),
});

export type TranscriptLine = z.infer<typeof transcriptLineSchema>;

/**
 * Whether the tenant has voice at all. Read OUTSIDE the gate, on purpose.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING HERE IS DEFAULTED, AND THAT IS THE POINT
 * ════════════════════════════════════════════════════════════════════════════
 * `voiceCopilotEnabled` used to be `.default(false)`. A response that stopped
 * carrying it would have parsed cleanly and read as **"this workspace has no
 * voice"** — a statement about somebody's workspace manufactured out of a
 * missing key. That is the same collapse the loader was just repaired for,
 * one level further down, and a default is the quieter version of it: the
 * loader at least logged.
 *
 * Required, so absence fails the parse, the loader catches it, and the screen
 * says *we could not find out*. **A required field proves itself; a defaulted
 * one cannot.** `/api/tenant-settings` sends all three unconditionally —
 * `!!tenant?.x` — so nothing is being asked of the platform that it does not
 * already do.
 *
 * `hasActiveVoiceChannel` is the platform's own precondition, and its comment
 * says what it is for: *"skip /api/voice-copilot/token entirely when the
 * tenant has no active voice channel yet."* Voice switched on and no number
 * connected is a real and separate state — see `CallsData.hasNumber`.
 */
export const voiceAvailabilitySchema = z.object({
  voiceCopilotEnabled: z.boolean(),
  voiceIncomingEnabled: z.boolean(),
  /** At least one `VOICE` channel is `ACTIVE`. Without one no call can arrive. */
  hasActiveVoiceChannel: z.boolean(),
});

/** A recording exists and can be played. `pending` and `failed` cannot. */
export function hasPlayableRecording(call: Call): boolean {
  return call.recordingStatus === 'available' && Boolean(call.recordingUrl);
}

/**
 * Whether a call connected at all.
 *
 * `answeredAt` rather than status, because a call can be `completed` having
 * never been answered — the provider completes it either way, and "it ended"
 * is not "somebody spoke".
 */
export function wasAnswered(call: Call): boolean {
  return call.answeredAt !== null;
}
