import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WidgetAssignment } from '@/api/contracts/website-widget';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';

const save = vi.hoisted(() => vi.fn());
vi.mock('./website-widget-actions', () => ({ saveWidgetAssignment: save }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { WidgetAssignmentCard } from './WidgetAssignment';

beforeEach(() => {
  save.mockReset();
  refresh.mockReset();
});

const MAYA = { id: 'e1', name: 'Maya' };
const channel = (over: Partial<WidgetAssignment['channels'][number]>) => ({
  channel: 'WEBCHAT',
  employee: MAYA,
  how: 'always' as const,
  editable: true,
  dedicated: false,
  sharedWith: [] as string[],
  movesWith: [] as string[],
  ...over,
});
/** Dev's real playbook (Backend, 2026-10-08): one start → Maya, for every channel. */
const DEV: WidgetAssignment = {
  channels: [
    channel({
      channel: 'WEBCHAT',
      sharedWith: ['WHATSAPP', 'SHOPIFY_LIVE_CHAT'],
      movesWith: ['WHATSAPP'],
    }),
    channel({
      channel: 'SHOPIFY_LIVE_CHAT',
      sharedWith: ['WHATSAPP', 'WEBCHAT'],
      movesWith: ['WHATSAPP'],
    }),
  ],
  employees: [
    { ...MAYA, active: true },
    { id: 'e2', name: 'Dan', active: true },
    { id: 'e3', name: 'Noa', active: false },
  ],
};

const show = (read: WidgetAssignment | 'forbidden' | null, assigned = MAYA) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels, common }}>
      <WidgetAssignmentCard read={read} assigned={assigned} />
    </NextIntlClientProvider>,
  );
const click = (id: string) =>
  act(async () => {
    fireEvent.click(screen.getByTestId(id));
  });

