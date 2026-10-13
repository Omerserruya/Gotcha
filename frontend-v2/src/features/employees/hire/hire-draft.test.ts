import { describe, expect, it } from 'vitest';

import { readDraft } from './hire-draft';
import { emptyPlan, type HireTool } from './hire-plan';

/** H6: a stored hire, read back against today's actions - never trusted as written. */
const TOOLS: HireTool[] = [
  {
    toolName: 'a.get',
    label: 'Get',
    provider: null,
    providerLabel: null,
    choices: ['do_it', 'ask_me', 'never'],
    current: 'do_it',
    grant: null,
  },
  {
    toolName: 'b.refund',
    label: 'Refund',
    provider: 'shop',
    providerLabel: 'Shop',
    choices: ['ask_me', 'never'],
    current: 'ask_me',
    grant: { grantable: true, seeded: false },
  },
];
const FRESH = emptyPlan(TOOLS, ['shop'], {
  rules: [{ label: 'they ask for a person', enabled: true }],
  knowledge: ['k1'],
});
const read = (value: unknown) =>
  readDraft(typeof value === 'string' ? value : JSON.stringify(value), TOOLS, FRESH);

describe('★★ a stored hire is made safe before it is used', () => {
  it('a choice no longer allowed falls back; an action no longer offered is dropped', () => {
    const draft = read({
      step: 2,
      plan: {
        job: 'sales',
        name: 'Noa',
        choices: { 'a.get': 'never', 'b.refund': 'do_it', gone: 'do_it' },
      },
    });
    expect(draft!.plan.choices).toEqual({ 'a.get': 'never', 'b.refund': 'ask_me' });
    expect(draft!.step).toBe(2);
  });

  it('★ a later step without a job, or without a name, starts at step 1', () => {
    expect(read({ step: 3, plan: { job: null, name: 'Noa' } })!.step).toBe(1);
    expect(read({ step: 4, plan: { job: 'booking', name: ' ' } })!.step).toBe(1);
    expect(read({ step: 4, plan: { job: 'booking', name: 'Noa' } })!.step).toBe(4);
  });

  it('★ H5: a choice looser than the business has it falls back - the employee can only be stricter', () => {
    const tools: HireTool[] = [{ ...TOOLS[0]!, current: 'ask_me' }];
    const fresh = emptyPlan(tools, []);
    const draft = readDraft(
      JSON.stringify({ step: 2, plan: { job: 'sales', name: 'N', choices: { 'a.get': 'do_it' } } }),
      tools,
      fresh,
    );
    expect(draft!.plan.choices).toEqual({ 'a.get': 'ask_me' });
  });

  it('★ H4/H5: knowledge, skills and a stopped hire’s draft id are read back', () => {
    const draft = read({
      step: 4,
      plan: { job: 'booking', name: 'N', knowledge: ['k2', 3], skills: ['s1', 's1', 's2'] },
      agentId: 'd1',
    });
    expect(draft!.plan.knowledge).toEqual(['k2']);
    expect(draft!.plan.skills).toEqual(['s1', 's2']);
    expect(draft!.agentId).toBe('d1');
    expect(read({ step: 1, plan: { name: 'N' }, agentId: 7 })!.agentId).toBeUndefined();
    // Not stored: where a hire starts.
    expect(read({ step: 1, plan: { name: 'N' } })!.plan.knowledge).toEqual(['k1']);
  });

  it('an unknown job is none', () => {
    const draft = read({ step: 1, plan: { job: 'pirate', name: 'Noa' } });
    expect(draft!.plan.job).toBeNull();
  });

  it('★ H3: the conditions are read back each made safe - words cut at 300, a switch, at most 50', () => {
    const draft = read({
      step: 2,
      plan: {
        job: 'sales',
        rules: [
          { label: 'a VIP writes', enabled: false },
          { label: 'x'.repeat(400) },
          { enabled: true },
          'not a rule',
        ],
      },
    });
    expect(draft!.plan.rules).toEqual([
      { label: 'a VIP writes', enabled: false },
      { label: 'x'.repeat(300), enabled: true },
    ]);
    const many = read({
      step: 2,
      plan: { job: 'sales', rules: Array.from({ length: 60 }, (_, i) => ({ label: `r${i}` })) },
    });
    expect(many!.plan.rules).toHaveLength(50);
  });

  it('a draft from before H3 (chip keys, no conditions) starts from today’s conditions', () => {
    const draft = read({ step: 2, plan: { job: 'sales', handover: ['vip'] } });
    expect(draft!.plan.rules).toEqual(FRESH.rules);
  });

  it('★ nothing entered, broken JSON, or no plan: no draft', () => {
    expect(read({ step: 1, plan: {} })).toBeNull();
    expect(read('{not json')).toBeNull();
    expect(read({ step: 1 })).toBeNull();
    expect(readDraft(null, TOOLS, FRESH)).toBeNull();
  });

  it('★ H8: grants kept only for actions still grantable; disclosesAi and the funnel read back', () => {
    const draft = read({
      step: 2,
      plan: {
        job: 'sales',
        name: 'N',
        grants: { 'b.refund': true, 'a.get': true, gone: true },
        disclosesAi: false,
        funnelId: 'f1',
      },
    });
    expect(draft!.plan.grants).toEqual({ 'b.refund': true });
    expect(draft!.plan.disclosesAi).toBe(false);
    expect(draft!.plan.funnelId).toBe('f1');
    // One the workspace no longer has set up starts off, whatever was kept.
    const unset: HireTool[] = [{ ...TOOLS[1]!, grant: { grantable: false, seeded: false } }];
    const kept = readDraft(
      JSON.stringify({
        step: 2,
        plan: { job: 'booking', name: 'N', grants: { 'b.refund': true } },
      }),
      unset,
      emptyPlan(unset, []),
    );
    expect(kept!.plan.grants).toEqual({ 'b.refund': false });
    const plain = read({ step: 1, plan: { name: 'N', grants: { 'b.refund': 'yes' } } });
    expect(plain!.plan.grants).toEqual({ 'b.refund': false });
    expect(plain!.plan.disclosesAi).toBe(true);
    expect(plain!.plan.funnelId).toBeNull();
    expect(plain!.plan.funnelTemplate).toBeNull();
    const template = read({
      step: 1,
      plan: { job: 'sales', name: 'N', funnelTemplate: 'saas-default' },
    });
    expect(template!.plan.funnelTemplate).toBe('saas-default');
  });
});
