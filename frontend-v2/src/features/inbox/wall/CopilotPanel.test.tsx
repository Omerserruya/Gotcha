import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { DirectionProvider } from '@/i18n/direction-context';
import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { CollapseCopilot, CopilotPanel } from './CopilotPanel';
import { copilotPanelKey } from './copilot-panel-state';

/**
 * The inbox's Copilot folds to a strip and opens again (Omer, 2026-10-25):
 * per person, keyboard first, in Hebrew too, and what was in it survives.
 */

const show = (userId: string | null = 'u1', locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ inbox: locale === 'he' ? he : en }}>
      <DirectionProvider locale={locale}>
        <CopilotPanel userId={userId} className="column" label="Context">
          <div data-testid="head">
            Copilot <CollapseCopilot />
          </div>
          {/* Stands in for the thread and the half-typed question. */}
          <input data-testid="ask" defaultValue="" aria-label="ask" />
        </CopilotPanel>
      </DirectionProvider>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  localStorage.clear();
});

describe('★★ the Copilot panel folds and opens again', () => {
  it('opens by default, with "Hide Copilot" in its header', () => {
    show();
    const panel = screen.getByTestId('copilot-panel');
    expect(panel.tagName).toBe('ASIDE');
    expect(panel).toHaveAttribute('aria-label', 'Context');
    expect(panel).not.toHaveAttribute('data-collapsed');
    const hide = screen.getByRole('button', { name: 'Hide Copilot' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', panel.id);
    expect(screen.queryByTestId('copilot-reopen')).toBeNull();
  });

  it('★★ folding keeps what was in it: the same input, still holding the half-typed question', async () => {
    const user = userEvent.setup();
    show();
    const ask = screen.getByTestId('ask');
    await user.type(ask, 'where is my order');
    await user.click(screen.getByTestId('copilot-collapse'));

    expect(screen.getByTestId('copilot-panel')).toHaveAttribute('data-collapsed', '1');
    // Not drawn, not unmounted: the very same element, with its value.
    expect(screen.getByTestId('ask')).toBe(ask);

    await user.click(screen.getByTestId('copilot-reopen'));
    expect(screen.getByTestId('copilot-panel')).not.toHaveAttribute('data-collapsed');
    expect(screen.getByTestId('ask')).toBe(ask);
    expect(ask).toHaveValue('where is my order');
  });

  it('★ keyboard: Enter folds and focus lands on "Show"; Space opens and focus is back on "Hide"', async () => {
    const user = userEvent.setup();
    show();
    screen.getByTestId('copilot-collapse').focus();
    await user.keyboard('{Enter}');
    const reopen = screen.getByRole('button', { name: 'Show Copilot' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');
    expect(reopen).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByTestId('copilot-collapse')).toHaveFocus();
  });

  it('★★ remembered per person: folded after a reload, open for a colleague on the same browser', async () => {
    const user = userEvent.setup();
    const first = show('u1');
    await user.click(screen.getByTestId('copilot-collapse'));
    expect(localStorage.getItem(copilotPanelKey('u1'))).toBe('closed');
    first.unmount();

    const again = show('u1');
    expect(screen.getByTestId('copilot-panel')).toHaveAttribute('data-collapsed', '1');
    // On a fresh mount, nothing steals focus.
    expect(screen.getByTestId('copilot-reopen')).not.toHaveFocus();
    again.unmount();

    show('u2');
    expect(screen.getByTestId('copilot-panel')).not.toHaveAttribute('data-collapsed');
  });

  it('another tab folding it folds this one', () => {
    show('u1');
    act(() => {
      localStorage.setItem(copilotPanelKey('u1'), 'closed');
      window.dispatchEvent(new StorageEvent('storage', { key: copilotPanelKey('u1') }));
    });
    expect(screen.getByTestId('copilot-panel')).toHaveAttribute('data-collapsed', '1');
  });

  it('★ in Hebrew: Hebrew names, and the icons face the panel’s edge on the left', async () => {
    const user = userEvent.setup();
    show('u1', 'he');
    const hide = screen.getByRole('button', { name: 'הסתרת Copilot' });
    expect(hide.querySelector('svg')!.getAttribute('class')).toContain('panel-left-close');
    await user.click(hide);
    const reopen = screen.getByRole('button', { name: 'הצגת Copilot' });
    expect(reopen.querySelector('svg')!.getAttribute('class')).toContain('panel-left-open');
  });

  it('and in English the right-hand ones', () => {
    show();
    const hide = screen.getByTestId('copilot-collapse');
    expect(hide.querySelector('svg')!.getAttribute('class')).toContain('panel-right-close');
  });

  it('outside a panel, no "Hide" is drawn', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ inbox: en }}>
        <CollapseCopilot />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('copilot-collapse')).toBeNull();
  });

  it('★ the sheet: folded hides every child but the strip, and the strip is logical, not left/right', () => {
    const sheet = readFileSync(path.join(__dirname, 'Wall.module.css'), 'utf8');
    expect(sheet).toContain(".panel[data-collapsed='1'] > :not(.reopen) {\n    display: none;");
    expect(sheet).toContain(".panel[data-collapsed='1'] {\n    flex-basis: 44px;");
    const fold = sheet.slice(sheet.indexOf('FOLDED'));
    expect(fold).not.toMatch(/\b(left|right)\s*:/);
    expect(fold).not.toMatch(/margin-(left|right)|padding-(left|right)/);
  });
});
