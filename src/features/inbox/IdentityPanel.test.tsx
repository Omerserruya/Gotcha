import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { timelineSchema } from '@/api/contracts/customer-detail';
import messages from '@/i18n/messages/en/inbox.json';

import { IdentityPanel } from './IdentityPanel';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'en', messages: { inbox: messages }, namespace }),
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
