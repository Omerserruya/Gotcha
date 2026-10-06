import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { skillOneSchema, type Skill, type ToolChoice } from '@/api/contracts/skills';
import skillsMessages from '@/i18n/messages/en/skills.json';

const messages = { skills: skillsMessages };

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));
const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push, replace }),
}));
const actions = vi.hoisted(() => ({
  createSkill: vi.fn(),
  saveSkill: vi.fn(),
  giveSkill: vi.fn(),
  readRuns: vi.fn(),
}));
vi.mock('./skill-actions', () => actions);

import { NewSkill } from './NewSkill';
import { SkillEditor } from './SkillEditor';
import { SkillsLibrary } from './SkillsLibrary';

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

const skill = (over: Record<string, unknown> = {}): Skill =>
  skillOneSchema.parse({
    data: {
      id: 'k1',
      name: 'Exchange a product',
      situation: 'Another size or colour',
      category: 'orders',
      whenToUse: 'Same item, other size',
      examples: [],
      exclusions: [],
      steps: [
        {
          id: 's1',
          kind: 'find',
          title: 'Find the order',
          guidance: '',
          tools: ['shopify.find_order'],
          approvalOverAmount: null,
          elseNote: null,
        },
      ],
      rules: [],
      requiredInfo: [],
      status: 'active',
      version: 2,
      createdAt: null,
      updatedAt: null,
      archivedAt: null,
      stats: {
        skillId: 'k1',
        runs: 64,
        watchRuns: 0,
        aloneShare: 0.91,
        askedYou: 6,
        stopReasons: [],
        usedBy: [{ aiAgentId: 'a1', name: 'Shira', mode: 'on', order: 0 }],
      },
      ...over,
    },
  }).data;

const tool = (name: string, over: Partial<ToolChoice> = {}): ToolChoice => ({
  name,
  displayName: name,
  source: 'integration',
  integrationSlug: 'shopify',
  category: null,
  riskLevel: null,
  connected: true,
  allowedForAgent: null,
  reason: null,
  provider: null,
  providerLabel: null,
  actionLabel: null,
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  push.mockReset();
  replace.mockReset();
});

describe('★★ 09 - the library', () => {
  it('a row: situation, steps and systems, who, this week, standing', async () => {
    wrap(await SkillsLibrary({ skills: [skill()], tools: null, category: null }));
    const row = screen.getByTestId('skill-k1');
    expect(row).toHaveAttribute('href', '/studio/skills/k1');
    expect(row).toHaveTextContent('Another size or colour');
    expect(row).toHaveTextContent('1 step');
    expect(row).toHaveTextContent('Shopify');
    expect(screen.getByTestId('skill-used-by-k1')).toHaveTextContent('SH');
    expect(screen.getByTestId('skill-week-k1')).toHaveTextContent('64 runs91% alone');
    expect(screen.getByTestId('skill-standing-k1')).toHaveTextContent('Live');
  });

  it('★ watch only: its watch runs, and "watching"', async () => {
    const watching = skill({
      stats: {
        ...skill().stats!,
        watchRuns: 18,
        usedBy: [{ aiAgentId: 'a1', name: 'Shira', mode: 'watch', order: 0 }],
      },
    });
    wrap(await SkillsLibrary({ skills: [watching], tools: null, category: null }));
    expect(screen.getByTestId('skill-week-k1')).toHaveTextContent('18 runswatching');
    expect(screen.getByTestId('skill-standing-k1')).toHaveTextContent('Watch only');
  });

  it('★★ unread is said - never an empty library', async () => {
    wrap(await SkillsLibrary({ skills: null, tools: null, category: null }));
    expect(screen.getByTestId('skills-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-empty')).toBeNull();
  });

  it('filters count each category; archived skills are not listed', async () => {
    wrap(
      await SkillsLibrary({
        skills: [
          skill(),
          skill({ id: 'k2', category: 'products' }),
          skill({ id: 'k3', status: 'archived' }),
        ],
        tools: null,
        category: 'products',
      }),
    );
    expect(screen.getByTestId('skills-filter-all')).toHaveTextContent('All · 2');
    expect(screen.getByTestId('skills-filter-orders')).toHaveTextContent('Orders · 1');
    expect(screen.getByTestId('skills-filter-products')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('skill-k1')).toBeNull();
    expect(screen.getByTestId('skill-k2')).toBeInTheDocument();
  });

  it('★ missing skills are drawn and say why they are empty - nothing filled in by us', async () => {
    wrap(await SkillsLibrary({ skills: [], tools: null, category: null }));
    expect(screen.getByTestId('skills-missing')).toHaveTextContent('next phase');
  });
});

