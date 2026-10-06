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
vi.mock('./identity-actions', () => ({ mergeContacts }));

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
const show = (pair: Parameters<typeof DuplicateCard>[0]['pair']) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      <DuplicateCard pair={pair} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  mergeContacts.mockReset();
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

  it('"Not the same" is drawn - nothing remembers it yet; no pair: said', () => {
    const one = show([yael, yaelB]);
    expect(screen.getByTestId('not-same')).toHaveAttribute('aria-disabled', 'true');
    one.unmount();
    show(null);
    expect(screen.getByTestId('duplicates')).toHaveTextContent('No duplicates found.');
  });
});
