import { describe, expect, it } from 'vitest';

import { translators } from './events';

/**
 * The two message events, which were declared and never translated.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A DECLARED EVENT TYPE WITH NO TRANSLATOR IS A READER WITH NO WRITER
 * ════════════════════════════════════════════════════════════════════════════
 * `message.received` and `message.delivery_changed` sat in the union in
 * `events.ts` from the day it was written. Nothing translated them and nothing
 * subscribed, so the socket delivered the frames and this layer dropped every
 * one - and from inside the app that is indistinguishable from the platform not
 * emitting them.
 *
 * It became load-bearing when the composer shipped, because its copy says *"it
 * will show above as it goes out, and say so if it fails"*. A sentence in the
 * product promising a behaviour the code does not have is worse than a comment
 * doing it: a comment only misleads a developer.
 */

/** What the translator chain does with one frame. */
const translate = (wireEvent: string, payload: unknown) => {
  for (const translator of translators) {
    const event = translator(wireEvent, payload);
    if (event) return event;
  }
  return null;
};

describe('★★ message:status - the wire name is colon-separated', () => {
  it('★★ translates the platform’s own event name, not ours', () => {
    /*
     * `message.service.ts` emits `message:status`. Our type is
     * `message.delivery_changed`. Matching our name against the wire would have
     * compiled and never fired - the same trap as matching `cause.code` on a
     * route that sends none. This asserts the name we actually listen for.
     */
    expect(
      translate('message:status', {
        tenantId: 't1',
        data: { messageId: 'm1', conversationId: 'c1', status: 'FAILED' },
      }),
    ).toMatchObject({
      type: 'message.delivery_changed',
      tenantId: 't1',
      conversationId: 'c1',
      messageId: 'm1',
    });
  });

  it('★★ ignores the dotted form, so nobody thinks that is the contract', () => {
    expect(translate('message.delivery_changed', { tenantId: 't1' })).toBeNull();
  });

  it('reads the fields flat as well as nested, because the publisher sends both', () => {
    /*
     * `getIO().emit` sends the payload flat; `publishEvent` wraps it in `data`.
     * Both reach this layer through the same socket, so both have to work - and
     * a translator that handled one would drop half the events with no signal.
     */
    expect(
      translate('message:status', {
        tenantId: 't1',
        messageId: 'm1',
        conversationId: 'c1',
      }),
    ).toMatchObject({ type: 'message.delivery_changed', messageId: 'm1' });
  });

  it('★★ drops a frame it cannot attribute to a conversation', () => {
    /*
     * A frame with no `conversationId` could refresh the wrong conversation, and
     * on this screen the wrong conversation is somebody else's customer. Dropped
     * rather than guessed - the same rule the transcript translator applies.
     */
    expect(translate('message:status', { tenantId: 't1', data: { messageId: 'm1' } })).toBeNull();
    expect(
      translate('message:status', { data: { messageId: 'm1', conversationId: 'c1' } }),
    ).toBeNull();
    expect(
      translate('message:status', { tenantId: 't1', data: { conversationId: 'c1' } }),
    ).toBeNull();
  });

  it('★ drops a frame that is not an object at all', () => {
    expect(translate('message:status', null)).toBeNull();
    expect(translate('message:status', 'FAILED')).toBeNull();
  });
});

describe('★★ message:new - an inbound reply while the agent is reading', () => {
  it('translates it, and accepts `id` as well as `messageId`', () => {
    /*
     * `create` sends `messageId`; some publishers send the row as `id`. Accepting
     * both is not generosity - it is the difference between a stale screen and a
     * current one, and the cost of being wrong is an agent answering a message
     * that has already been superseded.
     */
    expect(
      translate('message:new', { tenantId: 't1', data: { id: 'm9', conversationId: 'c1' } }),
    ).toMatchObject({ type: 'message.received', messageId: 'm9', conversationId: 'c1' });
  });

  it('drops an unattributable frame', () => {
    expect(translate('message:new', { tenantId: 't1', data: {} })).toBeNull();
  });

  it('★★ the frame the platform sends: `{ message, conversationId }`, tenant and id on the row', () => {
    /*
     * message.service.ts and incoming.worker.ts publish exactly this, and the
     * bridge relays only `data` - no envelope, no top-level tenant or id.
     */
    const row = { id: 'm7', tenantId: 't1', conversationId: 'c1', body: 'hi' };
    expect(translate('message:new', { message: row, conversationId: 'c1' })).toEqual({
      type: 'message.received',
      tenantId: 't1',
      at: expect.any(Number),
      conversationId: 'c1',
      messageId: 'm7',
      // The row's own fields ride along for the incoming-message alert.
      direction: null,
      body: 'hi',
      messageType: null,
    });
    // the channel hint some publishers add changes nothing
    expect(
      translate('message:new', { message: row, conversationId: 'c1', channel: 'WHATSAPP' }),
    ).toMatchObject({ tenantId: 't1', conversationId: 'c1', messageId: 'm7' });
    // and the conversation is the row's when the frame does not repeat it
    expect(translate('message:new', { message: row })).toMatchObject({ conversationId: 'c1' });
  });

  it('★ who wrote it and what it says, from the row, for the incoming-message alert', () => {
    const row = {
      id: 'm8',
      tenantId: 't1',
      conversationId: 'c1',
      direction: 'INBOUND',
      body: '',
      messageType: 'image',
    };
    expect(translate('message:new', { message: row, conversationId: 'c1' })).toMatchObject({
      direction: 'INBOUND',
      body: '',
      messageType: 'image',
    });
    // A direction that is neither is none, never a guess.
    expect(
      translate('message:new', {
        message: { ...row, direction: 'SIDEWAYS' },
        conversationId: 'c1',
      }),
    ).toMatchObject({ direction: null });
  });

  it('a row with no tenant is still unattributable', () => {
    expect(
      translate('message:new', {
        message: { id: 'm7', conversationId: 'c1' },
        conversationId: 'c1',
      }),
    ).toBeNull();
  });
});

describe('★★ the translators still do not answer for anything else', () => {
  it('★★ an unknown wire event is null, not a guessed type', () => {
    /*
     * The chain returns the first non-null. A translator that matched too widely
     * would shadow the ones after it, which is why each one tests its own name
     * first and why this asserts the chain as a whole.
     */
    expect(
      translate('something:new', { tenantId: 't1', data: { conversationId: 'c1' } }),
    ).toBeNull();
  });

  it('leaves the voice events to their own translators', () => {
    expect(
      translate('voice.transcript', {
        tenantId: 't1',
        data: { conversationId: 'c1', text: 'hello', speaker: 'agent' },
      }),
    ).toMatchObject({ type: 'call.transcript' });
  });
});
