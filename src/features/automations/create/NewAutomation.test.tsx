import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { STEP_TYPES } from '@/api/contracts/automations';
import automations from '@/i18n/messages/en/automations.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { NewAutomation } from './NewAutomation';

const sheet = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ automations }}>
      <NewAutomation />
    </NextIntlClientProvider>,
  );

describe('★★ 21 — a rule assembled locally from the runner’s own steps; nothing sent', () => {
  it('THEN: a dashed row opening a menu of exactly the node types the runner executes', async () => {
    sheet();
    const add = screen.getByTestId('new-add');
    expect(add.tagName).toBe('BUTTON');
    expect(add).toHaveTextContent(/^Add a step — /);
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(
      STEP_TYPES.map((type) => `new-add-${type}`),
    );
    expect(items.map((i) => i.textContent)).toContain('Write a reply with AI');
  });

  it('adds steps in order, and removes the one asked', async () => {
    sheet();
    const pick = async (type: string) => {
      await userEvent.click(screen.getByTestId('new-add'));
      await userEvent.click(screen.getByTestId(`new-add-${type}`));
    };
    await pick('route_target');
    await pick('send_message_text');
    expect(screen.getByTestId('new-step-0')).toHaveTextContent('Pass it on');
    expect(screen.getByTestId('new-step-1')).toHaveTextContent('Send a message');
    await pick('collect_input');
    // The MIDDLE one: removing the first cannot tell "this one" from "the first".
    await userEvent.click(screen.getByTestId('new-remove-1'));
    expect(screen.getByTestId('new-step-0')).toHaveTextContent('Pass it on');
    expect(screen.getByTestId('new-step-1')).toHaveTextContent('Ask the customer for something');
    expect(screen.queryByTestId('new-step-2')).toBeNull();
    // Picking closes the menu.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the sentence and the WHEN are typed locally', async () => {
    sheet();
    await userEvent.type(screen.getByTestId('new-sentence'), 'Tell me about VIPs');
    await userEvent.type(screen.getByTestId('new-when'), 'A VIP writes');
    expect(screen.getByTestId('new-sentence')).toHaveValue('Tell me about VIPs');
    expect(screen.getByTestId('new-when')).toHaveValue('A VIP writes');
  });

  it.each([
    ['new-build', /turns a sentence into steps/],
    ['new-save', /waiting for approval/],
    ['new-test', /replays past conversations/],
    ['new-watch', /no watch-only mode/],
  ])('%s is drawn, not live, with its reason', (id, reason) => {
    sheet();
    expect(screen.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId(id)).toHaveAttribute('title', expect.stringMatching(reason));
  });

  it('★ "last month" is drawn in its shape — no invented count, no named customer', () => {
    sheet();
    const card = screen.getByTestId('new-caught');
    expect(card).toHaveTextContent('If this had been running last month');
    expect(card.textContent).not.toMatch(/\d/);
  });

  it('nothing claims the steps were assembled from the sentence', () => {
    sheet();
    expect(document.body.textContent).not.toMatch(/turned that into/);
  });
});
