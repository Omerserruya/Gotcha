import { describe, expect, it } from 'vitest';

import {
  callSchema,
  callSummarySchema,
  hasPlayableRecording,
  transcriptLineSchema,
  wasAnswered,
  type Call,
} from './calls';

/**
 * The rulings on screens 05d and 05e, as assertions.
 *
 * This tenant has `voiceCopilotEnabled = false`, so every voice route 404s and
 * a capture can only photograph the not-enabled state. These are the only
 * place the judgements below are checked.
 */

const call = (over: Partial<Call> = {}): Call => ({
  id: 'v1',
  conversationId: 'c1',
  direction: 'inbound',
  status: 'completed',
  startedAt: '2026-09-21T09:00:00.000Z',
  answeredAt: '2026-09-21T09:00:04.000Z',
  endedAt: '2026-09-21T09:03:16.000Z',
  durationMs: 192000,
  recordingUrl: 'https://example.com/r.mp3',
  recordingStatus: 'available',
  endReason: null,
  customerNumber: '+447700900123',
  customerId: null,
  ...over,
});

describe('a completed call is not an answered call', () => {
  it('reads answeredAt, not status', () => {
    // The provider completes a call whether or not anyone picked up. "It
    // ended" is not "somebody spoke", and a log that conflates them
    // overstates how much talking happened.
    expect(wasAnswered(call({ status: 'completed', answeredAt: null }))).toBe(false);
    expect(wasAnswered(call({ status: 'completed' }))).toBe(true);
  });

  it('treats no-answer as unanswered even with an end time', () => {
    expect(wasAnswered(call({ status: 'no-answer', answeredAt: null, endedAt: 'x' }))).toBe(false);
  });
});

describe('a recording that failed is not a recording', () => {
  it('offers playback only when one is available', () => {
    expect(hasPlayableRecording(call())).toBe(true);
  });

  it('refuses while it is still pending', () => {
    expect(hasPlayableRecording(call({ recordingStatus: 'pending' }))).toBe(false);
  });

  it('refuses when the recording failed, even if a url survived', () => {
    // `recordingStatus` can fail independently of the call. Offering a player
    // for one that does not exist is a button that does nothing.
    expect(hasPlayableRecording(call({ recordingStatus: 'failed' }))).toBe(false);
  });

  it('refuses when there is no url at all', () => {
    expect(hasPlayableRecording(call({ recordingUrl: null }))).toBe(false);
  });
});

describe('an average with no sample is not zero', () => {
  it('keeps null distinct from a real average', () => {
    // The route's own comment: "'nobody connected' and 'calls averaged zero'
    // are different statements." Rendering 0m 00s would claim calls that
    // connected and lasted no time.
    const empty = callSummarySchema.parse({ total: 4, averageDurationMs: null });
    expect(empty.averageDurationMs).toBeNull();
    expect(empty.durationSampleSize).toBe(0);
  });

  it('carries the sample size beside the average', () => {
    const real = callSummarySchema.parse({
      total: 10,
      averageDurationMs: 160000,
      durationSampleSize: 7,
    });
    expect(real.durationSampleSize).toBe(7);
  });
});

describe('the transcript is messages, not a column', () => {
  it('carries the speaker on every line', () => {
    // `senderName` is "Agent" or "Customer" - the speaker separation the
    // design asks for, written by the stream router one row per FINAL
    // utterance. Searching the schema for a transcript field finds nothing,
    // which is how two people concluded it was not stored.
    const line = transcriptLineSchema.parse({
      id: 'm1',
      direction: 'INBOUND',
      body: 'I called last week about a parcel.',
      senderName: 'Customer',
      createdAt: '2026-09-21T09:00:04.000Z',
    });
    expect(line.senderName).toBe('Customer');
    expect(line.body).toContain('parcel');
  });
});

describe('a call carries nothing that could become a false claim', () => {
  it('exposes no conversion, no sentiment, no transcript blob', () => {
    // "Ended in a sale" is `converted` - the fourth appearance across four
    // screens, and a concept nowhere in this platform.
    const surface = Object.keys(callSchema.parse(call()));
    expect(
      surface.filter((k) => /convert|sale|revenue|sentiment|mood|transcript/i.test(k)),
    ).toEqual([]);
  });
});
