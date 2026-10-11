import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import rowLink from '@/design-system/styles/row-link.module.css';

import { RowTipForward } from './RowTipForward';

/**
 * The whole row is clickable, chips included: a chip that explains itself on
 * hover sits above the row's link, and a click on it opens the row all the same.
 */
const row = (onOpen: (event: React.MouseEvent) => void, onPick = vi.fn()) =>
  render(
    <>
      <RowTipForward />
      <div className={rowLink.row}>
        <a href="#open" className={rowLink.link} onClick={onOpen} data-testid="open">
          Shopify
        </a>
        <span className={rowLink.tip} title="Needs attention" data-testid="chip">
          Needs attention
        </span>
        <button type="button" className={rowLink.above} onClick={onPick} data-testid="picker">
          Pick
        </button>
      </div>
    </>,
  );

describe('★★ a chip with a tooltip opens its row too (2026-10-11)', () => {
  it('a click on the chip opens the row’s link', () => {
    const onOpen = vi.fn((event: React.MouseEvent) => event.preventDefault());
    row(onOpen);
    fireEvent.click(screen.getByTestId('chip'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('★ with the same keys - Ctrl or Cmd still means a new tab', () => {
    const seen: boolean[] = [];
    row((event) => {
      event.preventDefault();
      seen.push(event.ctrlKey || event.metaKey);
    });
    fireEvent.click(screen.getByTestId('chip'), { metaKey: true });
    expect(seen).toEqual([true]);
  });

  it('⚠ a real control above the row is not forwarded - it does its own thing', () => {
    const onOpen = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const onPick = vi.fn();
    row(onOpen, onPick);
    fireEvent.click(screen.getByTestId('picker'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('★ the chip is no tab stop of its own', () => {
    row(vi.fn());
    expect(screen.getByTestId('chip')).not.toHaveAttribute('tabindex');
  });
});
