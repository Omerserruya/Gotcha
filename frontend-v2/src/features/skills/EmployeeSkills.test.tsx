import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  skillOneSchema,
  type EmployeeSkills as Assigned,
  type Skill,
  type SkillFit,
} from '@/api/contracts/skills';
import skillsMessages from '@/i18n/messages/en/skills.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ setEmployeeSkills: vi.fn(), setNoSkillPolicy: vi.fn() }));
vi.mock('./skill-actions', () => actions);

import { EmployeeSkills } from './EmployeeSkills';

const row = (skillId: string, over: Partial<Assigned['skills'][number]> = {}) => ({
  skillId,
  mode: 'on' as const,
  order: 0,
  name: skillId.toUpperCase(),
  status: 'active' as const,
  category: 'orders' as const,
  version: 1,
  runs: 10,
  ...over,
});

const assigned: Assigned = {
  aiAgentId: 'a1',
  noSkillPolicy: 'answer_from_knowledge',
  skills: [
    row('size', { order: 0, runs: 120 }),
    row('status', { order: 1 }),
    row('fitting', { order: 2, mode: 'watch' }),
  ],
};

const skill = (id: string, over: Record<string, unknown> = {}): Skill =>
  skillOneSchema.parse({
    data: {
      id,
      name: id,
      situation: null,
      category: 'orders',
      whenToUse: null,
      examples: [],
      exclusions: [],
      steps: [],
      rules: [],
      requiredInfo: [],
      status: 'active',
      version: 1,
      createdAt: null,
      updatedAt: null,
      archivedAt: null,
      stats: {
        skillId: id,
        runs: 0,
        watchRuns: 0,
        aloneShare: null,
        askedYou: 0,
        stopReasons: [],
        usedBy: [{ aiAgentId: 'a2', name: 'Noam', mode: 'on', order: 0 }],
      },
      ...over,
    },
  }).data;

const refusesRefunds: SkillFit = {
  fits: false,
  handsOverAtStep: 5,
  reason: null,
  steps: [
    {
      stepId: 's5',
      tools: [
        {
          name: 'shopify.process_refund',
          allowed: false,
          connected: true,
          reason: 'not_allowed_for_employee',
          provider: 'shopify',
          providerLabel: 'Shopify',
          actionLabel: 'Process refund',
        },
      ],
    },
  ],
};

const show = (
  candidates = [
    { skill: skill('refund'), fit: refusesRefunds },
    { skill: skill('cancel'), fit: null },
  ],
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ skills: skillsMessages }}>
      <EmployeeSkills
        employee={{ id: 'a1', name: 'Shira' }}
        assigned={assigned}
        candidates={candidates}
        situations={new Map([['size', 'Which size should I take']])}
        head={<span>Shira</span>}
        tabs={null}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.setEmployeeSkills.mockReset().mockResolvedValue(assigned);
  actions.setNoSkillPolicy.mockReset().mockResolvedValue(true);
});

const ids = () => screen.getAllByTestId(/^employee-skill-[a-z]+$/).map((el) => el.dataset.testid);

describe('★★ 07g - the skills an employee carries', () => {
  it('in their order, with the situation, runs or "watching", and the mode', () => {
    show();
    expect(ids()).toEqual([
      'employee-skill-size',
      'employee-skill-status',
      'employee-skill-fitting',
    ]);
    expect(screen.getByTestId('employee-skill-size')).toHaveTextContent('Which size should I take');
    expect(screen.getByTestId('employee-skill-size')).toHaveTextContent('120 runs');
    expect(screen.getByTestId('employee-skill-fitting')).toHaveTextContent('watching');
    expect(screen.getByTestId('employee-skill-fitting-watch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('★★ Save sends the WHOLE list in the new order and modes - a missing one would be removed', async () => {
    show();
    expect(screen.getByTestId('employee-skills-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('employee-skill-up-status'));
    fireEvent.click(screen.getByTestId('employee-skill-fitting-off'));
    fireEvent.click(screen.getByTestId('employee-skills-save'));
    await waitFor(() =>
      expect(actions.setEmployeeSkills).toHaveBeenCalledWith('a1', [
        { skillId: 'status', mode: 'on' },
        { skillId: 'size', mode: 'on' },
        { skillId: 'fitting', mode: 'off' },
      ]),
    );
    expect(actions.setNoSkillPolicy).not.toHaveBeenCalled();
    expect(await screen.findByTestId('employee-skills-said')).toHaveAttribute('data-said', 'saved');
  });

  it('★ the fallback is a PATCH, sent only when it changed', async () => {
    show();
    fireEvent.click(screen.getByTestId('employee-no-skill-always_handover'));
    fireEvent.click(screen.getByTestId('employee-skills-save'));
    await waitFor(() =>
      expect(actions.setNoSkillPolicy).toHaveBeenCalledWith('a1', 'always_handover'),
    );
    expect(actions.setEmployeeSkills).not.toHaveBeenCalled();
  });

  it('a failed list write says nothing changed', async () => {
    actions.setEmployeeSkills.mockResolvedValue(null);
    show();
    fireEvent.click(screen.getByTestId('employee-skill-size-watch'));
    fireEvent.click(screen.getByTestId('employee-skills-save'));
    expect(await screen.findByTestId('employee-skills-said')).toHaveAttribute(
      'data-said',
      'failed',
    );
  });
});

describe('★★ Add a skill - checked against this employee before anyone presses Add', () => {
  it('★★ "At step 5, Shira would hand over": from the fit check, with the blocked tool', () => {
    show();
    expect(screen.getByTestId('employee-fit-refund')).toHaveTextContent(
      'At step 5, Shira would hand over: Process refund isn’t allowed for this employee.',
    );
    expect(screen.queryByTestId('employee-fit-cancel')).toBeNull();
    expect(screen.getByTestId('employee-candidate-refund')).toHaveTextContent('Used by Noam');
  });

  it('★ added in Watch, out of the candidates, into the list Save sends', async () => {
    show();
    fireEvent.click(screen.getByTestId('employee-add-cancel'));
    expect(screen.queryByTestId('employee-candidate-cancel')).toBeNull();
    expect(screen.getByTestId('employee-skill-cancel-watch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByTestId('employee-skills-save'));
    await waitFor(() => expect(actions.setEmployeeSkills).toHaveBeenCalled());
    expect(actions.setEmployeeSkills.mock.calls[0]![1]).toContainEqual({
      skillId: 'cancel',
      mode: 'watch',
    });
  });

  it('search narrows by name or situation', () => {
    show();
    fireEvent.change(screen.getByTestId('employee-add-search'), { target: { value: 'canc' } });
    expect(screen.queryByTestId('employee-candidate-refund')).toBeNull();
    expect(screen.getByTestId('employee-candidate-cancel')).toBeInTheDocument();
  });

  it('★ unread candidates are said, not an empty list', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ skills: skillsMessages }}>
        <EmployeeSkills
          employee={{ id: 'a1', name: 'Shira' }}
          assigned={assigned}
          candidates={null}
          situations={new Map()}
          head={null}
          tabs={null}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('employee-add-skill')).toHaveTextContent('couldn’t be read');
  });
});
