import { describe, expect, it } from 'vitest';

import {
  skillOneSchema,
  skillStanding,
  skillsListSchema,
  type Skill,
  type ToolChoice,
} from '@/api/contracts/skills';

import { blankDraft, bodyOf, draftOf, draftProblems, moveStep, newStep } from './skill-draft';
import { avatarTone, employeeInitials, skillSystems } from './skill-words';
import { toolLabel } from './ToolChip';

const skill = (over: Record<string, unknown> = {}): Skill =>
  skillOneSchema.parse({
    data: {
      id: 'k1',
      name: 'Exchange a product',
      situation: 'Another size or colour',
      category: 'orders',
      whenToUse: 'Same item, different size',
      examples: ['It’s too small'],
      exclusions: [{ text: 'Damaged items', skillId: 'k2' }],
      steps: [
        {
          id: 's1',
          kind: 'find',
          title: 'Find the order',
          guidance: 'By phone',
          tools: ['shopify.find_order'],
          approvalOverAmount: null,
          elseNote: null,
        },
        {
          id: 's2',
          kind: 'change',
          title: 'Make the exchange',
          guidance: '',
          tools: ['shopify.create_exchange'],
          approvalOverAmount: 500,
          elseNote: null,
        },
      ],
      rules: [{ type: 'never', text: 'Offer a cash refund' }],
      requiredInfo: [{ key: 'order_number', label: 'Order', priority: 1 }],
      status: 'active',
      version: 3,
      createdAt: null,
      updatedAt: null,
      archivedAt: null,
      stats: null,
      ...over,
    },
  }).data;

const used = (...modes: ('on' | 'watch' | 'off')[]) => ({
  skillId: 'k1',
  runs: 0,
  watchRuns: 0,
  aloneShare: null,
  askedYou: 0,
  stopReasons: [],
  usedBy: modes.map((mode, i) => ({ aiAgentId: `a${i}`, name: `A${i}`, mode, order: i })),
});

describe('★★ skillStanding - 09’s last column', () => {
  it('★ a draft is "Draft" whoever carries it: a draft runs nowhere (Backend)', () => {
    expect(skillStanding(skill({ status: 'draft', stats: used('on') }))).toEqual({ kind: 'draft' });
  });

  it('the highest approval threshold wins over Live', () => {
    expect(skillStanding(skill({ stats: used('on') }))).toEqual({ kind: 'approval', amount: 500 });
  });

  it('Live with someone On; Watch only with only watchers; unused with nobody', () => {
    const plain = { steps: [] as Skill['steps'] };
    expect(skillStanding(skill({ ...plain, stats: used('watch', 'on') }))).toEqual({
      kind: 'live',
    });
    expect(skillStanding(skill({ ...plain, stats: used('watch') }))).toEqual({ kind: 'watch' });
    expect(skillStanding(skill({ ...plain, stats: used('off') }))).toEqual({ kind: 'unused' });
    expect(skillStanding(skill({ ...plain, stats: null }))).toEqual({ kind: 'unused' });
  });
});

