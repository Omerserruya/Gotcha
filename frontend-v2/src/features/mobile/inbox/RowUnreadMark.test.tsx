import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const override = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock('@/features/inbox/RowDelete', () => ({ useReadOverride: () => override.value }));

const { RowUnreadMark } = await import('./RowUnreadMark');

const show = (mark: Parameters<typeof RowUnreadMark>[0]['mark'], value: boolean | null) => {
  override.value = value;
  return render(
    <RowUnreadMark
      mark={mark}
      unreadLabel="לא נקראה"
      countLabel={mark?.kind === 'count' ? '3 הודעות' : null}
    />,
  );
};

describe('★★ the row turns at once when swiped (2026-11-24)', () => {
  it('★ no swipe: the server’s count', () => {
    show({ kind: 'count', count: 3 }, null);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('★ no swipe, nothing unread: nothing', () => {
    const { container } = show(null, null);
    expect(container).toBeEmptyDOMElement();
  });

  it('★★ swiped unread on a read row: a dot, as the server draws a manual mark', () => {
    show(null, true);
    expect(screen.getByTestId('row-unread-dot')).toHaveTextContent('לא נקראה');
  });

  it('★ swiped unread on a counted row: the count stays', () => {
    show({ kind: 'count', count: 3 }, true);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('★★ swiped read: the count goes at once', () => {
    const { container } = show({ kind: 'count', count: 3 }, false);
    expect(container).toBeEmptyDOMElement();
  });

  it('★ "99+" stays a number, left-to-right', () => {
    show({ kind: 'count', count: 120 }, null);
    expect(screen.getByText('99+')).toHaveAttribute('dir', 'ltr');
  });
});
