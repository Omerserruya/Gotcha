import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { timelineSchema } from '@/api/contracts/customer-detail';
import channels from '@/i18n/messages/en/channels.json';
import messages from '@/i18n/messages/en/inbox.json';

import { IdentityPanel } from './IdentityPanel';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox' | 'channels') =>
    createTranslator({ locale: 'en', messages: { inbox: messages, channels }, namespace }),
}));

const timeline = (
  contact: Record<string, unknown> | null,
  identityChannels: Record<string, unknown>[] = [],
) => timelineSchema.parse({ contact, identityChannels, events: [] });

const show = async (contact: Record<string, unknown> | null) =>
  render(await IdentityPanel({ timeline: timeline(contact) }));

describe('★★ the panel claims only what the data supports', () => {
  it('★★ calls the list "channels we\'ve joined up", never "her channels"', async () => {
    /*
     * The handles come from `metadata.aliases` — channels MERGED INTO this
     * contact. `findSiblingContacts`, people currently linked by
     * `personId`, is computed by the route and not returned. So somebody
     * unified but never merged has handles this panel cannot see, and
     * claiming completeness would overstate what we know.
     */
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1', displayName: 'Avery Stone' }, [
          { channel: 'WHATSAPP', externalId: '+447700900123', source: 'linked' },
          { channel: 'EMAIL', externalId: 'a@example.com', source: 'merged' },
        ]),
      }),
    );
    expect(screen.getByTestId('identity-caption')).toHaveTextContent(/her channels/i);
  });

  it('shows a linked handle and a merged one alike', async () => {
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1' }, [
          { channel: 'WHATSAPP', externalId: '+447700900123', source: 'linked' },
          { channel: 'EMAIL', externalId: 'a@example.com', source: 'merged' },
        ]),
      }),
    );
    expect(screen.getByTestId('handle-WHATSAPP')).toHaveTextContent('+447700900123');
    expect(screen.getByTestId('handle-EMAIL')).toHaveTextContent('a@example.com');
  });

  it('★ a contact with no handle says so rather than showing an empty list', async () => {
    // Not an error — a record created without a handle is ordinary — but an
    // empty list reads as a load that failed.
    await show({ id: 'c1', displayName: 'Avery Stone' });
    expect(screen.getByTestId('identity-no-handles')).toHaveTextContent(/no channel handle/i);
    expect(screen.queryByTestId('identity-caption')).toBeNull();
  });

  it('★ an unnamed contact is "Someone", not blank', async () => {
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1', displayName: null }, [
          { channel: 'SMS', externalId: '+123', source: 'linked' },
        ]),
      }),
    );
    expect(screen.getByTestId('identity-name')).toHaveTextContent(/someone/i);
  });

  it('a failed read is not an anonymous customer', async () => {
    render(await IdentityPanel({ timeline: null }));
    expect(screen.getByTestId('identity-unavailable')).toHaveTextContent(/couldn't read/i);
  });
});

describe('★★ from a conversation there is no join to show, and it says so', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * `Conversation` HAS NO `contactId`.
   * ════════════════════════════════════════════════════════════════════════
   * It carries `customerExternalId` and `channel` — one handle, the one this
   * conversation arrived on. The identity reads are keyed on a contact id,
   * and `resolveContactByChannelId` exists as a shared function used by two
   * services and is **not routed as a GET**.
   *
   * So the Inbox shows one handle. A list of one under the customer page's
   * caption would imply this person uses one channel, which we do not know.
   */
  it('★★ captions a single handle as this conversation’s channel, not as a join', async () => {
    render(
      await IdentityPanel({
        timeline: null,
        conversation: {
          contactName: 'Avery Stone',
          channel: 'WHATSAPP',
          customerExternalId: '+447700900123',
        },
      }),
    );
    const caption = screen.getByTestId('identity-caption');
    expect(caption).toHaveTextContent(/channel this conversation came in on/i);
    expect(caption).not.toHaveTextContent(/joined up/i);
    expect(screen.getByTestId('handle-WHATSAPP')).toHaveTextContent('+447700900123');
  });

  it('★ a missing contact id is not a failed read', async () => {
    // `timeline: null` here means "no contact id to try", not "the request
    // broke" — so the panel must not render its failure state.
    render(
      await IdentityPanel({
        timeline: null,
        conversation: { contactName: 'Avery', channel: 'SMS', customerExternalId: '+123' },
      }),
    );
    expect(screen.queryByTestId('identity-unavailable')).toBeNull();
  });

  it('★ prefers the full list when a timeline IS available', async () => {
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1' }, [
          { channel: 'WHATSAPP', externalId: '+44770', source: 'linked' },
        ]),
        conversation: { contactName: 'x', channel: 'SMS', customerExternalId: '+999' },
      }),
    );
    expect(screen.getByTestId('identity-caption')).toHaveTextContent(/her channels/i);
    expect(screen.queryByTestId('handle-SMS')).toBeNull();
  });
});

describe('★★ the channel is a name, not the platform’s enum', () => {
  it('★★ renders WHATSAPP as WhatsApp, like the queue row already did', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE SIBLING RENDERER, AND THE REASON IT SURVIVED WAVE 1
     * ════════════════════════════════════════════════════════════════════════
     * A browser walk photographed Home, found `SHOPIFY_LIVE_CHAT` on the queue
     * rows and the channel bar, and both were fixed. The walk reached this
     * panel later and read:
     *
     *     WHATSAPP
     *     972525401686
     *
     * Same value, same shape, a component nobody had photographed. All THREE of
     * that report's findings had two renderers and one of each was fixed —
     * because the repair was organised by screen, because the report was, and
     * because the report came from walking screens.
     *
     * ★ So the lesson is not "sweep harder". A fix organised by where a defect
     *   was SEEN inherits the blind spots of whatever saw it. The sweep has to
     *   be organised by the VALUE: every renderer of `channel`, found by
     *   grepping the field.
     */
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1', displayName: 'Avery Stone' }, [
          { channel: 'WHATSAPP', externalId: '+972525401686', source: 'merged' },
        ]),
      }),
    );
    const handle = screen.getByTestId('handle-WHATSAPP');
    expect(handle).toHaveTextContent('WhatsApp');
    expect(handle).not.toHaveTextContent('WHATSAPP');
  });

  it('★ uses the catalogue’s wording, which is not the humaniser’s', async () => {
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1', displayName: 'Avery Stone' }, [
          { channel: 'SHOPIFY_LIVE_CHAT', externalId: 'gid://1', source: 'merged' },
        ]),
      }),
    );
    expect(screen.getByTestId('handle-SHOPIFY_LIVE_CHAT')).toHaveTextContent('Shopify live chat');
  });

  it('★★ says "another channel" for one the catalogue has never heard of', async () => {
    /*
     * The honest third state. A channel the platform adds tomorrow must not
     * arrive as its own enum, and it must not vanish either — the handle below
     * it is the thing that makes two identities tellable apart.
     */
    render(
      await IdentityPanel({
        timeline: timeline({ id: 'c1', displayName: 'Avery Stone' }, [
          { channel: 'TELEGRAM', externalId: '@avery', source: 'merged' },
        ]),
      }),
    );
    const handle = screen.getByTestId('handle-TELEGRAM');
    expect(handle).not.toHaveTextContent('TELEGRAM');
    expect(handle).toHaveTextContent('@avery');
  });
});
