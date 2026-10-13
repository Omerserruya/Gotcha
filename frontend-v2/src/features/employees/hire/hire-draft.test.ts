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
  },
  {
    toolName: 'b.refund',
    label: 'Refund',
    provider: 'shop',
    providerLabel: 'Shop',
    choices: ['ask_me', 'never'],
    current: 'ask_me',
  },
];
const FRESH = emptyPlan(TOOLS, ['shop'], [{ label: 'they ask for a person', enabled: true }]);
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

  it('★ a later step without a job starts at step 1', () => {
    expect(read({ step: 3, plan: { job: null, name: 'Noa' } })!.step).toBe(1);
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
});
