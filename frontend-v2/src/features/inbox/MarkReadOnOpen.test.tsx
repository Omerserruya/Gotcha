import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ⚠ The write is mocked: nothing here reaches the platform.
 *
 * ⚠ The calls are recorded by a `vi.fn` that returns nothing, and the promise
 *   is made outside it: a `vi.fn` attaches its own handlers to a promise it
 *   returns (`settledResults`), so a rejection it returned is never
 *   "unhandled" - and a mutation dropping the component's `.catch` passed.
 */
const markReadOnOpen = vi.hoisted(() => vi.fn());
const fail = vi.hoisted(() => ({ now: false }));
vi.mock('./conversation-actions', () => ({
  markReadOnOpen: (...args: unknown[]) => {
    markReadOnOpen(...args);
    return fail.now ? Promise.reject(new Error('network')) : Promise.resolve();
  },
}));

import { MarkReadOnOpen } from './MarkReadOnOpen';

beforeEach(() => {
  markReadOnOpen.mockReset();
  fail.now = false;
});

describe('★★ opening a conversation marks it read - once per open', () => {
  it('★★ once for the id, with whether the list must re-read', () => {
    render(<MarkReadOnOpen conversationId="c1" readState="unread" />);
    expect(markReadOnOpen).toHaveBeenCalledTimes(1);
    expect(markReadOnOpen).toHaveBeenCalledWith('c1', true);
  });

  it('⚠⚠ not again on a re-render of the same id - nor when its row turns read or unread', () => {
    const { rerender } = render(<MarkReadOnOpen conversationId="c1" readState="unread" />);
    rerender(<MarkReadOnOpen conversationId="c1" readState="unread" />);
    // This call's own refresh: the row is read now.
    rerender(<MarkReadOnOpen conversationId="c1" readState="read" />);
    // "Mark as unread" on the open row: the person asked for it - not undone.
    rerender(<MarkReadOnOpen conversationId="c1" readState="unread" />);
    expect(markReadOnOpen).toHaveBeenCalledTimes(1);
  });

  it('★ another id is another open, and coming back is one too', () => {
    const { rerender } = render(<MarkReadOnOpen conversationId="c1" readState="unknown" />);
    rerender(<MarkReadOnOpen conversationId="c2" readState="unread" />);
    rerender(<MarkReadOnOpen conversationId="c1" readState="unknown" />);
    expect(markReadOnOpen.mock.calls).toEqual([
      ['c1', false],
      ['c2', true],
      ['c1', false],
    ]);
  });

  it('★★ a row the server says is read sends nothing - no write, so no echo re-rendering the page', () => {
    render(<MarkReadOnOpen conversationId="c1" readState="read" />);
    expect(markReadOnOpen).not.toHaveBeenCalled();
  });

  it('★ unknown read state (opened by id): sent, but the list is not re-read by us - the echo does it', () => {
    render(<MarkReadOnOpen conversationId="c1" readState="unknown" />);
    expect(markReadOnOpen).toHaveBeenCalledWith('c1', false);
  });

  it('⚠ a read row that turns unread while open is not marked read behind the person', () => {
    const { rerender } = render(<MarkReadOnOpen conversationId="c1" readState="read" />);
    rerender(<MarkReadOnOpen conversationId="c1" readState="unread" />);
    expect(markReadOnOpen).not.toHaveBeenCalled();
  });

  it('⚠ Strict Mode’s double effect does not send it twice', () => {
    render(
      <StrictMode>
        <MarkReadOnOpen conversationId="c1" readState="unknown" />
      </StrictMode>,
    );
    expect(markReadOnOpen).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ a failure is silent: handled, nothing thrown, nothing drawn', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      fail.now = true;
      const { container } = render(<MarkReadOnOpen conversationId="c1" readState="unread" />);
      await act(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(container).toBeEmptyDOMElement();
      expect(markReadOnOpen).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