const employees = [
  { id: 'a1', name: 'Shira', role: 'sales' },
  { id: 'a2', name: 'Noam', role: 'support' },
];

const fillName = () =>
  fireEvent.change(screen.getByTestId('skill-name'), { target: { value: 'Gift wrapping' } });

describe('★★ 21 - a new skill', () => {
  it('★ the sentence box and the test are drawn, disabled, saying why', () => {
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    expect(screen.getByTestId('new-skill-write-it')).toBeDisabled();
    expect(screen.getByTestId('new-skill-write-it')).toHaveAttribute(
      'title',
      expect.stringContaining('later'),
    );
    expect(screen.getByTestId('new-skill-test')).toBeDisabled();
    expect(screen.getByTestId('new-skill-start-watch')).toBeChecked();
  });

  it('★ nothing is sent until the form holds a skill: the name, said at the field', () => {
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    fireEvent.click(screen.getByTestId('new-skill-save'));
    expect(actions.createSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Give the skill a name.')).toBeInTheDocument();
  });

  it('★★ given to someone: a draft, made active, then each list in the start mode', async () => {
    actions.createSkill.mockResolvedValue({
      ok: true,
      skill: skill({ id: 'n1', status: 'draft' }),
    });
    actions.saveSkill.mockResolvedValue({ ok: true, skill: skill({ id: 'n1' }) });
    actions.giveSkill.mockResolvedValue({
      aiAgentId: 'a1',
      noSkillPolicy: 'answer_from_knowledge',
      skills: [],
    });
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    fillName();
    fireEvent.click(screen.getByTestId('new-skill-give-a1'));
    fireEvent.click(screen.getByTestId('new-skill-start-on'));
    fireEvent.click(screen.getByTestId('new-skill-save'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/studio/skills/n1'));
    expect(actions.createSkill.mock.calls[0]![0]).toMatchObject({ name: 'Gift wrapping' });
    expect(actions.saveSkill).toHaveBeenCalledWith('n1', { status: 'active' });
    expect(actions.giveSkill).toHaveBeenCalledTimes(1);
    expect(actions.giveSkill).toHaveBeenCalledWith('a1', 'n1', 'on');
  });

  it('given to nobody: stays a draft - no activation, no list written', async () => {
    actions.createSkill.mockResolvedValue({
      ok: true,
      skill: skill({ id: 'n1', status: 'draft' }),
    });
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    fillName();
    fireEvent.click(screen.getByTestId('new-skill-save'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/studio/skills/n1'));
    expect(actions.saveSkill).not.toHaveBeenCalled();
    expect(actions.giveSkill).not.toHaveBeenCalled();
  });

  it('★★ started for some and not others: says for whom, and Save becomes "Open" - never a second skill', async () => {
    actions.createSkill.mockResolvedValue({
      ok: true,
      skill: skill({ id: 'n1', status: 'draft' }),
    });
    actions.saveSkill.mockResolvedValue({ ok: true, skill: skill({ id: 'n1' }) });
    actions.giveSkill.mockResolvedValueOnce({ skills: [] }).mockResolvedValueOnce(null);
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    fillName();
    fireEvent.click(screen.getByTestId('new-skill-give-a1'));
    fireEvent.click(screen.getByTestId('new-skill-give-a2'));
    fireEvent.click(screen.getByTestId('new-skill-save'));
    expect(await screen.findByTestId('new-skill-partly')).toHaveTextContent('Noam');
    expect(screen.queryByTestId('new-skill-save')).toBeNull();
    expect(screen.getByTestId('new-skill-open')).toHaveAttribute('href', '/studio/skills/n1');
    expect(push).not.toHaveBeenCalled();
  });

  it('★ Backend’s 422 lands at the field it names', async () => {
    actions.createSkill.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      field: 'steps[0].title',
      error: 'Too long',
    });
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    fillName();
    fireEvent.click(screen.getByTestId('skill-add-step-find'));
    fireEvent.change(screen.getByTestId('skill-step-title-0'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('new-skill-save'));
    expect(await screen.findByText('Too long')).toBeInTheDocument();
  });
});

describe('★★ the form', () => {
  it('a phrase on Enter; steps by kind; moved by keyboard with their ids', () => {
    wrap(<NewSkill employees={[]} tools={[tool('shopify.find_order')]} otherSkills={[]} />);
    const example = screen.getByTestId('skill-example-input');
    fireEvent.change(example, { target: { value: 'Can you wrap it?' } });
    fireEvent.keyDown(example, { key: 'Enter' });
    expect(screen.getByTestId('skill-examples')).toHaveTextContent('Can you wrap it?');

    fireEvent.click(screen.getByTestId('skill-add-step-find'));
    fireEvent.click(screen.getByTestId('skill-add-step-message'));
    fireEvent.change(screen.getByTestId('skill-step-title-0'), { target: { value: 'Find it' } });
    fireEvent.click(screen.getByTestId('skill-step-down-0'));
    expect(screen.getByTestId('skill-step-title-1')).toHaveValue('Find it');
    expect(screen.getByTestId('skill-step-kind-1')).toHaveValue('find');
  });

  it('★★ a tool that is not connected is listed, disabled, with its reason', () => {
    wrap(
      <NewSkill
        employees={[]}
        tools={[
          tool('shopify.find_order'),
          tool('calendar.book', { connected: false, reason: 'no_calendar_connected' }),
        ]}
        otherSkills={[]}
      />,
    );
    fireEvent.click(screen.getByTestId('skill-add-step-find'));
    const options = [...(screen.getByTestId('skill-step-add-tool-0') as HTMLSelectElement).options];
    const blocked = options.find((o) => o.value === 'calendar.book')!;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain('no calendar connected');
    expect(options.find((o) => o.value === 'shopify.find_order')!.disabled).toBe(false);
  });
});

describe('★★ 09b - edit a skill', () => {
  const show = (s = skill()) =>
    wrap(<SkillEditor skill={s} employees={employees} tools={[]} otherSkills={[]} />);

  it('Save waits for a change, then sends every field with the step ids', async () => {
    actions.saveSkill.mockResolvedValue({
      ok: true,
      skill: skill({ version: 3, name: 'Exchange' }),
    });
    show();
    expect(screen.getByTestId('skill-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('skill-name'), { target: { value: 'Exchange' } });
    fireEvent.click(screen.getByTestId('skill-save'));
    expect(await screen.findByTestId('skill-saved')).toHaveTextContent('version 3');
    expect(actions.saveSkill.mock.calls[0]![1]).toMatchObject({
      name: 'Exchange',
      steps: [{ id: 's1', title: 'Find the order' }],
    });
  });

  it('★ the 7-day line is the share alone - never a count we would have to invent', () => {
    show();
    expect(screen.getByTestId('skill-week-stats')).toHaveTextContent(
      'Last 7 days · 64 runs · 91% alone · 6 asked you',
    );
  });

  it('★★ Used by writes the employee’s list: given here, in Watch', async () => {
    actions.giveSkill.mockResolvedValue({
      aiAgentId: 'a2',
      noSkillPolicy: 'answer_from_knowledge',
      skills: [
        {
          skillId: 'k1',
          mode: 'watch',
          order: 0,
          name: '',
          status: 'active',
          category: 'orders',
          version: 2,
          runs: 0,
        },
      ],
    });
    show();
    expect(screen.getByTestId('skill-give-a1')).toBeChecked();
    fireEvent.click(screen.getByTestId('skill-give-a2'));
    await waitFor(() => expect(actions.giveSkill).toHaveBeenCalledWith('a2', 'k1', 'watch'));
    await waitFor(() => expect(screen.getByTestId('skill-give-a2')).toBeChecked());
  });

  it('★ giving a draft makes it active first - a draft runs nowhere', async () => {
    actions.saveSkill.mockResolvedValue({ ok: true, skill: skill() });
    actions.giveSkill.mockResolvedValue({ skills: [{ skillId: 'k1', mode: 'watch' }] });
    show(skill({ status: 'draft' }));
    fireEvent.click(screen.getByTestId('skill-give-a2'));
    await waitFor(() => expect(actions.giveSkill).toHaveBeenCalled());
    expect(actions.saveSkill).toHaveBeenCalledWith('k1', { status: 'active' });
    expect(actions.saveSkill.mock.invocationCallOrder[0]).toBeLessThan(
      actions.giveSkill.mock.invocationCallOrder[0]!,
    );
  });

  it('the run log replaces the test, reads a page, and pages on', async () => {
    actions.readRuns
      .mockResolvedValueOnce({
        runs: [
          {
            id: 'r1',
            conversationId: 'c1',
            aiAgentId: 'a1',
            skillVersion: 2,
            mode: 'on',
            status: 'handed_over',
            currentStepId: null,
            gatheredKeys: [],
            stopReason: 'tool_missing',
            trace: [],
            startedAt: '2026-10-06T09:00:00Z',
            endedAt: null,
          },
        ],
        nextCursor: 'n',
      })
      .mockResolvedValueOnce({ runs: [], nextCursor: null });
    show();
    fireEvent.click(screen.getByTestId('skill-run-log'));
    const run = await screen.findByTestId('skill-run-r1');
    expect(run).toHaveTextContent('Handed over');
    expect(run).toHaveTextContent('Tool missing');
    expect(screen.queryByTestId('skill-test')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-log-more'));
    });
    expect(actions.readRuns).toHaveBeenLastCalledWith('k1', 'n');
  });
});

describe('★★ the dev measurement (c1ddc98)', () => {
  it('21: one description - the visible subtitle - not a second, unstyled copy', () => {
    wrap(<NewSkill employees={employees} tools={[]} otherSkills={[]} />);
    const dialog = screen.getByTestId('new-skill');
    expect(dialog).toHaveAttribute('aria-describedby', 'new-skill-subtitle');
    expect(
      screen.getAllByText('Describe what the employee should do. GOTCHA writes the steps'),
    ).toHaveLength(1);
  });

  it('★ 09b: the header badge is the status, the threshold stays on its step', () => {
    const asks = skill({
      steps: [
        {
          id: 's1',
          kind: 'change',
          title: 'Refund',
          guidance: '',
          tools: [],
          approvalOverAmount: 200,
          elseNote: null,
        },
      ],
    });
    wrap(<SkillEditor skill={asks} employees={employees} tools={[]} otherSkills={[]} />);
    expect(screen.getByTestId('skill-standing')).toHaveTextContent('Live');
    expect(screen.getByTestId('skill-step-amount-0')).toHaveValue('200');
  });

  it('09b: Used by says the employee’s line, and a small Watching tag', () => {
    const watched = skill({
      stats: {
        ...skill().stats!,
        usedBy: [{ aiAgentId: 'a1', name: 'Shira', mode: 'watch', order: 0 }],
      },
    });
    wrap(
      <SkillEditor
        skill={watched}
        employees={[{ id: 'a1', name: 'Shira', role: 'Sales and product advice' }]}
        tools={[]}
        otherSkills={[]}
      />,
    );
    const used = screen.getByTestId('skill-used-by');
    expect(used).toHaveTextContent('Sales and product advice');
    expect(used).toHaveTextContent('Watching');
  });

  it('09: a skill that never ran says so, not "-"', async () => {
    wrap(
      await SkillsLibrary({
        skills: [skill({ stats: { ...skill().stats!, runs: 0, aloneShare: null } })],
        tools: null,
        category: null,
      }),
    );
    expect(screen.getByTestId('skill-week-k1')).toHaveTextContent('0 runsNot run yet');
  });
});

describe('★ the step’s threshold: a chip when set, a link when not (dev)', () => {
  it('no threshold: a small link that opens the field', () => {
    wrap(<NewSkill employees={[]} tools={[]} otherSkills={[]} />);
    fireEvent.click(screen.getByTestId('skill-add-step-change'));
    expect(screen.queryByTestId('skill-step-amount-0')).toBeNull();
    fireEvent.click(screen.getByTestId('skill-step-add-amount-0'));
    fireEvent.change(screen.getByTestId('skill-step-amount-0'), { target: { value: '500' } });
    expect(screen.getByTestId('skill-step-amount-0')).toHaveValue('500');
  });

  it('★ "Start it" is a titled group inside its card, not a legend on the border', () => {
    wrap(<NewSkill employees={[]} tools={[]} otherSkills={[]} />);
    const group = screen.getByTestId('new-skill-start');
    expect(group.tagName).not.toBe('FIELDSET');
    expect(group).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByRole('radiogroup', { name: 'Start it' })).toBe(group);
  });
});
