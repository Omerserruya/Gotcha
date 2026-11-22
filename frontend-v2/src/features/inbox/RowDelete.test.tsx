import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import he from '@/i18n/messages/he/inbox.json';

const deleteConversation = vi.hoisted(() => vi.fn());
vi.mock('./conversation-actions', () => ({ deleteConversation }));
const support = vi.hoisted(() => ({ refusesDelete: false }));
vi.mock('@/support/support-context', () => ({
  useSupport: () => ({ refuses: (kind: string) => kind === 'delete' && support.refusesDelete }),
}));

const { RowDelete, RowDeleteNotices, SWIPE_THRESHOLD } = await import('./RowDelete');

const show = (props: { open?: boolean; enabled?: boolean } = {}) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ inbox: he }}>
      <RowDeleteNotices className="notice">
        <RowDelete id="c1" open={props.open ?? true} enabled={props.enabled ?? true}>
          <a href="/inbox?c=c1" data-testid="row-link">
            Dana
          </a>
        </RowDelete>
      </RowDeleteNotices>
    </NextIntlClientProvider>,
  );

const swipe = (dx: number, dy = 0) => {
  const front = screen.getByTestId('row-link').parentElement as HTMLElement;
  fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(front, {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 10 + dx,
    clientY: 10 + dy,
  });
  fireEvent.pointerUp(front, {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 10 + dx,
    clientY: 10 + dy,
  });
};

beforeEach(() => {
  deleteConversation.mockReset().mockResolvedValue({ ok: true });
  support.refusesDelete = false;
});

describe('★★ swipe right to delete (2026-11-22)', () => {
  it('⚠⚠ not an admin, or a thread from the website: the row alone, nothing to delete with', () => {
    show({ enabled: false });
    expect(screen.queryByTestId('row-delete-c1')).toBeNull();
    expect(screen.getByTestId('row-link')).toBeInTheDocument();
  });

  it('⚠⚠ support mode: nothing to delete with', () => {
    support.refusesDelete = true;
    show();
    expect(screen.queryByTestId('row-delete-c1')).toBeNull();
  });

  it('★★ a swipe past the threshold asks first, in Omer’s words', () => {
    show();
    swipe(SWIPE_THRESHOLD + 10);
    const dialog = screen.getByTestId('row-delete-confirm-c1');
    expect(dialog).toHaveTextContent('למחוק את השיחה?');
    expect(dialog).toHaveTextContent('השיחה וכל ההודעות בה יימחקו לצמיתות. אי אפשר לבטל את זה.');
    expect(screen.getByTestId('row-delete-go')).toHaveTextContent('מחיקה');
    expect(screen.getByTestId('row-delete-cancel')).toHaveTextContent('ביטול');
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('★ a short swipe, or a vertical one (the list scrolling), asks nothing', () => {
    show();
    swipe(SWIPE_THRESHOLD - 20);
    swipe(SWIPE_THRESHOLD + 10, 200);
    expect(screen.queryByTestId('row-delete-confirm-c1')).toBeNull();
  });

  it('★ a swipe is not a tap: the conversation does not also open', () => {
    show();
    const link = screen.getByTestId('row-link');
    const opened = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', opened);
    swipe(SWIPE_THRESHOLD + 10);
    fireEvent.click(link);
    expect(opened).not.toHaveBeenCalled();
  });

  it('★★ confirmed: deleted (an open one with force), and said', async () => {
    show({ open: true });
    await userEvent.click(screen.getByTestId('row-delete-button-c1'));
    await userEvent.click(screen.getByTestId('row-delete-go'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('c1', true));
    expect(await screen.findByTestId('row-delete-notice')).toHaveTextContent('השיחה נמחקה.');
  });

  it('★ a closed one goes without force, as the route expects', async () => {
    show({ open: false });
    await userEvent.click(screen.getByTestId('row-delete-button-c1'));
    await userEvent.click(screen.getByTestId('row-delete-go'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('c1', false));
  });

  it('⚠ refused: said as an alert, nothing claimed', async () => {
    deleteConversation.mockResolvedValue({ ok: false, reason: 'failed' });
    show();
    await userEvent.click(screen.getByTestId('row-delete-button-c1'));
    await userEvent.click(screen.getByTestId('row-delete-go'));
    const notice = await screen.findByTestId('row-delete-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent(he.queue.menu.failed);
  });

  it('★ cancel deletes nothing', async () => {
    show();
    await userEvent.click(screen.getByTestId('row-delete-button-c1'));
    await userEvent.click(screen.getByTestId('row-delete-cancel'));
    expect(deleteConversation).not.toHaveBeenCalled();
  });
});
