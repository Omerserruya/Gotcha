import { describe, expect, it } from 'vitest';

import { channelHandles, timelineSchema } from './customer-detail';

/**
 * Screen 02's identity panel — the handles we can actually name.
 *
 * `contact.metadata.aliases` was on the wire the whole time: the route sends
 * `contact: effective` from a `findFirst` with no `select`, so the entire row
 * arrives and `z.object` was stripping it. Sixth field this week we needed
 * and were already being sent.
 */

const timeline = (contact: Record<string, unknown> | null) =>
  timelineSchema.parse({ contact, events: [] });

describe('★★ the contact’s own handle, plus what was merged in', () => {
  it('lists both, newest merge last', () => {
    const t = timeline({
      id: 'c1',
      externalId: '+447700900123',
      channel: 'WHATSAPP',
      metadata: { aliases: [{ channel: 'EMAIL', externalId: 'a@example.com' }] },
    });
    expect(channelHandles(t)).toEqual([
      { channel: 'WHATSAPP', externalId: '+447700900123' },
      { channel: 'EMAIL', externalId: 'a@example.com' },
    ]);
  });

  it('★ deduplicates a handle that is both the contact’s and an alias', () => {
    // A merge can leave an alias identical to the survivor's own handle.
    // Printing it twice would suggest two channels where there is one.
    const t = timeline({
      id: 'c1',
      externalId: '+447700900123',
      channel: 'WHATSAPP',
      metadata: { aliases: [{ channel: 'WHATSAPP', externalId: '+447700900123' }] },
    });
    expect(channelHandles(t)).toHaveLength(1);
  });

  it('★ drops a blank alias rather than rendering an empty row', () => {
    const t = timeline({
      id: 'c1',
      externalId: 'x',
      channel: 'EMAIL',
      metadata: { aliases: [{ channel: '', externalId: '' }] },
    });
    expect(channelHandles(t)).toHaveLength(1);
  });
});

describe('★★ what this list is NOT', () => {
  it('★★ carries no sibling contacts, because the route does not return them', () => {
    /*
     * THE LIMIT THE SCREEN HAS TO STATE.
     *
     * `findSiblingContacts` — people currently linked by `personId` — is
     * computed by the route to scope the query and **never returned**. So
     * this is "channels that were folded in", not "every channel she uses",
     * and somebody unified but never merged is invisible here.
     *
     * Asserted as the property rather than the absence: with no aliases and
     * a contact on one channel, the answer is exactly one handle — no
     * silent enrichment from anywhere else.
     */
    const t = timeline({ id: 'c1', externalId: '+44770090', channel: 'WHATSAPP' });
    expect(channelHandles(t)).toEqual([{ channel: 'WHATSAPP', externalId: '+44770090' }]);
  });

  it('★★ takes only `aliases` out of metadata, never the blob', () => {
    /*
     * `metadata` is an open JSON column and on this platform it holds phone
     * numbers among other things — the same reason 04e lifts `succeeded`
     * server-side and leaves the blob behind. One key with a known shape;
     * everything else is discarded by the parse.
     */
    const parsed = timelineSchema.parse({
      contact: {
        id: 'c1',
        externalId: 'x',
        channel: 'EMAIL',
        metadata: {
          aliases: [],
          notes: 'private',
          phone: '+447700900123',
        },
      },
      events: [],
    });
    expect(parsed.contact?.metadata).toEqual({ aliases: [] });
    expect(parsed.contact?.metadata).not.toHaveProperty('phone');
    expect(parsed.contact?.metadata).not.toHaveProperty('notes');
  });

  it('a contact we could not read has no handles, not an empty claim', () => {
    expect(channelHandles(null)).toEqual([]);
    expect(channelHandles(timeline(null))).toEqual([]);
  });
});
