import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import type { HireTool } from './hire-plan';
import { HireSheet } from './HireSheet';

const TOOLS: readonly HireTool[] = [
  {
    toolName: 'send_message',
    label: 'Send a message',
    provider: null,
    providerLabel: null,
    choices: ['do_it', 'ask_me', 'never'],
    current: 'do_it',
  },
  {
    toolName: 'shopify.process_refund',
    label: 'Refund an order',
    provider: 'shopify',
    providerLabel: 'Shopify',
    choices: ['ask_me', 'never'],
    current: 'ask_me',
  },
];

const sheet = (props: Partial<Parameters<typeof HireSheet>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ employees }}>
      <HireSheet tools={TOOLS} knowledge={['Returns policy']} {...props} />
    </NextIntlClientProvider>,
  );

describe('★ 07b - the job, where it works, its name; nothing written', () => {
  it('Continue waits for a job; "Something else" waits for its words', async () => {
    sheet();
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    await userEvent.click(screen.getByTestId('hire-job-custom'));
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hire-goal'), 'Wholesale enquiries');
    expect(screen.getByTestId('hire-continue')).toBeEnabled();
  });

  it('"It already knows" is the knowledge read', () => {
    sheet();
    expect(screen.getByTestId('hire-knows')).toHaveTextContent('Returns policy');
  });

  it('★★ no "Where should it work?" - where it works is the playbook\'s and automations\' (Omer, 2026-10-07)', () => {
    sheet();
    expect(screen.queryByText('Where should it work?')).toBeNull();
    expect(screen.queryAllByTestId(/^hire-channel-/)).toEqual([]);
  });
});

describe('★ 07c - the business’s own actions, with 10’s ceiling', () => {
  it('a money-moving action never offers "Do it"', async () => {
    sheet({ initialStep: 2 });
    expect(screen.getByTestId('hire-choice-shopify.process_refund-do_it')).toBeDisabled();
    expect(screen.getByTestId('hire-choice-send_message-do_it')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('choices are local: pressing one changes the plan, nothing else', async () => {
    sheet({ initialStep: 2 });
    await userEvent.click(screen.getByTestId('hire-choice-send_message-never'));
    expect(screen.getByTestId('hire-choice-send_message-never')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('★ 07d - the report’s shape, and nothing created', () => {
  it('eight cases of "-", and the test, Hire and watch-only are drawn not live', () => {
    sheet({ initialStep: 3 });
    expect(screen.getByTestId('hire-cases').querySelectorAll('li')).toHaveLength(8);
    for (const id of ['hire-run-test', 'hire-it', 'hire-watch']) {
      const el = screen.getByTestId(id);
      expect(el).toHaveAttribute('aria-disabled', 'true');
      expect(el.closest('a,button')).toBeNull();
    }
    expect(screen.getByTestId('hire-run-test')).toHaveAttribute(
      'title',
      'The test runs once you’re allowed to create the employee.'.replace('’', "'"),
    );
  });

  it('Back and Continue move between steps', async () => {
    sheet({ initialStep: 3 });
    await userEvent.click(screen.getByTestId('hire-back'));
    expect(screen.getByTestId('hire-sheet')).toHaveAttribute('data-step', '2');
  });
});

describe('★ 07b-07d corrections (measurement of aca09ea)', () => {
  it('from step 2, the head’s line is the plan so far', async () => {
    sheet();
    expect(screen.getByTestId('hire-line')).toHaveTextContent('You can change any of this later');
    await userEvent.click(screen.getByTestId('hire-job-sales'));
    await userEvent.click(screen.getByTestId('hire-continue'));
    expect(screen.getByTestId('hire-line')).toHaveTextContent(/^Sales$/);
  });

  it("★★ grouped by integration (Omer, 2026-10-07): each integration by name, then GOTCHA's own - its long list below them", () => {
    const woo = (toolName: string, label: string): HireTool => ({
      toolName,
      label,
      provider: 'woocommerce',
      providerLabel: 'WooCommerce',
      choices: ['do_it', 'ask_me', 'never'],
      current: 'ask_me',
    });
    sheet({
      initialStep: 2,
      tools: [woo('woocommerce.get_customer', 'Get customer'), TOOLS[1]!, TOOLS[0]!],
    });
    const groups = screen.getAllByTestId(/^hire-group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual(['hire-group-shopify', 'hire-group-woocommerce', 'hire-group-gotcha']);
    const own = screen.getByTestId('hire-group-gotcha');
    expect(own).toHaveTextContent("GOTCHA's own actions");
    expect(own.querySelector('[aria-disabled]')).toBeNull();
    const wooGroup = screen.getByTestId('hire-group-woocommerce');
    expect(wooGroup).toHaveTextContent('WooCommerce');
    // The action in words, never the tool's name.
    expect(wooGroup).toHaveTextContent('Get customer');
    expect(wooGroup).not.toHaveTextContent('get_customer');
    expect(within(wooGroup).getByRole('radiogroup')).toHaveAccessibleName(
      'WooCommerce · Get customer',
    );
  });

  it('★ "This employee may use WooCommerce" is a status - Coming soon - never a switch that remembers nothing', () => {
    sheet({ initialStep: 2 });
    const mayUse = screen.getByTestId('hire-may-use-shopify');
    expect(mayUse).toHaveTextContent('This employee may use Shopify');
    expect(mayUse).toHaveTextContent('Coming soon');
    expect(mayUse).toHaveAttribute('aria-disabled', 'true');
    expect(mayUse.tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('what these limits cost: said honestly, never a dash before a unit', () => {
    sheet({ initialStep: 2 });
    const cost = screen.getByTestId('hire-cost');
    expect(cost).toHaveTextContent('Not enough history to estimate yet');
    expect(screen.queryByText('approvals a day')).toBeNull();
  });
});
