import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
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

  it('★ the name’s placeholder is a person’s name, never the job’s title (Omer, 2026-10-13, H1)', async () => {
    sheet();
    await userEvent.click(screen.getByTestId('hire-job-booking'));
    expect(screen.getByTestId('hire-name')).toHaveAttribute('placeholder', 'Ronnie');
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

  it('★★ "This employee may use Shopify" is the server’s allowlist: on for each system set up today', async () => {
    sheet({ initialStep: 2, systems: [{ slug: 'shopify', failing: false }] });
    const mayUse = screen.getByTestId('hire-may-use-shopify');
    expect(mayUse).toHaveAttribute('role', 'switch');
    expect(mayUse).toBeChecked();
    expect(mayUse).toHaveAccessibleName('This employee may use Shopify');
    expect(screen.queryByTestId('hire-off-shopify')).toBeNull();
    // Off: said for the whole group, whatever its actions say.
    await userEvent.click(mayUse);
    expect(mayUse).not.toBeChecked();
    expect(screen.getByTestId('hire-off-shopify')).toHaveTextContent(
      "Off: this employee won't use Shopify at all",
    );
    await userEvent.click(mayUse);
    expect(screen.queryByTestId('hire-off-shopify')).toBeNull();
  });

  it('★ the rule for later systems is said up front: off for everyone until turned on', () => {
    sheet({ initialStep: 2 });
    expect(screen.getByTestId('hire-later')).toHaveTextContent(
      'A system you connect later is off for every employee until you turn it on for them.',
    );
  });

  it('a system that is set up but failing says so - dev’s Shopify', () => {
    sheet({ initialStep: 2, systems: [{ slug: 'shopify', failing: true }] });
    expect(screen.getByTestId('hire-failing-shopify')).toHaveTextContent(
      'Shopify is connected but failing right now',
    );
    // Still on by default: the server allows it; the failure is the connection's.
    expect(screen.getByTestId('hire-may-use-shopify')).toBeChecked();
  });

  it('systems unread: a group with actions is a system set up, so it starts on', () => {
    sheet({ initialStep: 2, systems: null });
    expect(screen.getByTestId('hire-may-use-shopify')).toBeChecked();
  });

  it('what these limits cost: said honestly, never a dash before a unit', () => {
    sheet({ initialStep: 2 });
    const cost = screen.getByTestId('hire-cost');
    expect(cost).toHaveTextContent('Not enough history to estimate yet');
    expect(screen.queryByText('approvals a day')).toBeNull();
  });
});

describe('★ Escape closes it, as the ×; it is a modal dialog', () => {
  it('Escape presses the sheet’s own ×; focus starts inside', async () => {
    sheet();
    const dialog = screen.getByRole('dialog', { name: 'Hire an AI employee' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const close = dialog.querySelector<HTMLElement>('[data-sheet-close]')!;
    expect(close).toHaveAccessibleName('Close');
    const pressed = vi.fn((event: Event) => event.preventDefault());
    close.addEventListener('click', pressed);
    await userEvent.keyboard('{Escape}');
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});

/*
 * H6 (Omer, 2026-10-13): "X during hiring closes without asking, and
 * reopening starts from zero." The draft is this browser's, per person.
 */
describe('★★ H6 - a hire that was closed continues where it stopped', () => {
  const KEY = 'gotcha:hire-draft:v1:u1';
  beforeEach(() => {
    window.localStorage.clear();
    push.mockClear();
  });

  it('★★ nothing entered: × closes at once, nothing kept', async () => {
    sheet({ viewerId: 'u1' });
    const close = screen.getByTestId('hire-close');
    const clicked = fireEvent.click(close);
    expect(clicked).toBe(true); // not prevented: the link navigates
    expect(screen.queryByTestId('hire-close-ask')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('★★ something entered: × asks; "Keep going" stays, "Close" leaves', async () => {
    sheet({ viewerId: 'u1' });
    await userEvent.click(screen.getByTestId('hire-job-sales'));
    expect(fireEvent.click(screen.getByTestId('hire-close'))).toBe(false);
    expect(screen.getByTestId('hire-close-ask')).toHaveTextContent('Close for now?');
    await userEvent.click(screen.getByTestId('hire-close-no'));
    expect(screen.queryByTestId('hire-close-ask')).toBeNull();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hire-close'));
    await userEvent.click(screen.getByTestId('hire-close-yes'));
    expect(push).toHaveBeenCalledWith('/studio/employees');
  });

  it('★★ what was entered is kept, under this person, and read back on reopening', async () => {
    const { unmount } = sheet({ viewerId: 'u1' });
    await userEvent.click(screen.getByTestId('hire-job-sales'));
    await userEvent.type(screen.getByTestId('hire-name'), 'Noa');
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toContain('"name":"Noa"'));
    unmount();
    sheet({ viewerId: 'u1' });
    await waitFor(() => expect(screen.getByTestId('hire-name')).toHaveValue('Noa'));
    expect(screen.getByTestId('hire-restored')).toHaveTextContent(
      'Continuing the hire you started.',
    );
    // Another person in this browser does not get it.
    unmount();
  });

  it('another person: not theirs', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ step: 1, plan: { job: 'sales', name: 'Noa' } }),
    );
    sheet({ viewerId: 'u2' });
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByTestId('hire-name')).toHaveValue('');
    expect(screen.queryByTestId('hire-restored')).toBeNull();
  });

  it('★ "Start over" clears it, back to step 1', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        step: 2,
        plan: { job: 'sales', goal: '', name: 'Noa', choices: {}, access: [], rules: [] },
      }),
    );
    sheet({ viewerId: 'u1' });
    await waitFor(() => expect(screen.getByTestId('hire-restored')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('hire-start-over'));
    expect(screen.getByTestId('hire-name')).toHaveValue('');
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull());
  });
});

