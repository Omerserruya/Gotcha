import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import he from '@/i18n/messages/he/inbox.json';

const deleteConversation = vi.hoisted(() => vi.fn());
const markConversationUnread = vi.hoisted(() => vi.fn());
const markConversationRead = vi.hoisted(() => vi.fn());
vi.mock('./conversation-actions', () => ({
  deleteConversation,
  markConversationUnread,
  markConversationRead,
}));
const support = vi.hoisted(() => ({ refusesDelete: false }));
vi.mock('@/support/support-context', () => ({
  useSupport: () => ({ refuses: (kind: string) => kind === 'delete' && support.refusesDelete }),
}));

const { RowDelete, RowDeleteNotices, SWIPE_THRESHOLD, useReadOverride } =
  await import('./RowDelete');

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
  markConversationUnread.mockReset().mockResolvedValue({ ok: true });
  markConversationRead.mockReset().mockResolvedValue({ ok: true });
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

  it('⚠⚠ at rest nothing of the delete strip is drawn: no label, no strip (prod, 11-23)', () => {
    show();
    expect(screen.queryByTestId('row-delete-behind-c1')).toBeNull();
    expect(screen.queryByText('מחיקה')).toBeNull();
  });

  it('★ the strip shows only while the row is dragged right, and leaves when let go', () => {
    show();
    const front = screen.getByTestId('row-link').parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 10 });
    expect(screen.getByTestId('row-delete-behind-c1')).toHaveTextContent('מחיקה');
    fireEvent.pointerUp(front, { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 10 });
    expect(screen.queryByTestId('row-delete-behind-c1')).toBeNull();
    expect(screen.queryByText('מחיקה')).toBeNull();
  });

  it('★★ a swipe past the threshold asks first, in Omer’s words', () => {
    show();
    swipe(SWIPE_THRESHOLD + 10);
    const dialog = screen.getByTestId('row-delete-confirm-c1');
    expect(dialog).toHaveTextContent('למחוק את השיחה?');
    expect(dialog).toHaveTextContent(
      'השיחה, כל ההודעות והקבצים בה יימחקו לצמיתות. אי אפשר לבטל את זה.',
    );
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

/** What the row's badge reads: the swipe's mark, or the server's (`null`). */
function Probe() {
  const override = useReadOverride();
  return <span data-testid="override">{override === null ? 'server' : String(override)}</span>;
}

const showRead = (props: { unread?: boolean; enabled?: boolean } = {}) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ inbox: he }}>
      <RowDeleteNotices className="notice">
        <RowDelete
          id="c1"
          open
          enabled={props.enabled ?? false}
          read={{ unread: props.unread ?? false }}
        >
          <a href="/m/inbox/c1" data-testid="row-link">
            Dana
          </a>
          <Probe />
        </RowDelete>
      </RowDeleteNotices>
    </NextIntlClientProvider>,
  );

