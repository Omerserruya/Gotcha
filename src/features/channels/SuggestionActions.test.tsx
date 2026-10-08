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
      <SuggestionActions
        id="c1"
        question="How long do returns take?"
        answer="14 days"
        reasoning="We count from delivery."
        variants={variants}
      />
    </NextIntlClientProvider>,
  );

/** The "Yes" under the document - the only press that writes. */
const yes = () => userEvent.click(screen.getByTestId('confirm-yes-c1'));

describe('★★ 13f - a suggestion decided only on a press, after what it writes is shown', () => {
  it('Approve shows the document word for word and writes nothing; Yes sends the answer as it stands', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    show();
    await userEvent.click(screen.getByTestId('approve-c1'));
    expect(approveSuggestion).not.toHaveBeenCalled();
    const used = screen.getByTestId('used-c1');
    expect([...used.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'How long do returns take?',
      '14 days',
      'How we approach this: We count from delivery.',
    ]);
    expect(screen.getByTestId('confirm-c1')).toHaveTextContent(
      'Nothing is used until you press Yes',
    );
    await yes();
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '14 days');
    expect(screen.getByTestId('decided-c1')).toHaveTextContent('Approved');
    expect(refresh).toHaveBeenCalled();
  });

  it('a conflict: one "Use" per answer, each sending ITS answer; Skip sets it aside', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    const one = show(['14 days', '30 days']);
    expect(screen.queryByTestId('approve-c1')).toBeNull();
    await userEvent.click(screen.getByTestId('use-c1-1'));
    expect(screen.getByTestId('used-c1')).toHaveTextContent('30 days');
    expect(screen.getByTestId('used-c1')).not.toHaveTextContent('14 days');
    expect(approveSuggestion).not.toHaveBeenCalled();
    await yes();
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '30 days');
    one.unmount();
    rejectSuggestion.mockResolvedValue({ ok: true });
    show(['14 days', '30 days']);
    expect(screen.getByTestId('reject-c1')).toHaveTextContent('Skip');
    await userEvent.click(screen.getByTestId('reject-c1'));
    expect(rejectSuggestion).toHaveBeenCalledWith('c1');
    expect(approveSuggestion).toHaveBeenCalledTimes(1);
  });

  it('Edit: the answer in a field; Save sends the edit - Cancel sends nothing', async () => {
    approveSuggestion.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    show();
    await userEvent.click(screen.getByTestId('edit-open-c1'));
    const box = screen.getByTestId('edit-c1');
    expect(box).toHaveValue('14 days');
    await userEvent.clear(box);
    expect(screen.getByTestId('save-c1')).toBeDisabled();
    await userEvent.type(box, '30 days from delivery');
    await userEvent.click(screen.getByTestId('save-c1'));
    expect(screen.getByTestId('used-c1')).toHaveTextContent('30 days from delivery');
    expect(approveSuggestion).not.toHaveBeenCalled();
    await yes();
    expect(approveSuggestion).toHaveBeenCalledWith('c1', '30 days from delivery');
  });

  it('Back writes nothing and gives the decisions back', async () => {
    show();
    await userEvent.click(screen.getByTestId('approve-c1'));
    await userEvent.click(screen.getByTestId('confirm-back-c1'));
    expect(screen.queryByTestId('used-c1')).toBeNull();
    expect(screen.getByTestId('approve-c1')).toBeInTheDocument();
    expect(approveSuggestion).not.toHaveBeenCalled();
  });

  it('a live lookup: the platform’s caveat is in what is shown, because it is in what is read', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <SuggestionActions id="c1" question="Viewings?" answer="Thu" liveLookup variants={[]} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByTestId('approve-c1'));
    expect(screen.getByTestId('used-c1')).toHaveTextContent('This depends on live availability.');
  });

  it('a refusal is said in its own words; nothing claims success', async () => {
    approveSuggestion.mockResolvedValue({ ok: false, reason: 'no_knowledge_base' });
    show();
    await userEvent.click(screen.getByTestId('approve-c1'));
    await yes();
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
          question="q"
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
    // 02: a conflict is Use, Use, Skip - no Edit.
    expect(screen.queryByTestId('edit-open-c1')).toBeNull();
  });
});