describe('★★ who answers the widget - chosen here, written to the playbook', () => {
  it('today, per place; the choice; and that it changes the playbook', () => {
    show(DEV);
    expect(screen.getByTestId('webchat-employee-now-WEBCHAT')).toHaveTextContent('Web chat: Maya');
    expect(screen.getByTestId('webchat-employee-now-SHOPIFY_LIVE_CHAT')).toHaveTextContent(
      'Shopify live chat: Maya',
    );
    expect(screen.getByTestId('webchat-employee-e1')).toBeChecked();
    expect(screen.getByTestId('webchat-employee-playbook')).toHaveTextContent(
      'This changes the playbook',
    );
    // Nothing chosen yet: nothing to save.
    expect(screen.getByTestId('webchat-employee-save')).toBeDisabled();
  });

  it('an employee who is not working is a status, never a radio', () => {
    show(DEV);
    const noa = screen.getByTestId('webchat-employee-e3');
    expect(noa.tagName).not.toBe('INPUT');
    expect(noa).toHaveAttribute('aria-disabled', 'true');
    expect(noa).toHaveTextContent('Not working');
  });

  it('★★ it moves WhatsApp too: asked BEFORE anything is written, then changed for all', async () => {
    show(DEV);
    fireEvent.click(screen.getByTestId('webchat-employee-e2'));
    expect(screen.getByTestId('webchat-employee-save')).toHaveTextContent('Save: Dan');
    await click('webchat-employee-save');
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('webchat-employee-shared')).toHaveTextContent(
      'The widget shares one route in the playbook with WhatsApp, so this also moves WhatsApp to Dan.',
    );
    expect(refresh).not.toHaveBeenCalled();

    save.mockResolvedValueOnce({
      ok: true,
      assignment: {
        ...DEV,
        channels: DEV.channels.map((c) => ({ ...c, employee: { id: 'e2', name: 'Dan' } })),
      },
    });
    await click('webchat-employee-shared-yes');
    expect(save).toHaveBeenLastCalledWith('e2', ['WEBCHAT', 'SHOPIFY_LIVE_CHAT'], true);
    // Answered: the question is gone.
    expect(screen.queryByTestId('webchat-employee-shared')).toBeNull();
    expect(screen.getByTestId('webchat-employee-saved')).toHaveTextContent(
      'Saved. Dan answers the widget from now on.',
    );
    expect(screen.getByTestId('webchat-employee-now-WEBCHAT')).toHaveTextContent('Dan');
    expect(refresh).toHaveBeenCalled();
  });

  it('Cancel writes nothing', async () => {
    show(DEV);
    fireEvent.click(screen.getByTestId('webchat-employee-e2'));
    await click('webchat-employee-save');
    await click('webchat-employee-shared-no');
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByTestId('webchat-employee-shared')).toBeNull();
  });

  it('nothing else moves (`movesWith: []` - its own entry): saved at once, no question', async () => {
    save.mockResolvedValueOnce({ ok: true, assignment: DEV });
    show({ ...DEV, channels: DEV.channels.map((c) => ({ ...c, movesWith: [] })) });
    fireEvent.click(screen.getByTestId('webchat-employee-e2'));
    await click('webchat-employee-save');
    expect(screen.queryByTestId('webchat-employee-shared')).toBeNull();
    expect(save).toHaveBeenCalledWith('e2', ['WEBCHAT', 'SHOPIFY_LIVE_CHAT'], false);
  });

  it('an older service (no `movesWith`): its 409 asks, naming from `sharedWith`; Cancel writes no more', async () => {
    save.mockResolvedValueOnce({ ok: false, reason: 'shared' });
    show({
      ...DEV,
      channels: DEV.channels.map(({ movesWith: _m, ...c }) => c),
    });
    fireEvent.click(screen.getByTestId('webchat-employee-e2'));
    await click('webchat-employee-save');
    expect(save).toHaveBeenCalledWith('e2', ['WEBCHAT', 'SHOPIFY_LIVE_CHAT'], false);
    // The widget's own channels are not "other" channels.
    expect(screen.getByTestId('webchat-employee-shared')).toHaveTextContent(
      'so this also moves WhatsApp to Dan.',
    );
    await click('webchat-employee-shared-no');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('★ where conditions decide, it is read with the way to the playbook - and only the rest is sent', async () => {
    const mixed: WidgetAssignment = {
      ...DEV,
      channels: [
        channel({ channel: 'WEBCHAT', employee: null, how: 'conditional', editable: false }),
        channel({ channel: 'SHOPIFY_LIVE_CHAT', how: 'team', employee: null }),
      ],
    };
    save.mockResolvedValueOnce({ ok: false, reason: 'employee_gone' });
    show(mixed);
    expect(screen.getByTestId('webchat-employee-now-WEBCHAT')).toHaveTextContent(
      'Conditions in the playbook decide',
    );
    expect(screen.getByTestId('webchat-employee-now-SHOPIFY_LIVE_CHAT')).toHaveTextContent(
      'A team, not one employee',
    );
    expect(screen.getByTestId('webchat-employee-conditional')).toHaveTextContent(
      'Web chat: conditions in the playbook decide who answers',
    );
    fireEvent.click(screen.getByTestId('webchat-employee-e2'));
    await click('webchat-employee-save');
    expect(save).toHaveBeenCalledWith('e2', ['SHOPIFY_LIVE_CHAT'], false);
    expect(screen.getByTestId('webchat-employee-problem')).toHaveTextContent(
      "That employee isn't working now",
    );

    const all = { ...mixed, channels: [mixed.channels[0]!] };
    show(all);
    expect(screen.getAllByTestId('webchat-employee-conditional')).toHaveLength(2);
    expect(screen.getAllByTestId('webchat-employee-save')).toHaveLength(1);
  });

  it('not an admin, not read, or no place yet: the playbook’s answer, read - nothing offered', () => {
    const reads: (WidgetAssignment | 'forbidden' | null)[] = [
      'forbidden',
      null,
      { ...DEV, channels: [] },
    ];
    for (const read of reads) {
      const { unmount } = show(read);
      expect(screen.getByTestId('webchat-employee-who')).toHaveTextContent('Maya');
      expect(screen.queryByTestId('webchat-employee-save')).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
      if (read === 'forbidden') {
        expect(screen.getByTestId('webchat-employee-admins')).toHaveTextContent(
          'Only an admin can change who answers',
        );
      } else if (read !== null) {
        expect(screen.getByTestId('webchat-employee-noplace')).toBeInTheDocument();
      } else {
        expect(screen.queryByTestId('webchat-employee-admins')).toBeNull();
      }
      unmount();
    }
  });
});
