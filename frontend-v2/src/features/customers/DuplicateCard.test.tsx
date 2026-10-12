import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { identitySuggestionsSchema } from '@/api/contracts/identity';
import channelMessages from '@/i18n/messages/en/channels.json';
import commonMessages from '@/i18n/messages/en/common.json';
import messages from '@/i18n/messages/en/customers.json';
import heChannelMessages from '@/i18n/messages/he/channels.json';
import heCommonMessages from '@/i18n/messages/he/common.json';
import heMessages from '@/i18n/messages/he/customers.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
/* Linking changes who the list says is one person: the actions are spies. */
const acceptSuggestion = vi.hoisted(() => vi.fn());
const markNotSame = vi.hoisted(() => vi.fn());
vi.mock('./identity-actions', () => ({ acceptSuggestion, markNotSame }));

import { DuplicateCard } from './DuplicateCard';

const IGSID = '1031990639501705';

/**
 * A pair as `GET /api/identity/suggestions` sends it (Backend 83579ac8, with
 * 3ac2a71e's `contactId` and `evidence`: the phone masked by the server, as
 * `maskPhoneEvidence` writes it), parsed by the contract.
 */
const pairFromServer = (over: Record<string, unknown> = {}) =>
  identitySuggestionsSchema.parse([
    {
      id: 'identity:link:ig1:wa1',
      source: 'link',
      contactIds: ['ig1', 'wa1'],
      signal: 'unproven_identifier',
      identifier: { type: 'phone', value: '+972541111111' },
      status: 'PENDING',
      at: '2026-10-11T10:00:00Z',
      contacts: [
        { id: 'ig1', contactId: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
        { id: 'wa1', contactId: 'wa1', label: 'Yael Barak', channel: 'WHATSAPP' },
      ],
      evidence: { type: 'phone', value: '+972 5X-XXX-1111' },
      ...over,
    },
  ])[0]!;

const show = (suggestion = pairFromServer(), locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={
        locale === 'en'
          ? { customers: messages, channels: channelMessages, common: commonMessages }
          : { customers: heMessages, channels: heChannelMessages, common: heCommonMessages }
      }
    >
      <DuplicateCard suggestion={suggestion} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  acceptSuggestion.mockReset();
  markNotSame.mockReset();
  refresh.mockReset();
});

describe('★★ the pair is the server’s', () => {
  it('names both by the server’s labels - its fallback words in ours, never an id', () => {
    const { container } = show();
    expect(screen.getByTestId('duplicate-ig1')).toHaveTextContent('Instagram customer');
    expect(screen.getByTestId('duplicate-wa1')).toHaveTextContent('Yael Barak');
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same phone number.');
    expect(container.innerHTML).not.toContain(IGSID);
    expect(container.innerHTML).not.toContain('+972541111111');
  });

  it('in Hebrew the fallback is Hebrew, and the names stay as written', () => {
    show(pairFromServer(), 'he');
    expect(screen.getByTestId('duplicate-ig1')).toHaveTextContent('לקוח/ה מאינסטגרם');
    expect(screen.getByTestId('duplicate-wa1')).toHaveTextContent('Yael Barak');
  });

  it.each([
    ['same_name', null, 'The same name on two channels.'],
    ['similar_name', null, 'Similar names on two channels.'],
    ['shopify_customer', null, 'The same Shopify customer.'],
    ['ai_extracted_identifier', { type: 'EMAIL', value: 'd@x.com' }, 'The same email address.'],
    ['unproven_identifier', { type: 'phone', value: '+972500' }, 'The same phone number.'],
    ['something_new', null, 'GOTCHA found something they have in common.'],
  ])('signal %s says why', (signal, identifier, words) => {
    show(pairFromServer({ signal, identifier, evidence: null }));
    expect(screen.getByTestId('duplicates')).toHaveTextContent(words);
  });
});

