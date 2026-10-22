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
  hireGrants,
  needsFunnel,
  seededGrant,
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
  grant: provider ? { grantable: true, seeded: true } : null,
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
    expect(hireBlocks({ ...ready, job: 'sales' }, SOURCES)).toEqual(['noFunnel']);
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
      disclosesAi: true,
      funnel: null,
      grants: [],
      skillIds: ['s1'],
      levels: [],
      locale: 'he',
    });
    expect(writesOf(request)).toEqual(['draft', 'settings', 'name', 'skills', 'hired']);
  });
});

describe('★★ H8a - what is given to it: the seed’s rule, then the plan', () => {
  it('the seed gives an enabled action that is not high risk; nothing not set up', () => {
    expect(seededGrant({ state: 'enabled', riskLevel: 'LOW' })).toBe(true);
    expect(seededGrant({ state: 'enabled', riskLevel: null })).toBe(true);
    expect(seededGrant({ state: 'enabled', riskLevel: 'HIGH' })).toBe(false);
    expect(seededGrant({ state: 'disabled', riskLevel: 'LOW' })).toBe(false);
    expect(seededGrant({ state: 'not_provisioned', riskLevel: 'LOW' })).toBe(false);
  });

  it('a hire starts as the seed; a built-in has no grant; one not set up starts off', () => {
    const tools: HireTool[] = [
      { ...tool('shop'), toolName: 'shop.a', grant: { grantable: true, seeded: true } },
      { ...tool('shop'), toolName: 'shop.b', grant: { grantable: true, seeded: false } },
      { ...tool('shop'), toolName: 'shop.c', grant: { grantable: false, seeded: true } },
      tool(null),
    ];
    const plan = emptyPlan(tools);
    expect(plan.grants).toEqual({ 'shop.a': true, 'shop.b': false, 'shop.c': false });
    // Sent: every grantable action, given or not; never one not set up, never a built-in.
    expect(hireGrants({ ...plan, grants: { ...plan.grants, 'shop.b': true } }, tools)).toEqual([
      { toolName: 'shop.a', give: true },
      { toolName: 'shop.b', give: true },
    ]);
  });
});

describe('★★ H8c - Sales follows a funnel', () => {
  const sales: HirePlan = { ...emptyPlan([], [], { knowledge: ['all'] }), job: 'sales', name: 'N' };
  const FUNNELS = [{ id: 'f1', name: 'B2b sales' }];
  const TEMPLATES = [
    {
      id: 'saas-default',
      name: 'Software',
      description: 'd',
      stages: [{ id: 'lead', label: 'Lead' }],
    },
  ];

  it('only Sales needs one (the hire offers no sdr or recruiting)', () => {
    expect(needsFunnel('sales')).toBe(true);
    expect(needsFunnel('booking')).toBe(false);
    expect(needsFunnel(null)).toBe(false);
  });

  it('each state its own block: refused, unread, none, not picked; picked holds nothing', () => {
    expect(hireBlocks(sales, SOURCES, 'forbidden')).toEqual(['funnelsForbidden']);
    expect(hireBlocks(sales, SOURCES, 'failed')).toEqual(['funnelsUnread']);
    expect(hireBlocks(sales, SOURCES, [])).toEqual(['noFunnel']);
    expect(hireBlocks(sales, SOURCES, FUNNELS)).toEqual(['pickFunnel']);
    expect(hireBlocks({ ...sales, funnelId: 'gone' }, SOURCES, FUNNELS)).toEqual(['pickFunnel']);
    expect(hireBlocks({ ...sales, funnelId: 'f1' }, SOURCES, FUNNELS)).toEqual([]);
  });

  it('★ the funnel is sent only with Sales, with the role, beside disclosesAi', () => {
    const args = {
      goal: 'g',
      tools: [],
      sources: SOURCES,
      skills: [],
      locale: 'en',
      funnels: FUNNELS,
      templates: TEMPLATES,
    };
    const request = hireRequest({ ...sales, funnelId: 'f1', disclosesAi: false }, args);
    expect(request).toMatchObject({ role: 'sales', funnel: { id: 'f1' }, disclosesAi: false });
    expect(writesOf(request)).not.toContain('funnel');
    expect(hireRequest({ ...sales, job: 'booking', funnelId: 'f1' }, args).funnel).toBeNull();
    // A template: created on the hire's "yes", a write of its own.
    const fromTemplate = hireRequest({ ...sales, funnelTemplate: 'saas-default' }, args);
    expect(fromTemplate.funnel).toEqual({ template: 'saas-default' });
    expect(writesOf(fromTemplate).slice(0, 3)).toEqual(['draft', 'funnel', 'settings']);
  });

  it('★ templates: picked, nothing holds it; with no funnels, each failure said as itself', () => {
    expect(hireBlocks(sales, SOURCES, [], TEMPLATES)).toEqual(['pickFunnel']);
    expect(
      hireBlocks({ ...sales, funnelTemplate: 'saas-default' }, SOURCES, [], TEMPLATES),
    ).toEqual([]);
    expect(hireBlocks({ ...sales, funnelTemplate: 'gone' }, SOURCES, [], TEMPLATES)).toEqual([
      'pickFunnel',
    ]);
    expect(hireBlocks(sales, SOURCES, [], 'failed')).toEqual(['noFunnelTemplatesUnread']);
    expect(hireBlocks(sales, SOURCES, 'failed', 'failed')).toEqual(['funnelsUnread']);
    expect(hireBlocks(sales, SOURCES, [], 'forbidden')).toEqual(['funnelsForbidden']);
    // One read failing leaves the other offered.
    expect(hireBlocks(sales, SOURCES, 'failed', TEMPLATES)).toEqual(['pickFunnel']);
  });
});
