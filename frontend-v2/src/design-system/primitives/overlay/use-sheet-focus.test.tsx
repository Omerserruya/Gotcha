import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressSheetClose, useSheetFocus } from './use-sheet-focus';

/**
 * The URL-opened sheets' dialog behaviour (08b, Hire, Edit, `?panel=`): one
 * hook, so one set of rules - here against a bare sheet.
 */
function Sheet({ onEscape, openerId }: { onEscape: () => void; openerId?: string }) {
  const ref = useRef<HTMLElement>(null);
  useSheetFocus(ref, { onEscape, openerId });
  return (
    <section ref={ref} tabIndex={-1} data-testid="sheet">
      <a href="/back" data-sheet-close data-testid="close">
        ×
      </a>
      <input data-testid="field" />
      <button type="button">Save</button>
    </section>
  );
}

function Page({
  open,
  onEscape = () => {},
  openerId,
  withRow = true,
}: {
  open: boolean;
  onEscape?: () => void;
  openerId?: string;
  withRow?: boolean;
}) {
  return (
    <>
      {withRow ? (
        <a href="?panel=1" data-testid="row">
          A row
        </a>
      ) : null}
      <button type="button" id="the-opener" data-testid="page-opener">
        Add
      </button>
      {open ? <Sheet onEscape={onEscape} openerId={openerId} /> : null}
    </>
  );
}

describe('★★ a URL-opened sheet keeps focus like a dialog', () => {
  it('focus moves in when it opens', () => {
    render(<Page open />);
    expect(screen.getByTestId('sheet')).toHaveFocus();
  });

  it('★ focus goes back to what had it when the sheet opened - the row', () => {
    const { rerender } = render(<Page open={false} />);
    screen.getByTestId('row').focus();
    rerender(<Page open />);
    expect(screen.getByTestId('sheet')).toHaveFocus();
    rerender(<Page open={false} />);
    expect(screen.getByTestId('row')).toHaveFocus();
  });

  it('★ nothing had focus (a redirect, a Safari click): the page’s control by id', () => {
    const { rerender } = render(<Page open openerId="the-opener" />);
    rerender(<Page open={false} openerId="the-opener" />);
    expect(screen.getByTestId('page-opener')).toHaveFocus();
  });

  it('the row that opened it is gone by the time it closes: the id again', () => {
    const { rerender } = render(<Page open={false} openerId="the-opener" />);
    screen.getByTestId('row').focus();
    rerender(<Page open openerId="the-opener" />);
    rerender(<Page open={false} openerId="the-opener" withRow={false} />);
    expect(screen.getByTestId('page-opener')).toHaveFocus();
  });

  it('★ Escape closes it - once', async () => {
    const onEscape = vi.fn();
    render(<Page open onEscape={onEscape} />);
    await userEvent.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('★ an Escape a layer above already used (Radix, in capture) is not ours', () => {
    const onEscape = vi.fn();
    render(<Page open onEscape={onEscape} />);
    const above = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', above, { capture: true });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    document.removeEventListener('keydown', above, { capture: true });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('Tab and Shift+Tab go round inside it', async () => {
    render(<Page open />);
    const sheet = screen.getByTestId('sheet');
    for (let i = 0; i < 7; i += 1) {
      await userEvent.tab();
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 7; i += 1) {
      await userEvent.tab({ shift: true });
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('pressSheetClose presses the sheet’s own ×', () => {
    render(<Page open />);
    const pressed = vi.fn((event: Event) => event.preventDefault());
    screen.getByTestId('close').addEventListener('click', pressed);
    pressSheetClose(screen.getByTestId('sheet'));
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});
