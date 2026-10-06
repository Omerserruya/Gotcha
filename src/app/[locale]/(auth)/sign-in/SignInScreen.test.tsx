import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The composition root that lets the two halves of the screen agree.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE BUG THIS EXISTS FOR IS INVISIBLE TO EVERY OTHER TEST HERE
 * ════════════════════════════════════════════════════════════════════════════
 * The editorial panel and the footnote were server-rendered siblings of
 * `SignInPanel`, which owns the flow stage in client state. Nothing connected
 * them, so the second-factor screen wore sign-in's figures **and** its
 * footnote - *"New here? Ask your workspace admin for an invitation."* to
 * somebody already halfway signed in.
 *
 * ★ `page.test.tsx` mocks the panel, so it renders the first screen and can
 *   never see the change. The panel's own tests do not know the layout
 *   exists. **This file is the only place the two facts meet**, which is
 *   exactly where the defect lived.
 */

/*
 * A panel that does nothing but announce a screen when asked. The real one
 * drives a flow over `fetch`; what this file is about is what happens AROUND
 * it when the stage changes, and a stub makes that the only variable.
 */
vi.mock('@/features/auth/SignInPanel', () => ({
  SignInPanel: ({ onScreen }: { onScreen?: (screen: 'signIn' | 'secondFactor') => void }) => (
    <button type="button" onClick={() => onScreen?.('secondFactor')}>
      advance
    </button>
  ),
}));

const { SignInScreen } = await import('./SignInScreen');

const show = () =>
  render(
    <SignInScreen
      handOverHref="/api/auth/login"
      recoverPath="/v2/en/recover"
      brand={<div>GOTCHA</div>}
      ticks={<div data-testid="ticks" />}
      figures={{
        signIn: <p>Three hundred and forty people</p>,
        secondFactor: <p>A refund is real money</p>,
      }}
      status={{ signIn: 'All systems operational', secondFactor: 'Two-step is required' }}
      notice={<p role="alert">Your sign-in expired</p>}
      footnote={<p>New here? Ask your workspace admin</p>}
    />,
  );

describe('⚠⚠ the editorial panel follows the screen', () => {
  it('★ starts on sign-in: its figures, its status, its footnote', async () => {
    show();
    expect(screen.getByText(/three hundred and forty/i)).toBeInTheDocument();
    expect(screen.getByText(/all systems operational/i)).toBeInTheDocument();
    expect(screen.getByText(/new here\?/i)).toBeInTheDocument();
  });

  it('⚠⚠ swaps all three when the panel reaches the second factor', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'advance' }));

    expect(screen.getByText(/a refund is real money/i)).toBeInTheDocument();
    expect(screen.queryByText(/three hundred and forty/i)).toBeNull();
    expect(screen.getByText(/two-step is required/i)).toBeInTheDocument();
  });

  it('⚠⚠ and the footnote goes, because "New here?" is already answered', async () => {
    /*
     * The one that is not cosmetic. Somebody on the second factor has typed a
     * password; telling them to ask an admin for an invitation is a wrong
     * statement, not merely the wrong copy.
     */
    show();
    await userEvent.click(screen.getByRole('button', { name: 'advance' }));
    expect(screen.queryByText(/new here\?/i)).toBeNull();
  });

  it('★ the arrival error goes with it', async () => {
    /*
     * `?error=expired` explains how somebody arrived at sign-in. It says
     * nothing about a code screen reached two stages later, and leaving it up
     * would attach a stale reason to a new question.
     */
    show();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'advance' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('★★ the shell does not move - same brand, same ticks, on both', async () => {
    /*
     * Both directions. A switch that swapped the whole aside would satisfy
     * every assertion above and rebuild the panel on each stage, losing the
     * rotation's 15s cycle mid-turn.
     */
    show();
    expect(screen.getByText('GOTCHA')).toBeInTheDocument();
    expect(screen.getByTestId('ticks')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'advance' }));
    expect(screen.getByText('GOTCHA')).toBeInTheDocument();
    expect(screen.getByTestId('ticks')).toBeInTheDocument();
  });
});

describe('⚠⚠ the form column is not the same width on both screens', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * 400px ON 00a, 430px ON 00b - AND THE SLOTS DIVIDE IT
   * ════════════════════════════════════════════════════════════════════════
   * Thirty pixels, read out of each screen's own mock. It is not only the
   * column that changes: the six code boxes are `flex: 1`, so they divide
   * whatever this is -
   *
   *     400px → 60px each        430px → 65px each
   *
   * ★ Which is also the correction to something I wrote: "the mock's slots
   *   are square" was arithmetic on OUR 400px column, not a fact about the
   *   design. At 430 they are 65×60. Using the design's RULE rather than its
   *   number is what made that mistake cost nothing.
   */
  it('⚠⚠ marks which screen the column belongs to', async () => {
    const { container } = show();
    const column = container.querySelector('[data-screen]');
    expect(column).toHaveAttribute('data-screen', 'signIn');

    await userEvent.click(screen.getByRole('button', { name: 'advance' }));
    expect(container.querySelector('[data-screen]')).toHaveAttribute('data-screen', 'secondFactor');
  });

  it('★★ and the stylesheet gives each screen its own width', () => {
    /*
     * The attribute is only half of it - a marker nothing styles would pass
     * the assertion above and change no pixel. Asserted against the rule that
     * consumes it, and against the arithmetic the slots depend on.
     */
    const css = readFileSync('src/app/[locale]/(auth)/sign-in/SignIn.module.css', 'utf8');
    expect(/\.form\s*\{[^}]*inline-size:\s*400px/.test(css)).toBe(true);
    expect(/\.form\[data-screen='secondFactor'\]\s*\{[^}]*inline-size:\s*430px/.test(css)).toBe(
      true,
    );
  });
});
