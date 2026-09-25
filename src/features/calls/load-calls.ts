import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  callListSchema,
  callSummarySchema,
  transcriptSchema,
  voiceAvailabilitySchema,
  type Call,
  type CallSummary,
  type TranscriptLine,
} from '@/api/contracts/calls';
import { callEndpoints, tenantSettingsEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 05d reads.
 *
 * ── THE ORDER MATTERS ──
 * `voiceCopilotGate` 404s the **entire** voice router when the tenant has no
 * voice, and that 404 is byte-identical to the one a missing route gives. So
 * availability is read FIRST, from `tenant-settings`, which is not behind the
 * gate.
 *
 * With that answer in hand a failure becomes interpretable: voice off means
 * the screen says so plainly, and voice on plus a failure is a real fault.
 * Without it the screen would have to guess between two opposite explanations,
 * and would eventually tell somebody their workspace lacks a feature it has.
 *
 * **The ambiguity is not resolved by reading the 404 more carefully. It is
 * resolved by asking a different question.**
 */
export interface CallsData {
  /**
   * `true` voice is on · `false` the tenant has no voice · **`null` we could
   * not find out.**
   *
   * ★ THE THIRD STATE WAS ADDED WHEN THE FLAG FLIPPED, AND IT WAS ALWAYS
   * NEEDED.
   *
   * A failed settings read used to return `false`, justified in a comment as
   * "the safer of the two readings". It was safe only by accident: voice was
   * off on all thirteen tenants, so collapsing the unknown into `false` was
   * correct everywhere it ran.
   *
   * With voice ON, that same collapse renders *"Nothing here will show calls
   * until voice is enabled. Ask whoever set up GOTCHA for you"* — sending a
   * merchant to ask for a feature they already have. The header of this file
   * names that exact danger, one screen up: *"would eventually tell somebody
   * their workspace lacks a feature it has."*
   *
   * The file said the collapse was wrong and the catch did it anyway.
   */
  readonly voiceEnabled: boolean | null;
  /**
   * Whether any phone number is actually connected — at least one `VOICE`
   * channel `ACTIVE`.
   *
   * ★ VOICE SWITCHED ON IS NOT THE SAME AS A PHONE NUMBER CONNECTED, AND THE
   * EMPTY SCREEN SAYS A DIFFERENT THING FOR EACH.
   *
   * *"Calls appear here as they happen"* is true only for a workspace that
   * can receive one. Said to a workspace with no connected number it is a
   * promise about something that cannot occur — the same shape as telling
   * somebody to connect a CRM they already connected, pointed the other way.
   *
   * `null` alongside `voiceEnabled: null`: we did not get to ask.
   */
  readonly hasNumber: boolean | null;
  readonly calls: readonly Call[] | null;
  readonly summary: CallSummary | null;
  /** True when voice IS on and the reads still failed — a real fault. */
  readonly failed: boolean;
}

/**
 * The live call, if one is in progress, with whatever transcript exists.
 *
 * Two reads: the active session, then its persisted lines. The lines matter
 * because a reload mid-call would otherwise start blank — every FINAL
 * utterance is already a `Message` row, so the history is there to be read.
 */
export async function loadLiveCall(): Promise<{
  readonly call: Call | null;
  readonly transcript: readonly TranscriptLine[];
}> {
  const api = serverApi();
  try {
    const active = await api.get({
      endpoint: callEndpoints.active(),
      payload: callListSchema,
      raw: true,
    });
    const call = active.data[0] ?? null;
    if (!call) return { call: null, transcript: [] };

    const lines = await api
      .get({ endpoint: callEndpoints.transcript(call.id), payload: transcriptSchema, raw: true })
      .then((page) => page.data)
      .catch((cause) => {
        // A call with no readable transcript is still a call. The screen
        // shows it and says it is listening, rather than hiding the call.
        logger.warn('calls.transcript_failed', { cause });
        return [] as TranscriptLine[];
      });

    return { call, transcript: lines };
  } catch (cause) {
    logger.warn('calls.active_failed', { cause });
    return { call: null, transcript: [] };
  }
}

export async function loadCalls(direction?: 'inbound' | 'outbound'): Promise<CallsData> {
  const api = serverApi();

  let voiceEnabled: boolean;
  let hasNumber: boolean;
  try {
    const settings = await api.get({
      endpoint: tenantSettingsEndpoints.read(),
      payload: voiceAvailabilitySchema,
    });
    voiceEnabled = settings.voiceCopilotEnabled;
    hasNumber = settings.hasActiveVoiceChannel;
  } catch (cause) {
    /*
     * NOT `false`. We asked the question that resolves the ambiguity and did
     * not get an answer — which is a third thing, and the only honest one.
     * Claiming "no voice" here is a statement about the workspace made from
     * a failed request.
     */
    logger.warn('calls.settings_failed', { cause });
    return { voiceEnabled: null, hasNumber: null, calls: null, summary: null, failed: false };
  }

  if (voiceEnabled === false) {
    return { voiceEnabled: false, hasNumber, calls: null, summary: null, failed: false };
  }

  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      logger.warn(event, { cause });
      return value;
    };

  const [calls, summary] = await Promise.all([
    api
      .get({
        endpoint: callEndpoints.list(),
        payload: callListSchema,
        // `{ data, nextCursor }` side by side, so unwrapping would lose the
        // cursor.
        raw: true,
        ...(direction ? { query: { direction } } : {}),
      })
      .then((page) => page.data)
      .catch(degrade('calls.list_failed', null)),
    api
      .get({ endpoint: callEndpoints.summary(), payload: callSummarySchema })
      .catch(degrade('calls.summary_failed', null)),
  ]);

  return {
    voiceEnabled: true,
    hasNumber,
    calls,
    summary,
    // Both failing is a fault worth naming; one failing degrades quietly.
    failed: calls === null && summary === null,
  };
}
