import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSheetFocus } from '@/design-system/primitives/overlay/use-sheet-focus';
import channels from '@/i18n/messages/en/channels.json';
import { PermissionsProvider } from '@/permissions/permissions-context';

import type { TopicItemView, TopicView } from './topic-view';

/**
 * ★★ 13f by topic: one approve per topic, an answer chosen per item with
 * "Other" last, an unresolved item holding the approve, and every press
 * optimistic with its refusal said under the card. Both actions are mocked
 * and throw unless a test says otherwise.
 */

const approveTopic = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('a test must never approve knowledge for real');
  }),
);
const rejectTopic = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('a test must never reject knowledge for real');
  }),
);
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./topic-actions', () => ({ approveTopic, rejectTopic }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TopicReview } from './TopicReview';

const T = channels.whatsapp.topics;
const WRITE = ['ai:knowledge:read', 'ai:knowledge:write'];

const item = (over: Partial<TopicItemView> = {}): TopicItemView => ({
  candidateId: 'c1',
  status: 'pending',
  question: 'How long is delivery?',
  unresolved: false,
  options: ['3 days', '5 days'],
  optionSeen: [null, '12/11'],
  chosenLine: null,
  quotes: [],
  docConflict: null,
  ...over,
});

const topic = (over: Partial<TopicView> = {}): TopicView => ({
  topicId: 't1',
  label: 'Delivery',
  status: 'pending',
  meta: '5 chats',
  occurrences: 5,
  docConflict: false,
  items: [item()],
  ...over,
});

/** The drawer the report opens in: the real hook, its close a spy. */
function InDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  useSheetFocus(sheet, { onEscape: onClose });
  return (
    <div ref={sheet} tabIndex={-1}>
      {children}
    </div>
  );
}

function show({
  pending = [topic()],
  auto = [],
  rejected = [],
  progress = { total: 4, done: 1 },
  permissions = WRITE,
  onDrawerClose,
}: {
  pending?: TopicView[];
  auto?: TopicView[];
  rejected?: TopicView[];
  progress?: { total: number; done: number } | null;
  permissions?: string[];
  /** Rendered inside a drawer whose Escape closes it. */
  onDrawerClose?: () => void;
} = {}) {
  const review = (
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      <PermissionsProvider permissions={permissions as never} tenantId="tn">
        <TopicReview
          importId="imp1"
          pending={pending}
          auto={auto}
          rejected={rejected}
          progress={progress}
        />
      </PermissionsProvider>
    </NextIntlClientProvider>
  );
  return render(onDrawerClose ? <InDrawer onClose={onDrawerClose}>{review}</InDrawer> : review);
}

const approveButton = (id = 't1') => screen.getByTestId(`topic-approve-${id}`);

beforeEach(() => {
  for (const m of [approveTopic, rejectTopic]) {
    m.mockReset();
    m.mockImplementation(async () => {
      throw new Error('a test must never decide knowledge for real');
    });
  }
  refresh.mockClear();
});

