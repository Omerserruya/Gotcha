import { describe, expect, it } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';

import { changesIn, draftOf, editPatch, MAX_RULES, newRule, rulesProblem } from './profile-plan';

/** As the list route sends it: the stored objects carry more than the page draws. */
const employee = (over: Record<string, unknown> = {}) =>
  employeeSchema.parse({
    id: 'a',
    name: 'Maya',
    tone: 'friendly',
    languages: { english: true, hebrew: false },
    identity: {
      role: 'Support',
      responsibility: 'After-sale questions',
      representationGuidelines: ['x'],
    },
    persona: { gender: 'neutral' },
    escalationRules: [
      { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: true },
      { label: 'Order over 1000', type: 'amount', value: 1000, enabled: false },
    ],
    ...over,
  });

describe('★ the draft starts as stored; nothing is a change until it differs', () => {
  it('an untouched draft has no changes and an empty patch', () => {
    const e = employee();
    expect(changesIn(e, draftOf(e))).toEqual([]);
    expect(editPatch(e, draftOf(e))).toEqual({});
  });

  it('whitespace around the responsibility, or a rule’s words, is not a change', () => {
    const e = employee();
    const d = draftOf(e);
    expect(changesIn(e, { ...d, responsibility: '  After-sale questions ' })).toEqual([]);
    expect(
      changesIn(e, { ...d, rules: d.rules.map((r) => ({ ...r, label: ` ${r.label} ` })) }),
    ).toEqual([]);
  });

  it('counts each field once, in the page’s order', () => {
    const e = employee();
    const d = draftOf(e);
    expect(
      changesIn(e, {
        responsibility: 'Everything',
        tone: 'formal',
        disclosesAi: false,
        rules: [],
        access: null,
      }),
    ).toEqual(['responsibility', 'tone', 'disclosesAi', 'handover']);
    expect(d.disclosesAi).toBe(true);
  });

  it('★ the systems it may use: the WHOLE list when it changed, nothing when it did not or was unread', () => {
    const e = employee();
    const stored = ['shopify', 'woocommerce'];
    expect(changesIn(e, draftOf(e, ['woocommerce', 'shopify']), stored)).toEqual([]);
    const off = { ...draftOf(e, stored), access: ['woocommerce'] };
    expect(changesIn(e, off, stored)).toEqual(['access']);
    expect(editPatch(e, { ...off, access: ['woocommerce', 'hubspot'] }, stored)).toEqual({
      integrationAccess: ['hubspot', 'woocommerce'],
    });
    expect(changesIn(e, { ...off, access: null }, stored)).toEqual([]);
    expect(changesIn(e, off, null)).toEqual([]);
  });
});

describe('★★ "Says it’s AI when asked" (Backend 28a9c3b6): absent means it does', () => {
  it('absent, a persona without it, or true: on; only false is off', () => {
    expect(draftOf(employee({ persona: undefined })).disclosesAi).toBe(true);
    expect(draftOf(employee()).disclosesAi).toBe(true);
    expect(draftOf(employee({ persona: { disclosesAi: true } })).disclosesAi).toBe(true);
    expect(draftOf(employee({ persona: { disclosesAi: false } })).disclosesAi).toBe(false);
  });

  it('switched, it is sent as the route’s own boolean - never the persona', () => {
    const e = employee();
    expect(editPatch(e, { ...draftOf(e), disclosesAi: false })).toEqual({ disclosesAi: false });
    const off = employee({ persona: { disclosesAi: false } });
    expect(editPatch(off, { ...draftOf(off), disclosesAi: true })).toEqual({ disclosesAi: true });
  });
});

describe('★★ the handoff conditions are sent as the WHOLE array', () => {
  it('a switched rule: every rule, each keeping its type and value', () => {
    const e = employee();
    const d = draftOf(e);
    expect(
      editPatch(e, {
        ...d,
        rules: d.rules.map((r, i) => (i === 0 ? { ...r, enabled: false } : r)),
      }),
    ).toEqual({
      escalationRules: [
        { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: false },
        { label: 'Order over 1000', type: 'amount', value: 1000, enabled: false },
      ],
    });
  });

  it('added, reworded (trimmed), removed', () => {
    const e = employee();
    const d = draftOf(e);
    const rules = [
      { ...d.rules[1]!, label: '  Order over 2000 ' },
      { ...newRule(), label: 'Wholesale pricing' },
    ];
    expect(editPatch(e, { ...d, rules })).toEqual({
      escalationRules: [
        { label: 'Order over 2000', type: 'amount', value: 1000, enabled: false },
        { label: 'Wholesale pricing', enabled: true },
      ],
    });
  });

  it('removing the last one sends an empty array, not nothing', () => {
    const e = employee();
    expect(editPatch(e, { ...draftOf(e), rules: [] })).toEqual({ escalationRules: [] });
  });

  it('a rule with no words, or more than the route keeps, cannot be saved', () => {
    expect(rulesProblem([{ ...newRule() }])).toBe('empty');
    expect(rulesProblem([{ label: '  ', enabled: true }])).toBe('empty');
    expect(
      rulesProblem(Array.from({ length: MAX_RULES + 1 }, () => ({ label: 'x', enabled: true }))),
    ).toBe('tooMany');
    expect(rulesProblem([{ label: 'x', enabled: false }])).toBeNull();
  });
});

describe('★ nothing writes what the page does not edit', () => {
  it('identity keeps its role and guidelines', () => {
    const e = employee();
    expect(editPatch(e, { ...draftOf(e), responsibility: ' Everything ' })).toEqual({
      identity: { role: 'Support', responsibility: 'Everything', representationGuidelines: ['x'] },
    });
  });

  it('★ no languages and no sign-off: the draft holds neither, so no patch can carry them', () => {
    const e = employee();
    const d = draftOf(e);
    expect(Object.keys(d).sort()).toEqual([
      'access',
      'disclosesAi',
      'responsibility',
      'rules',
      'tone',
    ]);
    const all = editPatch(
      e,
      { responsibility: 'x', tone: 'formal', disclosesAi: false, rules: [], access: ['a'] },
      [],
    );
    expect(Object.keys(all).sort()).toEqual([
      'disclosesAi',
      'escalationRules',
      'identity',
      'integrationAccess',
      'tone',
    ]);
  });
});