describe('★★ strict envelopes - an undeployed route is unread, never "no skills"', () => {
  it.each([['<!doctype html>'], [{ error: 'Not found' }], [[]]])('%o is a failed parse', (body) => {
    expect(skillsListSchema.safeParse(body).success).toBe(false);
  });

  it('an unknown step kind fails the skill - it is not quietly another kind', () => {
    expect(() =>
      skill({
        steps: [
          {
            id: 's',
            kind: 'teleport' as never,
            title: 'x',
            guidance: '',
            tools: [],
            approvalOverAmount: null,
            elseNote: null,
            toolDetails: [],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('★★ the draft round trip keeps every step id (Backend: a run keeps its place by it)', () => {
  it('draftOf → bodyOf is the skill’s own fields, ids included', () => {
    const body = bodyOf(draftOf(skill()));
    expect(body.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(body.steps[1]).toMatchObject({ approvalOverAmount: 500, elseNote: null });
    expect(body.exclusions).toEqual([{ text: 'Damaged items', skillId: 'k2' }]);
    expect(body.requiredInfo).toEqual([{ key: 'order_number', label: 'Order', priority: 1 }]);
  });

  it('★ a move keeps ids with their steps', () => {
    const moved = moveStep(draftOf(skill()).steps, 1, 0);
    expect(moved.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(moved[0]!.title).toBe('Make the exchange');
  });

  it('empty optional text is null, not ""; a blank example or rule is dropped', () => {
    const body = bodyOf({
      ...blankDraft(),
      name: ' Gift wrap ',
      examples: ['  ', 'wrap it'],
      rules: [{ type: 'handover', text: ' ' }],
    });
    expect(body).toMatchObject({
      name: 'Gift wrap',
      situation: null,
      whenToUse: null,
      examples: ['wrap it'],
      rules: [],
    });
  });
});

describe('draftProblems - at Backend’s own field paths', () => {
  it('a name, a title per step, an amount in numbers', () => {
    const steps = [
      newStep('find', 'x'),
      { ...newStep('change', 'y'), title: 'Change', approvalOver: 'lots' },
    ];
    expect(draftProblems({ ...blankDraft(), steps })).toEqual([
      { field: 'name', code: 'name_required' },
      { field: 'steps[0].title', code: 'step_title_required' },
      { field: 'steps[1].approvalOverAmount', code: 'amount_invalid' },
    ]);
  });

  it('Backend’s limits: 20 steps', () => {
    const steps = Array.from({ length: 21 }, (_, i) => ({
      ...newStep('check', `s${i}`),
      title: 't',
    }));
    expect(draftProblems({ ...blankDraft(), name: 'n', steps })).toContainEqual({
      field: 'steps',
      code: 'too_many_steps',
    });
  });
});

describe('skillSystems - 09’s chips', () => {
  const tools = new Map<string, ToolChoice>([
    [
      'shopify.find_order',
      {
        name: 'shopify.find_order',
        displayName: 'Find order',
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
      },
    ],
    [
      'knowledge.search',
      {
        name: 'knowledge.search',
        displayName: 'Knowledge',
        source: 'system',
        integrationSlug: null,
        category: null,
        riskLevel: null,
        connected: true,
        allowedForAgent: null,
        reason: null,
        provider: null,
        providerLabel: null,
        actionLabel: null,
      },
    ],
  ]);

  it('an integration once, by its integration; a system tool by its name; unknown by its prefix', () => {
    const s = skill({
      steps: [
        {
          id: 'a',
          kind: 'find',
          title: 'a',
          guidance: '',
          tools: ['shopify.find_order', 'knowledge.search'],
          approvalOverAmount: null,
          elseNote: null,
        },
        {
          id: 'b',
          kind: 'find',
          title: 'b',
          guidance: '',
          tools: ['shopify.find_order', 'courier.track'],
          approvalOverAmount: null,
          elseNote: null,
        },
      ],
    });
    const labels = (x: ReturnType<typeof skillSystems>) => x.map((y) => y.label);
    expect(labels(skillSystems(s, tools))).toEqual(['Shopify', 'Knowledge', 'Courier']);
    expect(labels(skillSystems(s, null))).toEqual(['Shopify', 'Knowledge', 'Courier']);
    // The mark comes from the integration's slug; GOTCHA's own tool has none.
    expect(skillSystems(s, tools).map((y) => y.slug)).toEqual(['shopify', null, 'courier']);
  });

  it('★ a brand is spelled as the brand: WooCommerce, never Woocommerce (dev)', () => {
    const woo = new Map<string, ToolChoice>([
      [
        'woocommerce.get_order',
        {
          name: 'woocommerce.get_order',
          displayName: 'Get Order',
          source: 'integration',
          integrationSlug: 'woocommerce',
          category: null,
          riskLevel: null,
          connected: true,
          allowedForAgent: null,
          reason: null,
          provider: null,
          providerLabel: null,
          actionLabel: null,
        },
      ],
    ]);
    const s = skill({
      steps: [
        {
          id: 'a',
          kind: 'find',
          title: 'a',
          guidance: '',
          tools: ['woocommerce.get_order'],
          approvalOverAmount: null,
          elseNote: null,
        },
      ],
    });
    expect(skillSystems(s, woo)[0]!.label).toBe('WooCommerce');
    expect(toolLabel('woocommerce.get_order', woo)).toEqual({
      provider: 'WooCommerce',
      action: 'Get order',
      slug: 'woocommerce',
    });
  });
});

describe('avatars', () => {
  it('two letters, and a stable tone', () => {
    expect(employeeInitials('Shira')).toBe('SH');
    expect(employeeInitials('Noa Cohen')).toBe('NC');
    expect(avatarTone('a1')).toBe(avatarTone('a1'));
  });
});

describe('★★ Backend’s labels win (ab173090) - one source, no hand mapping', () => {
  it('the step’s own toolDetails: "WooCommerce · Get order", its slug for the mark', () => {
    expect(
      toolLabel('woocommerce.get_order', null, {
        provider: 'woocommerce',
        providerLabel: 'WooCommerce',
        actionLabel: 'Get order',
      }),
    ).toEqual({ provider: 'WooCommerce', action: 'Get order', slug: 'woocommerce' });
  });

  it('GOTCHA’s own tool: the action alone, in the reader’s language', () => {
    expect(
      toolLabel('escalate_to_human', null, {
        provider: null,
        providerLabel: null,
        actionLabel: 'העברה לנציג אנושי',
      }),
    ).toEqual({ provider: null, action: 'העברה לנציג אנושי', slug: null });
  });

  it('then the tool list’s labels, before any guess', () => {
    const tools = new Map<string, ToolChoice>([
      [
        'shopify.get_order',
        {
          name: 'shopify.get_order',
          displayName: 'GET ORDER',
          source: 'integration',
          integrationSlug: 'shopify',
          category: null,
          riskLevel: null,
          connected: true,
          allowedForAgent: null,
          reason: null,
          provider: 'shopify',
          providerLabel: 'Shopify',
          actionLabel: 'Get order',
        },
      ],
    ]);
    expect(toolLabel('shopify.get_order', tools)).toEqual({
      provider: 'Shopify',
      action: 'Get order',
      slug: 'shopify',
    });
  });
});

describe('★ 09’s column, in the 09b header’s order (dev)', () => {
  it('★★ watched by everyone: "Watch only", even with a threshold on a step', () => {
    expect(skillStanding(skill({ stats: used('watch') }))).toEqual({ kind: 'watch' });
  });
});
