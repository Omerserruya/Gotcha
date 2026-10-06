import { describe, expect, it } from 'vitest';

import { channelHandles, timelineSchema } from './customer-detail';

/**
 * Screen 02's identity panel - the handles we can actually name.
 *
 * `contact.metadata.aliases` was on the wire the whole time: the route sends
 * `contact: effective` from a `findFirst` with no `select`, so the entire row
 * arrives and `z.object` was stripping it. Sixth field this week we needed
 * and were already being sent.
 */

const timeline = (
  contact: Record<string, unknown> | null,
  identityChannels: Record<string, unknown>[] = [],
) => timelineSchema.parse({ contact, identityChannels, events: [] });

describe('★★ every channel, from the route’s own projection', () => {
  it('lists linked and merged handles alike', () => {
    const t = timeline({ id: 'c1' }, [
      { channel: 'WHATSAPP', externalId: '+447700900123', source: 'linked', contactId: 'c1' },
      { channel: 'EMAIL', externalId: 'a@example.com', source: 'merged', contactId: null },
    ]);
    expect(channelHandles(t)).toEqual([
      { channel: 'WHATSAPP', externalId: '+447700900123' },
      { channel: 'EMAIL', externalId: 'a@example.com' },
    ]);
  });

  it('★ drops a blank handle rather than rendering an empty row', () => {
    const t = timeline({ id: 'c1' }, [{ channel: '', externalId: '', source: 'linked' }]);
    expect(channelHandles(t)).toHaveLength(0);
  });

  it('★★ no longer reads the contact’s raw metadata', () => {
    /*
     * This used to parse `contact.metadata.aliases`, because the route sent
     * the whole row. The obvious fix - "return the siblings you already
     * compute" - would have been WORSE: `findSiblingContacts` selects no
     * columns, so each sibling carries its own metadata blob and returning
     * them raw ships the customer's phone number once per linked channel
     * instead of once.
     *
     * A five-field projection cannot do that, and dropping this parse is
     * what lets the route stop sending `metadata` at all.
     */
    const parsed = timelineSchema.parse({
      contact: { id: 'c1', metadata: { aliases: [], phone: '+447700900123' } },
      identityChannels: [],
      events: [],
    });
    expect(parsed.contact).not.toHaveProperty('metadata');
  });

  it('★★ a response without `identityChannels` FAILS rather than reading as one channel', () => {
    /*
     * Required, not defaulted. It is present on every response including
     * empty ones, so absence means the service is older than this contract
     * - and an empty list would say "she uses one channel" about somebody
     * who uses four.
     */
    expect(() => timelineSchema.parse({ contact: { id: 'c1' }, events: [] })).toThrow();
  });

  it('a contact we could not read has no handles, not an empty claim', () => {
    expect(channelHandles(null)).toEqual([]);
  });
});
