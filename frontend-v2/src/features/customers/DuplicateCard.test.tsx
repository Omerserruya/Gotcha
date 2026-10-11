import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { identitySuggestionsSchema } from '@/api/contracts/identity';
import messages from '@/i18n/messages/en/customers.json';
import heMessages from '@/i18n/messages/he/customers.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
/* Linking changes who the list says is one person: the actions are spies. */
const acceptSuggestion = vi.hoisted(() => vi.fn());
const markNotSame = vi.hoisted(() => vi.fn());
vi.mock('./identity-actions', () => ({ acceptSuggestion, markNotSame }));

import { DuplicateCard } from './DuplicateCard';

const IGSID = '1031990639501705';

/** A pair as `GET /api/identity/suggestions` sends it (Backend 83579ac8), parsed by the contract. */
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
        { id: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
        { id: 'wa1', label: 'Yael Barak', channel: 'WHATSAPP' },
      ],
      ...over,
    },
  ])[0]!;

const show = (suggestion = pairFromServer(), locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ customers: locale === 'en' ? messages : heMessages }}
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
    ['shopify_customer', null, 'An order from the same customer.'],
    ['ai_extracted_identifier', { type: 'EMAIL', value: 'd@x.com' }, 'The same email address.'],
    ['unproven_identifier', { type: 'phone', value: '+972500' }, 'The same phone number.'],
    ['something_new', null, 'GOTCHA found something they have in common.'],
  ])('signal %s says why', (signal, identifier, words) => {
    show(pairFromServer({ signal, identifier }));
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
      order: 'הזמנה של אותו לקוח.',
    });
    expect(he.dupes.keeps).toBe('יוצגו כאדם אחד, וכל ההודעות של שניהם נשמרות.');
    // A Hebrew loanword is spelled with a geresh, never an ASCII apostrophe.
    expect(JSON.stringify(he)).not.toMatch(/[\u05D0-\u05EA]'/);
  });
});
