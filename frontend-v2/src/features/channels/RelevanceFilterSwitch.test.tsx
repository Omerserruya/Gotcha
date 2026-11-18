import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import heChannels from '@/i18n/messages/he/channels.json';
import { PermissionsProvider } from '@/permissions/permissions-context';

/**
 * ★★ One channel account's relevance filter switch: optimistic, put back with
 * a reason on a refusal, and only for someone who manages channels. The
 * server action is mocked and throws unless a test says otherwise.
 */

const setRelevanceFilter = vi.hoisted(() =>
  vi.fn(async (_id: string, _on: boolean): Promise<unknown> => {
    throw new Error('a test must never change a channel for real');
  }),
);
vi.mock('./relevance-filter-actions', () => ({ setRelevanceFilter }));

import { RelevanceFilterSwitch } from './RelevanceFilterSwitch';

const MANAGE = ['channels:manage:read', 'channels:manage:update'];

function show({
  enabled = true,
  permissions = MANAGE,
  layout,
  locale = 'en',
}: {
  enabled?: boolean;
  permissions?: string[];
  layout?: 'block' | 'inline';
  locale?: 'en' | 'he';
} = {}) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ channels: locale === 'en' ? channels : heChannels }}
    >
      <PermissionsProvider permissions={permissions as never} tenantId="t1">
        <RelevanceFilterSwitch channelAccountId="ca1" enabled={enabled} layout={layout} />
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );
}

const theSwitch = () => screen.getByTestId('relevance-filter-switch-ca1');

beforeEach(() => {
  setRelevanceFilter.mockReset();
  setRelevanceFilter.mockImplementation(async () => {
    throw new Error('a test must never change a channel for real');
  });
});

describe('★★ RelevanceFilterSwitch', () => {
  it.each([true, false])('draws the stored value (%s) as a labelled switch', (on) => {
    show({ enabled: on });
    expect(screen.getByRole('switch', { name: channels.relevanceFilter.label })).toBe(theSwitch());
    expect(theSwitch()).toHaveAttribute('aria-checked', String(on));
    expect(theSwitch()).toHaveAccessibleDescription(channels.relevanceFilter.help);
  });

  it('★★ a press moves it at once and saves the new value for this account', async () => {
    let resolve: (v: unknown) => void = () => {};
    setRelevanceFilter.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    show({ enabled: true });
    await userEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(setRelevanceFilter).toHaveBeenCalledWith('ca1', false);
    await act(async () => resolve({ ok: true }));
    expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['not_applicable', 'not_found', 'forbidden', 'failed'] as const)(
    '★★ refused (%s): it goes back, and says why under it',
    async (reason) => {
      setRelevanceFilter.mockResolvedValueOnce({ ok: false, reason });
      show({ enabled: false });
      await userEvent.click(theSwitch());
      expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('alert')).toHaveTextContent(channels.relevanceFilter.problem[reason]);
    },
  );

  it('★★ without channels:manage:update: drawn, disabled, and says who can change it', async () => {
    show({ permissions: ['channels:manage:read'] });
    expect(theSwitch()).toBeDisabled();
    expect(theSwitch()).toHaveAccessibleDescription(
      `${channels.relevanceFilter.help} ${channels.relevanceFilter.readOnly}`,
    );
    await userEvent.click(theSwitch());
    expect(setRelevanceFilter).not.toHaveBeenCalled();
  });

  it('on a row (inline): the help line is the description, not a visible line', () => {
    show({ layout: 'inline' });
    expect(theSwitch()).toHaveAccessibleDescription(channels.relevanceFilter.help);
    expect(screen.getByText(channels.relevanceFilter.help)).toHaveClass('srOnly');
  });

  it('Hebrew: the words Omer gave, no English letter and no dash', () => {
    show({ locale: 'he' });
    expect(theSwitch()).toHaveAccessibleName('סינון שיחות לא רלוונטיות');
    const words = [
      heChannels.relevanceFilter.label,
      heChannels.relevanceFilter.help,
      heChannels.relevanceFilter.readOnly,
      ...Object.values(heChannels.relevanceFilter.problem),
    ];
    for (const line of words) {
      expect(line).not.toMatch(/[A-Za-z]/);
      for (const ch of line) expect([0x2013, 0x2014]).not.toContain(ch.codePointAt(0));
    }
    expect(heChannels.relevanceFilter.help).toBe(
      'שיחות אישיות, פרסומות והודעות אוטומטיות יעברו לתיקייה "אישי ולא רלוונטי" והבוט לא יענה עליהן.',
    );
  });
});
