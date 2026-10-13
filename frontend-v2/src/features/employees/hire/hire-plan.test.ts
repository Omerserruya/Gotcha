import { describe, expect, it } from 'vitest';

import { employeeKnowledgeSourceSchema } from '../page/knowledge-plan';
import {
  allowedChoices,
  emptyPlan,
  hireBlocks,
  hireKnowledgeIds,
  hireLevels,
  hireRequest,
  knowledgeDefault,
  stepOneDone,
  ungranted,
  withAccess,
  writesOf,
  type HirePlan,
  type HireTool,
} from './hire-plan';

const tool = (provider: string | null): HireTool => ({
  toolName: `${provider ?? 'gotcha'}.x`,
  label: 'X',
  provider,
  providerLabel: provider,
  choices: ['ask_me'],
  current: 'ask_me',
});

describe('★ the plan’s systems start where the server starts a new employee', () => {
  it('every system set up today, with or without actions here; GOTCHA’s own is not a system', () => {
    const plan = emptyPlan([tool(null), tool('shopify')], ['woocommerce', 'custom:t1']);
    expect(plan.access).toEqual(['custom:t1', 'shopify', 'woocommerce']);
  });

  it('one system off and on again, the rest untouched', () => {
    const plan = emptyPlan([tool('shopify')], ['hubspot']);
    const off = withAccess(plan, 'shopify', false);
    expect(off.access).toEqual(['hubspot']);
    expect(withAccess(off, 'shopify', true).access).toEqual(['hubspot', 'shopify']);
    expect(withAccess(plan, 'shopify', true).access).toEqual(['hubspot', 'shopify']);
  });
});

const source = (id: string, over: Record<string, unknown> = {}) =>
  employeeKnowledgeSourceSchema.parse({ id, name: `KB ${id}`, isActive: true, ...over });
const SOURCES = [
  source('all', { scope: 'all' }),
  source('other', { scope: 'agent', scopeAgentId: 'b' }),
  source('off', { scope: 'agent', isActive: false }),
  source('dept', { scope: 'department', scopeDepartmentId: 'd1' }),
];
const t = (
  current: HireTool['current'],
  choices: HireTool['choices'] = ['do_it', 'ask_me', 'never'],
) => ({ ...tool('shop'), toolName: `x.${current}`, current, choices }) as HireTool;

describe('★★ H4 - the knowledge a hire reads, by the page’s rule', () => {
  it('starts as every active source, as the builder’s own seed attaches them', () => {
    expect(knowledgeDefault(SOURCES)).toEqual(['all', 'dept', 'other']);
    expect(knowledgeDefault(null)).toEqual([]);
  });

  it('★ sent: what is switched on and still exists, and every active one its scope reaches anyway', () => {
    const plan = { ...emptyPlan([]), knowledge: ['other', 'gone'] };
    expect(hireKnowledgeIds(plan, SOURCES)).toEqual(['all', 'other']);
    // A source only another agent or a department reads does not reach a hire.
    expect(hireKnowledgeIds({ ...plan, knowledge: [] }, SOURCES)).toEqual(['all']);
  });
});

describe('★★ H5 - limits: the same as the business, or stricter', () => {
  it('a choice looser than today’s is not offered; the ceiling still holds', () => {
    expect(allowedChoices(t('do_it'))).toEqual(['do_it', 'ask_me', 'never']);
    expect(allowedChoices(t('ask_me'))).toEqual(['ask_me', 'never']);
    expect(allowedChoices(t('never'))).toEqual(['never']);
    expect(allowedChoices(t('do_it', ['ask_me', 'never']))).toEqual(['ask_me', 'never']);
  });

  it('one level per action set differently, in the route’s words', () => {
    const tools = [t('do_it'), t('ask_me')];
    const plan = {
      ...emptyPlan(tools),
      choices: { 'x.do_it': 'ask_me', 'x.ask_me': 'ask_me' },
    } as HirePlan;
    expect(hireLevels(plan, tools)).toEqual([{ toolName: 'x.do_it', level: 'ask' }]);
    expect(hireLevels({ ...plan, choices: { 'x.do_it': 'never' } }, tools)).toEqual([
      { toolName: 'x.do_it', level: 'never' },
    ]);
  });

  it('★ what hiring cannot grant: a riskier action left on, on a system it may use', () => {
    const risky = t('ask_me', ['ask_me', 'never']);
    const plan = emptyPlan([risky]);
    expect(ungranted(plan, [risky])).toEqual([risky]);
    expect(ungranted({ ...plan, choices: { [risky.toolName]: 'never' } }, [risky])).toEqual([]);
    expect(ungranted({ ...plan, access: [] }, [risky])).toEqual([]);
    expect(ungranted(plan, [t('do_it')])).toEqual([]);
  });
});

describe('★★ H5 - what holds the hire, and what it sends', () => {
  const ready: HirePlan = {
    ...emptyPlan([], ['shopify'], {
      rules: [{ label: 'vip', enabled: false }],
      knowledge: ['other'],
    }),
    job: 'booking',
    name: ' Ronnie ',
    skills: ['s1', 'gone'],
  };

  it('a name is part of step 1', () => {
    expect(stepOneDone(ready)).toBe(true);
    expect(stepOneDone({ ...ready, name: ' ' })).toBe(false);
  });

  it('each block in words, none when ready', () => {
    expect(hireBlocks(ready, SOURCES)).toEqual([]);
    expect(hireBlocks({ ...ready, job: 'sales' }, SOURCES)).toEqual(['salesPipeline']);
    expect(hireBlocks(ready, null)).toEqual(['knowledgeUnread']);
    expect(hireBlocks({ ...ready, knowledge: [] }, [SOURCES[1]!])).toEqual(['noKnowledge']);
    expect(hireBlocks({ ...ready, rules: [{ label: '', enabled: true }] }, SOURCES)).toEqual([
      'rules',
    ]);
  });

  it('★ the request: each field as its route takes it', () => {
    const request = hireRequest(ready, {
      goal: 'Bookings.',
      tools: [],
      sources: SOURCES,
      skills: [{ id: 's1', name: 'Refunds', situation: null, status: 'active' }],
      locale: 'he',
    });
    expect(request).toEqual({
      goal: 'Bookings.',
      role: 'booking',
      name: 'Ronnie',
      escalationRules: [{ label: 'vip', enabled: false }],
      integrationAccess: ['shopify'],
      knowledgeBaseIds: ['all', 'other'],
      skillIds: ['s1'],
      levels: [],
      locale: 'he',
    });
    expect(writesOf(request)).toEqual(['draft', 'settings', 'name', 'skills', 'hired']);
  });
});