describe('★★ TopicReview', () => {
  it('draws the server’s progress and each answer as a radio, "Other" last', () => {
    show();
    expect(screen.getByTestId('topic-progress')).toHaveTextContent('1 of 4 topics approved');
    const radios = within(screen.getByTestId('topic-item-t1-c1')).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      '3 days',
      '5 dayslast said 12/11',
      T.other,
    ]);
    expect(radios[0]).toBeChecked();
  });

  it('★★ a plain approve sends no answer, and reads as approved at once', async () => {
    let resolve: (v: unknown) => void = () => {};
    approveTopic.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    show();
    await userEvent.click(approveButton());
    expect(approveTopic).toHaveBeenCalledWith('imp1', 't1', []);
    expect(screen.getByTestId('topic-approved-t1')).toHaveTextContent(T.approved);
    await act(async () => resolve({ ok: true, approved: ['c1'], failed: [] }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('★ a variant chosen is sent as the answer', async () => {
    approveTopic.mockResolvedValueOnce({ ok: true, approved: ['c1'], failed: [] });
    show();
    await userEvent.click(screen.getByTestId('topic-option-t1-c1-1'));
    await userEvent.click(approveButton());
    expect(approveTopic).toHaveBeenCalledWith('imp1', 't1', [
      { candidateId: 'c1', answer: '5 days' },
    ]);
  });

  it('★★ "Other" opens a focused box with a counter; empty, it holds the approve', async () => {
    approveTopic.mockResolvedValueOnce({ ok: true, approved: ['c1'], failed: [] });
    show();
    await userEvent.click(screen.getByTestId('topic-other-t1-c1'));
    const box = screen.getByTestId('topic-other-text-t1-c1');
    expect(box).toHaveFocus();
    expect(approveButton()).toBeDisabled();
    expect(approveButton()).toHaveAccessibleDescription(
      'One question still needs an answer chosen',
    );
    await userEvent.type(box, '4 days');
    expect(screen.getByTestId('topic-other-count-t1-c1')).toHaveTextContent(
      '6 of 4,000 characters',
    );
    expect(approveButton()).toBeEnabled();
    await userEvent.click(approveButton());
    expect(approveTopic).toHaveBeenCalledWith('imp1', 't1', [
      { candidateId: 'c1', answer: '4 days' },
    ]);
  });

  it('★ "Other" over 4000 characters holds the approve and says why', async () => {
    show();
    await userEvent.click(screen.getByTestId('topic-other-t1-c1'));
    const box = screen.getByTestId('topic-other-text-t1-c1');
    await userEvent.click(box);
    await userEvent.paste('x'.repeat(4001));
    expect(screen.getByTestId('topic-other-count-t1-c1')).toHaveAttribute('data-over', 'yes');
    expect(approveButton()).toBeDisabled();
    expect(screen.getByTestId('topic-left-t1')).toHaveTextContent('longer than 4,000');
  });

  it('★★ an unresolved item starts on nothing, is marked, and holds the approve until chosen', async () => {
    approveTopic.mockResolvedValueOnce({ ok: true, approved: ['c1', 'c2'], failed: [] });
    show({
      pending: [
        topic({
          items: [
            item(),
            item({
              candidateId: 'c2',
              question: 'Price?',
              unresolved: true,
              options: ['350', '449'],
            }),
          ],
        }),
      ],
    });
    expect(screen.getByTestId('topic-which-t1-c2')).toHaveTextContent(T.whichIsRight);
    const radios = within(screen.getByTestId('topic-item-t1-c2')).getAllByRole('radio');
    expect(radios.some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(approveButton()).toBeDisabled();
    expect(screen.getByTestId('topic-left-t1')).toHaveTextContent('One question');
    await userEvent.click(screen.getByTestId('topic-option-t1-c2-0'));
    expect(approveButton()).toBeEnabled();
    await userEvent.click(approveButton());
    // The undisputed item sends nothing; the unresolved one sends even the first answer.
    expect(approveTopic).toHaveBeenCalledWith('imp1', 't1', [{ candidateId: 'c2', answer: '350' }]);
  });

  it('★★ a partial approve keeps the card open with the item that did not save marked', async () => {
    approveTopic.mockResolvedValueOnce({ ok: true, approved: ['c1'], failed: ['c2'] });
    show({ pending: [topic({ items: [item(), item({ candidateId: 'c2' })] })] });
    await userEvent.click(approveButton());
    expect(screen.getByRole('alert')).toHaveTextContent("One answer wasn't saved");
    expect(screen.getByTestId('topic-item-failed-t1-c2')).toHaveTextContent(T.itemFailed);
    expect(screen.queryByTestId('topic-item-failed-t1-c1')).toBeNull();
    expect(approveButton()).toBeEnabled();
  });

  it('★ a gone topic (a rerun) says the list was updated and re-reads it', async () => {
    approveTopic.mockResolvedValueOnce({ ok: false, reason: 'stale' });
    show();
    await userEvent.click(approveButton());
    expect(screen.getByRole('alert')).toHaveTextContent(T.refreshed);
    expect(refresh).toHaveBeenCalled();
    expect(approveButton()).toBeEnabled();
  });

  it.each(['unresolved', 'too_long', 'forbidden', 'failed'] as const)(
    'a refusal (%s) puts the card back and says why',
    async (reason) => {
      approveTopic.mockResolvedValueOnce({ ok: false, reason });
      show();
      await userEvent.click(approveButton());
      expect(screen.getByRole('alert')).toHaveTextContent(T.refused[reason]);
      expect(screen.queryByTestId('topic-approved-t1')).toBeNull();
    },
  );

  it('★ "Reject topic" reads as rejected at once, and comes back on a refusal', async () => {
    rejectTopic.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    show();
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    expect(rejectTopic).toHaveBeenCalledWith('imp1', 't1');
    expect(screen.getByRole('alert')).toHaveTextContent(T.refused.failed);
    expect(approveButton()).toBeEnabled();
  });

  it('★★ the most-asked 30 first; "Show more" draws the rest', async () => {
    const many = Array.from({ length: 33 }, (_, i) => topic({ topicId: `t${i}` }));
    show({ pending: many });
    expect(screen.getAllByTestId(/^topic-approve-/)).toHaveLength(30);
    expect(screen.queryByTestId('topic-t30')).toBeNull();
    await userEvent.click(screen.getByTestId('topic-more'));
    expect(screen.getAllByTestId(/^topic-approve-/)).toHaveLength(33);
    expect(screen.queryByTestId('topic-more')).toBeNull();
  });

  it('no "Show more" at 30 or fewer', () => {
    show({ pending: Array.from({ length: 30 }, (_, i) => topic({ topicId: `t${i}` })) });
    expect(screen.queryByTestId('topic-more')).toBeNull();
  });

  it('★ without the knowledge write permission: no decisions, and the reason', () => {
    show({ permissions: ['ai:knowledge:read'] });
    expect(screen.getByTestId('topic-read-only')).toHaveTextContent(T.readOnly);
    expect(screen.queryByTestId('topic-approve-t1')).toBeNull();
    expect(screen.queryByTestId('topic-reject-t1')).toBeNull();
    expect(screen.getByTestId('topic-option-t1-c1-1')).toBeDisabled();
  });

  it('the chosen-value line and the doc-conflict chip are drawn when sent', () => {
    show({
      pending: [
        topic({
          docConflict: true,
          items: [item({ chosenLine: 'Chosen: 449 (per your policy)' })],
        }),
      ],
    });
    expect(screen.getByTestId('topic-chosen-t1-c1')).toHaveTextContent('Chosen: 449');
    expect(screen.getByTestId('topic-doc-conflict-t1')).toHaveTextContent(T.docConflict);
  });

  it('★★ "Added automatically" is closed, and its undo rejects the topic', async () => {
    rejectTopic.mockResolvedValueOnce({ ok: true, documentsRemoved: 1 });
    show({ auto: [topic({ topicId: 'a1', status: 'auto' })] });
    expect(screen.queryByTestId('topic-auto-a1')).toBeNull();
    const toggle = screen.getByTestId('topic-auto-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByTestId('topic-auto-undo-a1'));
    expect(rejectTopic).toHaveBeenCalledWith('imp1', 'a1');
    expect(screen.getByTestId('topic-auto-a1')).toHaveTextContent(T.auto.undone);
    expect(refresh).toHaveBeenCalled();
  });

  it('nothing pending: one line, no cards', () => {
    show({ pending: [] });
    expect(screen.getByTestId('topic-all-done')).toHaveTextContent(T.allDone);
  });

  const three = (over: Partial<TopicView> = {}) =>
    topic({
      occurrences: 254,
      items: ['c1', 'c2', 'c3'].map((candidateId) => item({ candidateId })),
      ...over,
    });

  it('★★ a topic of 3 or more questions asks first, inside the card, and lands on Cancel', async () => {
    rejectTopic.mockResolvedValueOnce({ ok: true, documentsRemoved: 0 });
    show({ pending: [three()] });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    expect(rejectTopic).not.toHaveBeenCalled();
    const ask = screen.getByTestId('topic-reject-confirm-t1');
    expect(ask).toHaveTextContent(
      'Reject 3 questions from 254 conversations? None of it goes into the knowledge.',
    );
    expect(screen.getByTestId('topic-reject-back-t1')).toHaveFocus();
    expect(screen.queryByTestId('topic-approve-t1')).toBeNull();
    await userEvent.click(screen.getByTestId('topic-reject-yes-t1'));
    expect(rejectTopic).toHaveBeenCalledWith('imp1', 't1');
    expect(screen.getByTestId('topic-rejected-t1')).toHaveTextContent(T.rejected);
  });

  it('★ Cancel puts the card back as it was, on "Reject topic", and rejects nothing', async () => {
    show({ pending: [three()] });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    await userEvent.click(screen.getByTestId('topic-reject-back-t1'));
    expect(screen.queryByTestId('topic-reject-confirm-t1')).toBeNull();
    expect(rejectTopic).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByTestId('topic-reject-t1')).toHaveFocus());
    expect(approveButton()).toBeEnabled();
  });

  it('★★ Escape in the question cancels it alone: the drawer stays, nothing is rejected', async () => {
    const close = vi.fn();
    show({ pending: [three()], onDrawerClose: close });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    expect(screen.getByTestId('topic-reject-back-t1')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('topic-reject-confirm-t1')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(rejectTopic).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByTestId('topic-reject-t1')).toHaveFocus());
    expect(approveButton()).toBeEnabled();
  });

  it('★ from "Yes" too, Escape cancels the question and nothing else', async () => {
    const close = vi.fn();
    show({ pending: [three()], onDrawerClose: close });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    screen.getByTestId('topic-reject-yes-t1').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('topic-reject-confirm-t1')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(rejectTopic).not.toHaveBeenCalled();
  });

  it('★ with no question open, Escape still closes the drawer (the harness is live)', async () => {
    const close = vi.fn();
    show({ pending: [three()], onDrawerClose: close });
    screen.getByTestId('topic-reject-t1').focus();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('★ under 3 questions, "Reject topic" goes at once', async () => {
    rejectTopic.mockResolvedValueOnce({ ok: true, documentsRemoved: 0 });
    show({ pending: [topic({ items: [item(), item({ candidateId: 'c2' })] })] });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    expect(screen.queryByTestId('topic-reject-confirm-t1')).toBeNull();
    expect(rejectTopic).toHaveBeenCalledWith('imp1', 't1');
  });

  it('without a count of conversations, the question names only the questions', async () => {
    show({ pending: [three({ occurrences: 0 })] });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    expect(screen.getByTestId('topic-reject-confirm-t1')).toHaveTextContent(
      'Reject 3 questions? None of it goes into the knowledge.',
    );
  });

  it('★ a refusal after "Yes" puts the card back and says why', async () => {
    rejectTopic.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    show({ pending: [three()] });
    await userEvent.click(screen.getByTestId('topic-reject-t1'));
    await userEvent.click(screen.getByTestId('topic-reject-yes-t1'));
    expect(screen.getByRole('alert')).toHaveTextContent(T.refused.failed);
    expect(screen.queryByTestId('topic-reject-confirm-t1')).toBeNull();
    expect(approveButton()).toBeEnabled();
  });

  it('★★ "Rejected" lists what was rejected, closed, and offers nothing to press', async () => {
    show({ rejected: [topic({ topicId: 'r1', status: 'rejected', label: 'Returns' })] });
    expect(screen.queryByTestId('topic-rejected-item-r1')).toBeNull();
    const toggle = screen.getByTestId('topic-rejected-toggle');
    expect(toggle).toHaveTextContent('Rejected (1)');
    await userEvent.click(toggle);
    const listed = screen.getByTestId('topic-rejected-item-r1');
    expect(listed).toHaveTextContent('Returns');
    expect(listed).toHaveTextContent('How long is delivery?');
    expect(within(listed).queryByRole('button')).toBeNull();
    expect(within(listed).queryByRole('radio')).toBeNull();
  });

  it('no rejected topics, no section', () => {
    show();
    expect(screen.queryByTestId('topic-rejected-section')).toBeNull();
  });

  it('★★ a document conflict names the document and its sentence, in the chosen line’s place', () => {
    show({
      pending: [
        topic({
          items: [
            item({
              docConflict: { document: 'Shipping policy', passage: 'Delivery takes 5 days' },
            }),
            item({ candidateId: 'c2', docConflict: { document: 'FAQ', passage: null } }),
            item({ candidateId: 'c3', docConflict: { document: null, passage: 'x' } }),
          ],
        }),
      ],
    });
    expect(screen.getByTestId('topic-doc-conflict-line-t1-c1')).toHaveTextContent(
      'Contradicts the document Shipping policy, which says: Delivery takes 5 days',
    );
    expect(screen.getByTestId('topic-doc-conflict-line-t1-c2')).toHaveTextContent(
      /^Contradicts the document FAQ$/,
    );
    // No document named: nothing to say beyond the topic's chip.
    expect(screen.queryByTestId('topic-doc-conflict-line-t1-c3')).toBeNull();
  });

  it('without the new fields the card is drawn exactly as before', () => {
    show();
    expect(screen.queryByTestId(/^topic-doc-conflict-line-/)).toBeNull();
    expect(screen.queryByTestId('topic-rejected-section')).toBeNull();
  });
});
