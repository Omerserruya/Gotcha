import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';

const push = vi.hoisted(() => vi.fn());
/* ⚠ Hiring is real: the server action is replaced, and nothing reaches a server. */
const hireEmployee = vi.hoisted(() => vi.fn());
vi.mock('./hire-actions', () => ({ hireEmployee }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { employeeKnowledgeSourceSchema } from '../page/knowledge-plan';
import type { HireSkill, HireTool } from './hire-plan';
import { HireSheet } from './HireSheet';

const source = (id: string, over: Record<string, unknown> = {}) =>
  employeeKnowledgeSourceSchema.parse({ id, name: `KB ${id}`, isActive: true, ...over });
const SOURCES = [
  source('returns', { name: 'Returns policy', scope: 'all' }),
  source('faq', { name: 'FAQ', scope: 'agent', scopeAgentId: 'other' }),
  source('old', { name: 'Old prices', scope: 'agent', isActive: false }),
];
const SKILLS: readonly HireSkill[] = [
  { id: 's1', name: 'Refund a late order', situation: 'My order is late', status: 'active' },
  { id: 's2', name: 'Book a visit', situation: null, status: 'draft' },
];

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
      <HireSheet tools={TOOLS} knowledge={SOURCES} skills={SKILLS} {...props} />
    </NextIntlClientProvider>,
  );

describe('★ 07b - the job, where it works, its name; nothing written', () => {
  it('Continue waits for a job; "Something else" waits for its words; and a name (H5)', async () => {
    sheet();
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    await userEvent.click(screen.getByTestId('hire-job-custom'));
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hire-goal'), 'Wholesale enquiries');
    expect(screen.getByTestId('hire-continue')).toBeDisabled();
    expect(screen.getByTestId('hire-name-needed')).toHaveTextContent(
      'It needs a name to be hired.',
    );
    await userEvent.type(screen.getByTestId('hire-name'), 'Noa');
    expect(screen.getByTestId('hire-continue')).toBeEnabled();
    expect(screen.queryByTestId('hire-name-needed')).toBeNull();
  });

  it('★ Sales says where it is chosen that it cannot be hired from here yet', async () => {
    sheet();
    await userEvent.click(screen.getByTestId('hire-job-sales'));
    expect(screen.getByTestId('hire-sales-note')).toHaveTextContent(
      'A sales employee needs a sales pipeline',
    );
    await userEvent.click(screen.getByTestId('hire-job-booking'));
    expect(screen.queryByTestId('hire-sales-note')).toBeNull();
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

describe('Back and Continue', () => {
  it('move between steps', async () => {
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
    await userEvent.type(screen.getByTestId('hire-name'), 'Noa');
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
          name: 'Noa',
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

/** A hire at the summary: job, name, the rest where a hire starts unless given. */
const KEY = 'gotcha:hire-draft:v1:u1';
async function atSummary(
  plan: Record<string, unknown> = {},
  props: Partial<Parameters<typeof HireSheet>[0]> = {},
  extra: Record<string, unknown> = {},
) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ step: 4, plan: { job: 'booking', name: 'Ronnie', ...plan }, ...extra }),
  );
  const view = sheet({ viewerId: 'u1', ...props });
  await waitFor(() => expect(screen.getByTestId('hire-sum-name')).toHaveTextContent('Ronnie'));
  return view;
}

describe('★★ H4 - knowledge and skills, chosen before the summary', () => {
  beforeEach(() => window.localStorage.clear());

  it('knowledge by the page’s rule: what everyone reads has no switch; the rest start connected if active', async () => {
    sheet({ initialStep: 3 });
    expect(screen.getByTestId('hire-sheet')).toHaveAttribute('data-step', '3');
    expect(screen.getByTestId('hire-knows-returns')).toHaveTextContent('Every employee reads it');
    expect(screen.queryByTestId('hire-knows-returns-on')).toBeNull();
    expect(screen.getByTestId('hire-knows-faq-on')).toBeChecked();
    expect(screen.getByTestId('hire-knows-faq')).toHaveTextContent('Connected to this employee');
    expect(screen.getByTestId('hire-knows-old')).toHaveTextContent('Switched off in Knowledge');
    expect(screen.getByTestId('hire-knows-old-on')).not.toBeChecked();
    await userEvent.click(screen.getByTestId('hire-knows-faq-on'));
    expect(screen.getByTestId('hire-knows-faq')).toHaveTextContent('Not connected');
  });

  it('skills: given here, a draft skill says so', async () => {
    sheet({ initialStep: 3 });
    expect(screen.getByTestId('hire-skill-s2')).toHaveTextContent('Draft: runs nowhere');
    const on = screen.getByTestId('hire-skill-s1-on');
    expect(on).not.toBeChecked();
    expect(on).toHaveAccessibleName('Give Refund a late order to this employee');
    await userEvent.click(on);
    expect(on).toBeChecked();
  });

  it('unread: each says so, never "none"', () => {
    sheet({ initialStep: 3, knowledge: null, skills: null });
    expect(screen.getByTestId('hire-knowledge-unread')).toHaveTextContent("couldn't be read");
    expect(screen.getByTestId('hire-skills-unread')).toHaveTextContent("couldn't be read");
  });

  it('none in the workspace: said, with where to add them', () => {
    sheet({ initialStep: 3, knowledge: [], skills: [] });
    expect(screen.getByTestId('hire-knowledge-none')).toHaveTextContent('Manage knowledge');
    expect(screen.getByTestId('hire-skills-none')).toHaveTextContent('Write a skill');
  });
});

describe('★★ H4 - the summary: the whole employee, each part with an Edit back to its step', () => {
  beforeEach(() => window.localStorage.clear());

  it('every part, as chosen', async () => {
    await atSummary(
      {
        knowledge: ['faq'],
        skills: ['s1'],
        rules: [
          { label: 'a VIP writes', enabled: true },
          { label: 'they sound annoyed', enabled: false },
        ],
        choices: { send_message: 'ask_me' },
      },
      { systems: [{ slug: 'shopify', name: 'Shopify', failing: false }] },
    );
    expect(screen.getByTestId('hire-sum-job')).toHaveTextContent('Bookings');
    expect(screen.getByTestId('hire-sum-goal')).toHaveTextContent(
      'Take booking requests and answer questions about availability.',
    );
    expect(screen.getByTestId('hire-sum-actions')).toHaveTextContent(
      'Do it: 0 · Ask me: 2 · Never: 0',
    );
    expect(screen.getByTestId('hire-sum-systems')).toHaveTextContent('Shopify');
    expect(screen.getByTestId('hire-sum-rules')).toHaveTextContent(
      'a VIP writesthey sound annoyed (off)',
    );
    // What everyone reads comes with it, and what was switched on.
    expect(screen.getByTestId('hire-sum-knows')).toHaveTextContent('FAQReturns policy');
    expect(screen.getByTestId('hire-sum-skill-names')).toHaveTextContent('Refund a late order');
    expect(screen.getByTestId('hire-sum-skill-names').nextSibling).toHaveTextContent(
      'Each starts in Watch.',
    );
  });

  it.each([
    ['profile', '1'],
    ['limits', '2'],
    ['handover', '2'],
    ['knowledge', '3'],
    ['skills', '3'],
  ])('★ Edit on %s goes back to step %s', async (part, to) => {
    await atSummary();
    await userEvent.click(screen.getByTestId(`hire-edit-${part}`));
    expect(screen.getByTestId('hire-sheet')).toHaveAttribute('data-step', to);
  });

  it('★ what hiring here cannot give it is said, not dropped', async () => {
    await atSummary();
    expect(screen.getByTestId('hire-ungranted')).toHaveTextContent(
      "Riskier ones, like refunds, aren't given to it from here yet",
    );
  });

  it('…and not said when nothing needs it', async () => {
    await atSummary({ choices: { 'shopify.process_refund': 'never' } });
    expect(screen.queryByTestId('hire-ungranted')).toBeNull();
  });

  it('★ what holds the hire, in words, and Hire waits: sales, no knowledge', async () => {
    await atSummary({ job: 'sales' }, { knowledge: [SOURCES[1]!] });
    await userEvent.click(screen.getByTestId('hire-edit-knowledge'));
    await userEvent.click(screen.getByTestId('hire-knows-faq-on'));
    await userEvent.click(screen.getByTestId('hire-continue'));
    expect(screen.getByTestId('hire-block-salesPipeline')).toHaveTextContent(
      'A sales employee needs a sales pipeline',
    );
    expect(screen.getByTestId('hire-block-noKnowledge')).toHaveTextContent(
      'An employee needs at least one knowledge source to be hired.',
    );
    expect(screen.getByTestId('hire-it')).toBeDisabled();
  });

  it('a step-2 choice looser than the business has it is not offered, and says why', () => {
    const askMe: HireTool = { ...TOOLS[0]!, toolName: 'get_order', current: 'ask_me' };
    sheet({ initialStep: 2, tools: [askMe] });
    const doIt = screen.getByTestId('hire-choice-get_order-do_it');
    expect(doIt).toBeDisabled();
    expect(doIt).toHaveAttribute(
      'title',
      'Your business has this set to “Ask me” for everyone. An employee can only be stricter; change it for everyone in Studio · Integrations.',
    );
    expect(screen.getByTestId('hire-choice-get_order-never')).toBeEnabled();
  });
});

describe('★★ H5 - "לגייס": asked first, then created', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hireEmployee.mockReset();
    push.mockClear();
  });

  const REQUEST = {
    goal: 'Take booking requests and answer questions about availability.',
    role: 'booking',
    name: 'Ronnie',
    escalationRules: [{ label: 'they ask for a person', enabled: true }],
    integrationAccess: ['shopify'],
    knowledgeBaseIds: ['faq', 'returns'],
    skillIds: ['s1'],
    levels: [{ toolName: 'send_message', level: 'never' }],
    locale: 'en',
  };
  const PLAN = { skills: ['s1'], choices: { send_message: 'never' } };

  it('★ Hire asks "have you gone over the whole summary?"; No sends nothing and returns to it', async () => {
    await atSummary(PLAN);
    await userEvent.click(screen.getByTestId('hire-it'));
    expect(screen.getByTestId('hire-confirm')).toHaveTextContent(
      'Have you gone over the whole summary of the employee?',
    );
    await userEvent.click(screen.getByTestId('hire-confirm-no'));
    expect(hireEmployee).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hire-confirm')).toBeNull();
    expect(screen.getByTestId('hire-it')).toBeEnabled();
    expect(screen.getByTestId('hire-sheet')).toHaveAttribute('data-step', '4');
  });

  it('★★ Yes hires: the plan, as the routes take it - once', async () => {
    hireEmployee.mockResolvedValue({ ok: true, id: 'e1' });
    await atSummary(PLAN);
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    await waitFor(() => expect(hireEmployee).toHaveBeenCalledTimes(1));
    expect(hireEmployee).toHaveBeenCalledWith(REQUEST, null);
  });

  it('★★ hired: the local hire is cleared and 07e opens for it', async () => {
    hireEmployee.mockResolvedValue({ ok: true, id: 'e1' });
    await atSummary(PLAN);
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        pathname: '/studio/employees',
        query: { employee: 'e1', hired: 'e1' },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('★★ stopped part-way: what was saved, what was not, the draft kept - and Hire again continues it', async () => {
    hireEmployee.mockResolvedValueOnce({
      ok: false,
      id: 'd1',
      saved: ['draft', 'settings', 'name'],
      failed: 'skills',
      reason: 'failed',
      levels: { saved: 0, total: 1 },
    });
    await atSummary(PLAN);
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    const failed = await screen.findByTestId('hire-failed');
    expect(failed).toHaveTextContent(
      'Not hired yet. Something went wrong on our side. Try again in a moment.',
    );
    expect(screen.getByTestId('hire-failed-saved')).toHaveTextContent(
      'the draftits job, handoff conditions, systems and knowledgeits name',
    );
    expect(screen.getByTestId('hire-failed-not-saved')).toHaveTextContent(
      'its skillsits limits on actionsthe hire itself',
    );
    expect(screen.getByTestId('hire-failed-kept')).toHaveTextContent(
      "It's kept as a draft in your list, and a draft doesn't answer customers.",
    );
    expect(push).not.toHaveBeenCalled();
    // The draft's id is kept with the hire, so a reopened sheet continues it too.
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).agentId).toBe('d1'));
    hireEmployee.mockResolvedValueOnce({ ok: true, id: 'd1' });
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    await waitFor(() => expect(hireEmployee).toHaveBeenCalledTimes(2));
    expect(hireEmployee.mock.calls[1]).toEqual([REQUEST, 'd1']);
  });

  it('nothing created: said so, and no draft to continue', async () => {
    hireEmployee.mockResolvedValueOnce({
      ok: false,
      id: null,
      saved: [],
      failed: 'draft',
      reason: 'forbidden',
      levels: { saved: 0, total: 1 },
    });
    await atSummary(PLAN);
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    expect(await screen.findByTestId('hire-failed')).toHaveTextContent(
      "Nothing was created. You don't have permission to hire AI employees.",
    );
    expect(screen.queryByTestId('hire-failed-kept')).toBeNull();
  });

  it('a reopened hire that stopped part-way continues its draft', async () => {
    hireEmployee.mockResolvedValue({ ok: true, id: 'd9' });
    await atSummary(PLAN, {}, { agentId: 'd9' });
    await userEvent.click(screen.getByTestId('hire-it'));
    await userEvent.click(screen.getByTestId('hire-confirm-yes'));
    await waitFor(() => expect(hireEmployee).toHaveBeenCalledWith(REQUEST, 'd9'));
  });
});