/*
 * H3 (Omer, 2026-10-13): "להעביר תמיד לאדם כש…" - its Add did nothing. Now a
 * section of its own: the conditions as a list (the employee page's editor),
 * the chips as quick adds.
 */
describe('★★ H3 - handoff to a person: a list to add, edit and remove', () => {
  const KEY = 'gotcha:hire-draft:v1:u1';
  beforeEach(() => window.localStorage.clear());
  const labels = () =>
    screen
      .queryAllByTestId(/^hire-rule-\d+-label$/)
      .map((input) => (input as HTMLInputElement).value);

  it('a hire starts with one condition, the first chip’s; that chip is not offered again', () => {
    sheet({ initialStep: 2 });
    expect(screen.getByTestId('hire-handover')).toHaveTextContent(
      'Always hand over to a person when…',
    );
    expect(labels()).toEqual(['they ask for a person']);
    expect(screen.getByTestId('hire-rule-0-on')).toBeChecked();
    expect(screen.queryByTestId('hire-handover-askPerson')).toBeNull();
    expect(screen.getByTestId('hire-handover-vip')).toBeEnabled();
  });

  it('★ Add works: an empty condition, Continue held and why, until it has words', async () => {
    sheet({ initialStep: 2 });
    await userEvent.click(screen.getByTestId('hire-rule-add'));
    expect(labels()).toEqual(['they ask for a person', '']);
    expect(screen.getByTestId('hire-rules-problem')).toHaveTextContent(
      'Every condition needs words. Write them, or remove it.',
    );
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hire-rule-1-label'), 'the order is over 2000');
    expect(screen.queryByTestId('hire-rules-problem')).toBeNull();
    expect(screen.getByTestId('hire-continue')).toBeEnabled();
    expect(labels()).toEqual(['they ask for a person', 'the order is over 2000']);
  });

  it('edit: reworded, switched off; remove: gone, and its chip is back', async () => {
    sheet({ initialStep: 2 });
    const label = screen.getByTestId('hire-rule-0-label');
    await userEvent.clear(label);
    await userEvent.type(label, 'they ask for a manager');
    await userEvent.click(screen.getByTestId('hire-rule-0-on'));
    expect(labels()).toEqual(['they ask for a manager']);
    expect(screen.getByTestId('hire-rule-0-on')).not.toBeChecked();
    // Reworded, the first chip's words are no longer a condition: offered again.
    expect(screen.getByTestId('hire-handover-askPerson')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('hire-rule-0-remove'));
    expect(labels()).toEqual([]);
    expect(screen.getByTestId('hire-rules-none')).toHaveTextContent('No conditions yet.');
  });

  it('★ a chip is a quick add: its words become a condition, on, and the chip goes', async () => {
    sheet({ initialStep: 2 });
    await userEvent.click(screen.getByTestId('hire-handover-vip'));
    expect(labels()).toEqual(['they ask for a person', 'a VIP writes']);
    expect(screen.getByTestId('hire-rule-1-on')).toBeChecked();
    expect(screen.queryByTestId('hire-handover-vip')).toBeNull();
    await userEvent.click(screen.getByTestId('hire-rule-1-remove'));
    expect(screen.getByTestId('hire-handover-vip')).toBeInTheDocument();
  });

  it('★ 300: a condition’s words stop at the route’s limit', () => {
    sheet({ initialStep: 2 });
    expect(screen.getByTestId('hire-rule-0-label')).toHaveAttribute('maxLength', '300');
  });

  it('★ 50: at the route’s limit there is no Add and no chip, and the line says why', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        step: 2,
        plan: {
          job: 'sales',
          rules: Array.from({ length: 49 }, (_, i) => ({ label: `r${i}`, enabled: true })),
        },
      }),
    );
    sheet({ initialStep: 2, viewerId: 'u1' });
    await waitFor(() => expect(labels()).toHaveLength(49));
    expect(screen.queryByTestId('hire-rules-full')).toBeNull();
    await userEvent.click(screen.getByTestId('hire-handover-vip'));
    expect(labels()).toHaveLength(50);
    expect(screen.queryByTestId('hire-rule-add')).toBeNull();
    expect(screen.queryByTestId('hire-suggestions')).toBeNull();
    expect(screen.getByTestId('hire-rules-full')).toHaveTextContent(
      '50 conditions, the most it keeps.',
    );
  });

  it('the conditions are kept with the hire, as written', async () => {
    sheet({ initialStep: 2, viewerId: 'u1' });
    await userEvent.click(screen.getByTestId('hire-handover-annoyed'));
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(KEY)!).plan.rules).toEqual([
        { label: 'they ask for a person', enabled: true },
        { label: 'they sound annoyed', enabled: true },
      ]),
    );
  });
});
