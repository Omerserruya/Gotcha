import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { customerRowSchema } from '@/api/contracts/customers';
import messages from '@/i18n/messages/en/customers.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
/* Merging rewrites who owns every message: the action is a spy. */
const mergeContacts = vi.hoisted(() => vi.fn());
const markNotSame = vi.hoisted(() => vi.fn());
vi.mock('./identity-actions', () => ({ mergeContacts, markNotSame }));

import { DuplicateCard } from './DuplicateCard';

const yael = customerRowSchema.parse({
  id: 'k1',
  displayName: 'Yael Barak',
  phone: '+972500000009',
  channel: 'WHATSAPP',
});
const yaelB = customerRowSchema.parse({
  id: 'k2',
  displayName: 'yael.b',
  phone: '0500000009',
  channel: 'INSTAGRAM',
});
const show = (pair: Parameters<typeof DuplicateCard>[0]['pair'], unchecked = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      <DuplicateCard pair={pair} unchecked={unchecked} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  mergeContacts.mockReset();
  markNotSame.mockReset();
  refresh.mockReset();
});

describe('★★ suggested, never silent', () => {
  it('Merge asks once more; only the second press merges', async () => {
    mergeContacts.mockResolvedValue({ ok: true });
    show([yael, yaelB]);
    expect(screen.getByTestId('duplicate-pair')).toHaveTextContent('Yael Barakyael.b');
    expect(screen.getByTestId('duplicates')).toHaveTextContent('They share a phone number.');
    await userEvent.click(screen.getByTestId('merge'));
    expect(mergeContacts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('merge-confirm'));
    expect(mergeContacts).toHaveBeenCalledWith('k1', 'k2');
    expect(screen.getByTestId('merge-done')).toHaveTextContent('Merged.');
    expect(refresh).toHaveBeenCalled();
  });

  it('Cancel merges nothing; a refusal is said', async () => {
    show([yael, yaelB]);
    await userEvent.click(screen.getByTestId('merge'));
    await userEvent.click(screen.getByTestId('merge-cancel'));
    expect(mergeContacts).not.toHaveBeenCalled();
    mergeContacts.mockResolvedValue({ ok: false, reason: 'conflict' });
    await userEvent.click(screen.getByTestId('merge'));
    await userEvent.click(screen.getByTestId('merge-confirm'));
    expect(screen.getByTestId('merge-problem')).toHaveTextContent("These two can't be merged");
  });

  it('no pair: said; marks unread: said as that - never "no duplicates"', () => {
    const one = show(null);
    expect(screen.getByTestId('duplicates')).toHaveTextContent('No duplicates found.');
    one.unmount();
    show(null, true);
    expect(screen.getByTestId('duplicates-unchecked')).toHaveTextContent(
      "Couldn't check which accounts were marked as different people",
    );
    expect(screen.getByTestId('duplicates')).not.toHaveTextContent('No duplicates found.');
  });
});

describe('★★ 04’s "Not the same" (conversation e5a56fd3) - remembered, never suggested again', () => {
  it('one press marks the pair, merges nothing, says so, and reads the list again', async () => {
    markNotSame.mockResolvedValue({ ok: true });
    show([yael, yaelB]);
    await userEvent.click(screen.getByTestId('not-same'));
    expect(markNotSame).toHaveBeenCalledWith('k1', 'k2');
    expect(mergeContacts).not.toHaveBeenCalled();
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
    show([yael, yaelB]);
    await userEvent.click(screen.getByTestId('not-same'));
    expect(screen.getByTestId('not-same-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('not-same-done')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
