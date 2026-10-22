import { describe, expect, it } from 'vitest';

import { readChallenge } from '@/api/contracts/auth-flow';

import { PASSWORD_RULES, resetProblems, rulesMet } from './password-rules';
import { CAPTURED } from '@/api/contracts/recovery-capture';

const errorsOf = (raw: unknown) => {
  const step = readChallenge(raw);
  if (step.kind !== 'prompt') throw new Error(`not a prompt: ${step.kind}`);
  return step.challenge.response_errors;
};

describe('the checklist', () => {
  it('ticks each rule on its own', () => {
    expect([...rulesMet('')]).toEqual([]);
    expect([...rulesMet('a')]).toEqual(['lower']);
    expect([...rulesMet('A')]).toEqual(['upper']);
    expect([...rulesMet('7')]).toEqual(['digit']);
    expect([...rulesMet('!')]).toEqual(['symbol']);
    expect([...rulesMet('Abcdefgh1!xy')].sort()).toEqual([...PASSWORD_RULES].sort());
  });

  it('counts characters as a person does, and a space is not a symbol', () => {
    expect(rulesMet('😀'.repeat(11)).has('length')).toBe(false);
    expect(rulesMet('😀'.repeat(12)).has('length')).toBe(true);
    expect(rulesMet('a b').has('symbol')).toBe(false);
  });

  it('Hebrew letters have no case: they meet neither case rule', () => {
    const met = rulesMet('שלום');
    expect(met.has('upper')).toBe(false);
    expect(met.has('lower')).toBe(false);
  });
});

describe('★ the server’s refusals, as captured on dev', () => {
  it('the one combined rule sentence is "rules"', () => {
    expect(resetProblems(errorsOf(CAPTURED.promptRules))).toEqual([{ kind: 'rules' }]);
  });

  it('a breach is "leaked", whatever its count', () => {
    expect(resetProblems(errorsOf(CAPTURED.promptBreached))).toEqual([{ kind: 'leaked' }]);
    const other = {
      ...CAPTURED.promptBreached,
      response_errors: {
        non_field_errors: [{ string: 'Password exists on 1 online lists.', code: 'invalid' }],
      },
    };
    expect(resetProblems(errorsOf(other))).toEqual([{ kind: 'leaked' }]);
  });

  it('a mismatch is "mismatch"', () => {
    expect(resetProblems(errorsOf(CAPTURED.promptMismatch))).toEqual([{ kind: 'mismatch' }]);
  });

  it('"too weak" is "weak", and zxcvbn’s English advice after it is left out', () => {
    expect(resetProblems(errorsOf(CAPTURED.promptWeak))).toEqual([{ kind: 'weak' }]);
  });

  it('empty fields are one "required", not two', () => {
    expect(resetProblems(errorsOf(CAPTURED.promptEmpty))).toEqual([{ kind: 'required' }]);
  });

  it('★ a sentence we have no words for is shown as the server wrote it, never dropped', () => {
    const raw = {
      ...CAPTURED.prompt,
      response_errors: { non_field_errors: [{ string: 'Something new.', code: 'invalid' }] },
    };
    expect(resetProblems(errorsOf(raw))).toEqual([{ kind: 'said', text: 'Something new.' }]);
  });
});
