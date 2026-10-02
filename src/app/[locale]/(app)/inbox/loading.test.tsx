import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Loading from './loading';

/*
 * ★★ OMER: "content placeholders". The frame and both panels at once, with
 *    the shape of their content inside — before the first read returns.
 */
describe('★★ the inbox before its first read', () => {
  it('draws both panels, each with its own placeholders', () => {
    render(<Loading />);
    const screenEl = screen.getByTestId('inbox-loading');
    expect(screenEl).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('queue-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('queue-row-skeleton').length).toBeGreaterThan(3);
    expect(screen.getByTestId('header-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('stream-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('composer-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('context-skeleton')).toBeInTheDocument();
  });

  it('⚠ inside the same frame the page draws, so nothing moves when it lands', () => {
    // Same opt-out of the shell surface as the page (`data-owns-panels`).
    render(<Loading />);
    expect(screen.getByTestId('inbox-loading')).toHaveAttribute('data-owns-panels');
  });
});
