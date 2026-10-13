import { describe, expect, it } from 'vitest';

import { readDraft } from './hire-draft';
import type { HireTool } from './hire-plan';

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
const read = (value: unknown) =>
  readDraft(typeof value === 'string' ? value : JSON.stringify(value), TOOLS, ['shop']);

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

  it('an unknown job is none; unknown handover chips are dropped', () => {
    const draft = read({ step: 1, plan: { job: 'pirate', name: 'Noa', handover: ['vip', 'x'] } });
    expect(draft!.plan.job).toBeNull();
    expect(draft!.plan.handover).toEqual(['vip']);
  });

  it('★ nothing entered, broken JSON, or no plan: no draft', () => {
    expect(read({ step: 1, plan: {} })).toBeNull();
    expect(read('{not json')).toBeNull();
    expect(read({ step: 1 })).toBeNull();
    expect(readDraft(null, TOOLS, [])).toBeNull();
  });
});
