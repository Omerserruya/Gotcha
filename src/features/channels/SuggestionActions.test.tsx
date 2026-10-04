import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';

/* Approving writes what the AI tells customers: both actions are spies. */
const approveSuggestion = vi.hoisted(() => vi.fn());
const rejectSuggestion = vi.hoisted(() => vi.fn());
vi.mock('./candidate-actions', () => ({ approveSuggestion, rejectSuggestion }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { SuggestionActions } from './SuggestionActions';

beforeEach(() => {
  approveSuggestion.mockReset();
  rejectSuggestion.mockReset();
  refresh.mockReset();
});
const show = (variants: string[] = []) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <SuggestionActions id="c1" answer="14 days" variants={variants} />
    </NextIntlClientProvider>,
  );

describe('★★ 13f — a suggestion decided only on a press', () => {
  it('Approve sends the answer as it stands; then said, and the report refreshed', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    show();
    expect(approveSuggestion).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('approve-c1'));
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '14 days');
    expect(screen.getByTestId('decided-c1')).toHaveTextContent('Approved');
    expect(refresh).toHaveBeenCalled();
  });

  it('a conflict: one "Use" per answer, each sending ITS answer; Skip sets it aside', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    const one = show(['14 days', '30 days']);
    expect(screen.queryByTestId('approve-c1')).toBeNull();
    await userEvent.click(screen.getByTestId('use-c1-1'));
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '30 days');
    one.unmount();
    rejectSuggestion.mockResolvedValue({ ok: true });
    show(['14 days', '30 days']);
    expect(screen.getByTestId('reject-c1')).toHaveTextContent('Skip');
    await userEvent.click(screen.getByTestId('reject-c1'));
    expect(rejectSuggestion).toHaveBeenCalledWith('c1');
    expect(approveSuggestion).toHaveBeenCalledTimes(1);
  });

  it('Edit: the answer in a field; Save sends the edit — Cancel sends nothing', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    show();
    await userEvent.click(screen.getByTestId('edit-open-c1'));
    const box = screen.getByTestId('edit-c1');
    expect(box).toHaveValue('14 days');
    await userEvent.clear(box);
    expect(screen.getByTestId('save-c1')).toBeDisabled();
    await userEvent.type(box, '30 days from delivery');
    await userEvent.click(screen.getByTestId('save-c1'));
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '30 days from delivery');
  });

  it('a refusal is said in its own words; nothing claims success', async () => {
    approveSuggestion.mockResolvedValue({ ok: false, reason: 'no_knowledge_base' });
    show();
    await userEvent.click(screen.getByTestId('approve-c1'));
    expect(screen.getByTestId('decide-problem-c1')).toHaveTextContent('There is no knowledge base');
    expect(screen.queryByTestId('decided-c1')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★ 02’s pills: the answer to use leads, black; the rest bordered', () => {
  it('only the first variant is primary; "See the chats" is drawn, with why', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <SuggestionActions
          id="c1"
          answer="x"
          variants={['14 days', '30 days']}
          seeChats="See the chats"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('use-c1-0')).toHaveAttribute('data-tone', 'primary');
    expect(screen.getByTestId('use-c1-0')).toHaveTextContent(/^Use 14 days$/);
    expect(screen.getByTestId('use-c1-1')).not.toHaveAttribute('data-tone');
    expect(screen.getByTestId('see-chats-c1')).toHaveAttribute('aria-disabled', 'true');
    // 02: a conflict is Use, Use, Skip — no Edit.
    expect(screen.queryByTestId('edit-open-c1')).toBeNull();
  });
});
