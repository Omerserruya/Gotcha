import { describe, expect, it } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';

import { changesIn, draftOf, editPatch } from './edit-plan';

/** As the list route sends it: the stored objects carry more than 07 draws. */
const employee = () =>
  employeeSchema.parse({
    id: 'a',
    name: 'Maya',
    tone: 'friendly',
    languages: { english: true, hebrew: false, klingon: true },
    identity: {
      role: 'Support',
      responsibility: 'After-sale questions',
      representationGuidelines: ['x'],
    },
    escalationRules: [
      { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: true },
      { label: 'Order over 1000', type: 'amount', value: 1000, enabled: false },
    ],
  });

describe('★ 07f - the draft starts as stored; nothing is a change until it differs', () => {
  it('an untouched draft has no changes and an empty patch', () => {
    const e = employee();
    expect(changesIn(e, draftOf(e))).toEqual([]);
    expect(editPatch(e, draftOf(e))).toEqual({});
  });

  it('whitespace around the responsibility is not a change', () => {
    const e = employee();
    expect(changesIn(e, { ...draftOf(e), responsibility: '  After-sale questions ' })).toEqual([]);
  });

  it('counts each field once, in the sheet’s order', () => {
    const e = employee();
    const d = draftOf(e);
    expect(
      changesIn(e, {
        responsibility: 'Everything',
        tone: 'formal',
        languages: { ...d.languages, hebrew: true },
        handover: [false, false],
      }),
    ).toEqual(['responsibility', 'tone', 'languages', 'handover']);
  });
});

describe('★★ the patch never drops what 07 does not draw - PATCH replaces whole objects', () => {
  it('identity keeps its role and guidelines', () => {
    const e = employee();
    expect(editPatch(e, { ...draftOf(e), responsibility: ' Everything ' })).toEqual({
      identity: { role: 'Support', responsibility: 'Everything', representationGuidelines: ['x'] },
    });
  });

  it('each rule keeps its type and value; only `enabled` follows the box', () => {
    const e = employee();
    expect(editPatch(e, { ...draftOf(e), handover: [false, true] })).toEqual({
      escalationRules: [
        { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: false },
        { label: 'Order over 1000', type: 'amount', value: 1000, enabled: true },
      ],
    });
  });

  it('a language the sheet does not draw keeps its stored value', () => {
    const e = employee();
    const d = draftOf(e);
    expect(editPatch(e, { ...d, languages: { ...d.languages, arabic: true } })).toEqual({
      languages: { english: true, hebrew: false, arabic: true, klingon: true },
    });
  });

  it('only the changed field is sent', () => {
    const e = employee();
    expect(Object.keys(editPatch(e, { ...draftOf(e), tone: 'formal' }))).toEqual(['tone']);
  });
});