describe('★★ suggested, never silent - "Merge them" accepts the suggestion', () => {
  it('asks once more; only the second press accepts, with the pair’s two ids', async () => {
    acceptSuggestion.mockResolvedValue({ ok: true });
    show();
    await userEvent.click(screen.getByTestId('merge'));
    expect(acceptSuggestion).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('merge-confirm'));
    expect(acceptSuggestion).toHaveBeenCalledWith('ig1', 'wa1');
    expect(markNotSame).not.toHaveBeenCalled();
    expect(screen.getByTestId('merge-done')).toHaveTextContent(
      'Done. They now show as one person.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('Cancel accepts nothing', async () => {
    show();
    await userEvent.click(screen.getByTestId('merge'));
    await userEvent.click(screen.getByTestId('merge-cancel'));
    expect(acceptSuggestion).not.toHaveBeenCalled();
  });

  it.each([
    ['not_same', "These two were marked as different people, so they weren't merged."],
    ['gone', 'One of them no longer exists.'],
    ['forbidden', "You don't have permission to merge customers."],
    ['failed', "They weren't merged - try again."],
  ])('%s: said in words; nothing claims it was merged', async (reason, words) => {
    acceptSuggestion.mockResolvedValue({ ok: false, reason });
    show();
    await userEvent.click(screen.getByTestId('merge'));
    await userEvent.click(screen.getByTestId('merge-confirm'));
    expect(screen.getByTestId('merge-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('merge-done')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★★ 04’s "Not the same" (conversation e5a56fd3) - remembered, never suggested again', () => {
  it('one press marks the pair, links nothing, says so, and reads the page again', async () => {
    markNotSame.mockResolvedValue({ ok: true });
    show();
    await userEvent.click(screen.getByTestId('not-same'));
    expect(markNotSame).toHaveBeenCalledWith('ig1', 'wa1');
    expect(acceptSuggestion).not.toHaveBeenCalled();
    expect(screen.getByTestId('not-same-done')).toHaveTextContent(
      "Marked as two people. GOTCHA won't suggest them together again.",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ['already_same', 'These two are already one person.'],
    ['gone', 'One of them no longer exists.'],
    ['forbidden', "You don't have permission to change customers."],
    ['failed', "That wasn't saved - try again."],
  ])('%s: said in words; nothing claims it was marked', async (reason, words) => {
    markNotSame.mockResolvedValue({ ok: false, reason });
    show();
    await userEvent.click(screen.getByTestId('not-same'));
    expect(screen.getByTestId('not-same-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('not-same-done')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★ it links, it does not merge fields (supervisor, 2026-10-11)', () => {
  it('the card promises one person and every message kept - never a merge of their details', () => {
    show(pairFromServer({ signal: 'same_name', identifier: null }));
    const card = screen.getByTestId('duplicates');
    expect(card).toHaveTextContent("They'll show as one person, and all their messages are kept.");
    expect(card).not.toHaveTextContent(/Merging/);
  });
});

describe('★ the reason in Hebrew is the words agreed (supervisor, 2026-10-11)', () => {
  it('by signal', async () => {
    const he = (await import('@/i18n/messages/he/customers.json')).default;
    expect(he.dupes.why).toMatchObject({
      similarName: 'שמות דומים בשני ערוצים.',
      sameName: 'אותו שם בשני ערוצים.',
      phone: 'אותו מספר טלפון.',
      email: 'אותה כתובת מייל.',
      shopifyCustomer: 'אותו לקוח בשופיפיי.',
    });
    expect(he.dupes.keeps).toBe('יוצגו כאדם אחד, וכל ההודעות של שניהם נשמרות.');
    // A Hebrew loanword is spelled with a geresh, never an ASCII apostrophe.
    expect(JSON.stringify(he)).not.toMatch(/[\u05D0-\u05EA]'/);
  });
});

const LRI = '⁦';
const PDI = '⁩';
const proof = () => screen.queryByTestId('duplicate-proof');

describe('★★ each name opens that customer, beside its channel’s mark (Omer, 2026-10-12)', () => {
  it('links each name to /customers/<contactId>', () => {
    show();
    expect(screen.getByTestId('duplicate-ig1').tagName).toBe('A');
    expect(screen.getByTestId('duplicate-ig1')).toHaveAttribute('href', '/customers/ig1');
    expect(screen.getByTestId('duplicate-wa1')).toHaveAttribute('href', '/customers/wa1');
  });

  it('draws each name’s own channel, named for a screen reader, inside its link', () => {
    show();
    const ig = screen.getByTestId('duplicate-ig1').querySelector('[data-channel-mark]');
    const wa = screen.getByTestId('duplicate-wa1').querySelector('[data-channel-mark]');
    expect(ig).toHaveAttribute('data-glyph', 'instagram');
    expect(ig).toHaveAttribute('aria-label', 'Instagram');
    expect(wa).toHaveAttribute('data-glyph', 'whatsapp');
    expect(wa).toHaveAttribute('aria-label', 'WhatsApp');
  });

  it('no channel on a side is no mark there - never a made-up one', () => {
    show(
      pairFromServer({
        contacts: [
          { id: 'ig1', contactId: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
          { id: 'wa1', contactId: 'wa1', label: 'Yael Barak', channel: null },
        ],
      }),
    );
    expect(screen.getByTestId('duplicate-ig1').querySelector('[data-channel-mark]')).not.toBeNull();
    expect(screen.getByTestId('duplicate-wa1').querySelector('[data-channel-mark]')).toBeNull();
    expect(screen.getByTestId('duplicate-wa1')).toHaveAttribute('href', '/customers/wa1');
  });

  it('a channel this app has no name for is "Another channel", never the enum', () => {
    show(
      pairFromServer({
        contacts: [
          { id: 'ig1', contactId: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
          { id: 'wa1', contactId: 'wa1', label: 'Yael Barak', channel: 'TIKTOK' },
        ],
      }),
    );
    const mark = screen.getByTestId('duplicate-wa1').querySelector('[data-channel-mark]');
    expect(mark).toHaveAttribute('aria-label', 'Another channel');
    expect(screen.getByTestId('duplicates').innerHTML).not.toContain('TIKTOK');
  });
});

describe('★★ the proof, as the server sent it (Backend 3ac2a71e)', () => {
  it('a phone: the masked value as given, isolated left to right', () => {
    show();
    expect(proof()).toHaveTextContent('The phone number: +972 5X-XXX-1111');
    expect(proof()?.textContent).toContain(`${LRI}+972 5X-XXX-1111${PDI}`);
    // The reason line stays.
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same phone number.');
  });

  it('a phone in Hebrew keeps its digits in order', () => {
    show(pairFromServer(), 'he');
    expect(proof()).toHaveTextContent('מספר הטלפון: +972 5X-XXX-1111');
    expect(proof()?.textContent).toContain(`${LRI}+972 5X-XXX-1111${PDI}`);
  });

  it('an email: the masked value as given, isolated', () => {
    show(
      pairFromServer({
        signal: 'ai_extracted_identifier',
        identifier: { type: 'EMAIL', value: 'omer@gmail.com' },
        evidence: { type: 'email', value: 'o***@gmail.com' },
      }),
    );
    expect(proof()).toHaveTextContent('The email address: o***@gmail.com');
    expect(proof()?.textContent).toContain(`${LRI}o***@gmail.com${PDI}`);
    expect(screen.getByTestId('duplicates').innerHTML).not.toContain('omer@gmail.com');
  });

  it('a name: both names, each as the customer wrote it', () => {
    show(
      pairFromServer({
        signal: 'similar_name',
        identifier: null,
        evidence: { type: 'name', names: ['יעל ברק', 'Yael Barak'] },
      }),
    );
    expect(proof()).toHaveTextContent('Names on the two accounts: יעל ברק and Yael Barak');
    const isolated = [...(proof()?.querySelectorAll('bdi') ?? [])].map((b) => b.textContent);
    expect(isolated).toEqual(['יעל ברק', 'Yael Barak']);
  });

  it('a name in Hebrew', () => {
    show(
      pairFromServer({
        signal: 'same_name',
        identifier: null,
        evidence: { type: 'name', names: ['Yael Barak', 'Yael Barak'] },
      }),
      'he',
    );
    expect(proof()).toHaveTextContent('השמות בשני החשבונות: Yael Barak ו‑Yael Barak');
  });

  it('a name the server has not got (null) is no proof line - never a dash or a blank', () => {
    show(
      pairFromServer({
        signal: 'same_name',
        identifier: null,
        evidence: { type: 'name', names: [null, 'Yael Barak'] },
      }),
    );
    expect(proof()).toBeNull();
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same name on two channels.');
  });

  it('a Shopify customer: verified through a profile update, never its id', () => {
    const shopify = pairFromServer({
      signal: 'shopify_customer',
      identifier: { type: 'shopify_customer', value: '7012' },
      evidence: {
        type: 'shopify_customer',
        shopifyCustomerId: '7012',
        provenBy: 'verified_profile_update',
      },
    });
    show(shopify);
    expect(proof()).toHaveTextContent('Verified through a profile update.');
    // Said as the same customer, never as an order (supervisor, 2026-10-12).
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same Shopify customer.');
    expect(screen.getByTestId('duplicates')).not.toHaveTextContent(/order/i);
    expect(screen.getByTestId('duplicates').innerHTML).not.toContain('7012');
  });

  it('a Shopify customer in Hebrew', () => {
    show(
      pairFromServer({
        signal: 'shopify_customer',
        identifier: null,
        evidence: {
          type: 'shopify_customer',
          shopifyCustomerId: '7012',
          provenBy: 'verified_profile_update',
        },
      }),
      'he',
    );
    expect(screen.getByTestId('duplicates')).toHaveTextContent('אותו לקוח בשופיפיי.');
    expect(proof()).toHaveTextContent('אומת דרך עדכון פרופיל.');
    expect(screen.getByTestId('duplicates')).not.toHaveTextContent('הזמנה');
  });

  it('a Shopify proof of another kind is not said as a profile update', () => {
    show(
      pairFromServer({
        signal: 'shopify_customer',
        identifier: null,
        evidence: {
          type: 'shopify_customer',
          shopifyCustomerId: '7012',
          provenBy: 'something_else',
        },
      }),
    );
    expect(proof()).toBeNull();
  });

  it('no evidence (null): the reason line only', () => {
    show(pairFromServer({ evidence: null }));
    expect(proof()).toBeNull();
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same phone number.');
    expect(screen.getByTestId('merge')).toBeInTheDocument();
  });

  it('an evidence type this app has no words for: the card stands, the reason line only', () => {
    show(pairFromServer({ evidence: { type: 'fingerprint', value: 'abc123' } }));
    expect(proof()).toBeNull();
    const card = screen.getByTestId('duplicates');
    expect(card).toHaveTextContent('The same phone number.');
    expect(card.innerHTML).not.toContain('abc123');
    expect(screen.getByTestId('merge')).toBeInTheDocument();
  });

  it('a server from before 3ac2a71e (no contactId, no evidence): links by id, reason only', () => {
    // The 83579ac8 item as that route built it: no `evidence` key at all.
    const [older] = identitySuggestionsSchema.parse([
      {
        id: 'identity:link:ig1:wa1',
        source: 'link',
        contactIds: ['ig1', 'wa1'],
        signal: 'unproven_identifier',
        identifier: { type: 'phone', value: '+972541111111' },
        status: 'PENDING',
        at: '2026-10-11T10:00:00Z',
        contacts: [
          { id: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
          { id: 'wa1', label: 'Yael Barak', channel: 'WHATSAPP' },
        ],
      },
    ]);
    show(older);
    expect(screen.getByTestId('duplicate-ig1')).toHaveAttribute('href', '/customers/ig1');
    expect(screen.getByTestId('duplicate-wa1')).toHaveAttribute('href', '/customers/wa1');
    expect(proof()).toBeNull();
    expect(screen.getByTestId('duplicates')).toHaveTextContent('The same phone number.');
  });
});