describe('★★ swipe left: mark unread, or read again (2026-11-24)', () => {
  it('★★ a read row: past the threshold it is marked unread, and turns AT ONCE', async () => {
    showRead({ unread: false });
    swipe(-(SWIPE_THRESHOLD + 10));
    expect(screen.getByTestId('override')).toHaveTextContent('true');
    expect(screen.getByTestId('row-delete-c1')).toHaveAttribute('data-read-override', 'unread');
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalledWith('c1'));
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('★★ an unread row: marked read', async () => {
    showRead({ unread: true });
    swipe(-(SWIPE_THRESHOLD + 10));
    expect(screen.getByTestId('override')).toHaveTextContent('false');
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c1'));
    expect(markConversationUnread).not.toHaveBeenCalled();
  });

  it('★ the strip shows the mark it will set, icon only, while dragged left', () => {
    showRead({ unread: false });
    const front = screen.getByTestId('row-link').parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 10 });
    const strip = screen.getByTestId('row-read-behind-c1');
    expect(strip).toHaveAttribute('data-action', 'unread');
    expect(strip).toHaveAttribute('title', 'סמן כלא נקרא');
    expect(strip).toHaveTextContent('');
    fireEvent.pointerUp(front, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 10 });
    expect(screen.queryByTestId('row-read-behind-c1')).toBeNull();
  });

  it('★ on an unread row the strip says "סמן כנקרא"', () => {
    showRead({ unread: true });
    const front = screen.getByTestId('row-link').parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 10 });
    expect(screen.getByTestId('row-read-behind-c1')).toHaveAttribute('title', 'סמן כנקרא');
  });

  it('⚠⚠ short of the threshold: nothing is written, nothing turns', () => {
    showRead();
    swipe(-(SWIPE_THRESHOLD - 10));
    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(screen.getByTestId('override')).toHaveTextContent('server');
  });

  it('⚠⚠ a refused write gives the row back, and says so', async () => {
    markConversationUnread.mockResolvedValue({ ok: false, reason: 'failed' });
    showRead({ unread: false });
    swipe(-(SWIPE_THRESHOLD + 10));
    await waitFor(() => expect(screen.getByTestId('override')).toHaveTextContent('server'));
    expect(screen.getByTestId('row-delete-notice')).toHaveAttribute('role', 'alert');
  });

  it('★ the server’s new answer replaces the swipe’s mark', async () => {
    const view = showRead({ unread: false });
    swipe(-(SWIPE_THRESHOLD + 10));
    expect(screen.getByTestId('override')).toHaveTextContent('true');
    view.rerender(
      <NextIntlClientProvider locale="he" messages={{ inbox: he }}>
        <RowDeleteNotices className="notice">
          <RowDelete id="c1" open enabled={false} read={{ unread: true }}>
            <a href="/m/inbox/c1" data-testid="row-link">
              Dana
            </a>
            <Probe />
          </RowDelete>
        </RowDeleteNotices>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('override')).toHaveTextContent('server');
  });

  it('⚠⚠ not an admin: left still marks, right deletes nothing and draws no trash', () => {
    showRead({ enabled: false });
    expect(screen.queryByTestId('row-delete-button-c1')).toBeNull();
    swipe(SWIPE_THRESHOLD + 10);
    expect(screen.queryByTestId('row-delete-confirm-c1')).toBeNull();
    expect(screen.queryByTestId('row-delete-behind-c1')).toBeNull();
    swipe(-(SWIPE_THRESHOLD + 10));
    expect(markConversationUnread).toHaveBeenCalledTimes(1);
  });

  it('★ an admin has both: right still asks to delete', () => {
    showRead({ enabled: true });
    swipe(SWIPE_THRESHOLD + 10);
    expect(screen.getByTestId('row-delete-confirm-c1')).toBeInTheDocument();
    expect(markConversationUnread).not.toHaveBeenCalled();
  });

  it('⚠⚠ without `read` (the website’s list) a left swipe does nothing', () => {
    show();
    swipe(-(SWIPE_THRESHOLD + 10));
    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(markConversationRead).not.toHaveBeenCalled();
    expect(screen.queryByTestId('row-read-behind-c1')).toBeNull();
  });

  it('⚠⚠ mid-drag, a way with no action does not move the row or draw a strip', () => {
    // The website's list (no `read`): a left drag stays put.
    const site = show();
    let front = screen.getByTestId('row-link').parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 1, clientX: 120, clientY: 10 });
    expect(front.style.transform).toBe('');
    expect(screen.queryByTestId('row-read-behind-c1')).toBeNull();
    site.unmount();

    // Not an admin on the phone: a right drag stays put.
    showRead({ enabled: false });
    front = screen.getByTestId('row-link').parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 2, clientX: 90, clientY: 10 });
    expect(front.style.transform).toBe('');
    expect(screen.queryByTestId('row-delete-behind-c1')).toBeNull();
  });

  it('★ a swipe left is not a tap: it never also opens the conversation', () => {
    showRead();
    const link = screen.getByTestId('row-link');
    const opened = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', opened);
    const front = link.parentElement as HTMLElement;
    fireEvent.pointerDown(front, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(front, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.pointerUp(front, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.click(link);
    expect(opened).not.toHaveBeenCalled();
  });
});
