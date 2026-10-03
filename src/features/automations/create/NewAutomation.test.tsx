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
  it('THEN offers exactly the node types the runner executes, in its words', () => {
    sheet();
    const options = [...screen.getByTestId('new-add').querySelectorAll('option')].slice(1);
    expect(options.map((o) => o.value)).toEqual([...STEP_TYPES]);
    expect(options.map((o) => o.textContent)).toContain('Write a reply with AI');
  });

  it('adds steps in order, and removes the one asked', async () => {
    sheet();
    await userEvent.selectOptions(screen.getByTestId('new-add'), 'route_target');
    await userEvent.selectOptions(screen.getByTestId('new-add'), 'send_message_text');
    expect(screen.getByTestId('new-step-0')).toHaveTextContent('Pass it on');
    expect(screen.getByTestId('new-step-1')).toHaveTextContent('Send a message');
    await userEvent.selectOptions(screen.getByTestId('new-add'), 'collect_input');
    // The MIDDLE one: removing the first cannot tell "this one" from "the first".
    await userEvent.click(screen.getByTestId('new-remove-1'));
    expect(screen.getByTestId('new-step-0')).toHaveTextContent('Pass it on');
    expect(screen.getByTestId('new-step-1')).toHaveTextContent('Ask the customer for something');
    expect(screen.queryByTestId('new-step-2')).toBeNull();
    // The picker goes back to its prompt, ready for the next one.
    expect(screen.getByTestId('new-add')).toHaveValue('');
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
