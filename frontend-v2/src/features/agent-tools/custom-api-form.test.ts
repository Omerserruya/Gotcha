import { describe, expect, it } from 'vitest';

import { checkDraft, draftOf, type CustomApiDraft } from './custom-api-form';
import { customTool } from './fixtures';

const fresh = (over: Partial<CustomApiDraft> = {}): CustomApiDraft => ({
  ...draftOf(null),
  name: 'Look up order',
  description: 'Finds an order.',
  whenToUse: 'When asked about an order.',
  urlTemplate: 'https://api.example.com/orders/{{id}}',
  allowedHosts: 'api.example.com',
  ...over,
});

const problemsOf = (draft: CustomApiDraft, isNew = true, hasSecrets = false) => {
  const checked = checkDraft(draft, { isNew, hasSecrets });
  return checked.ok ? [] : checked.problems;
};

describe('★★ the custom API builder sends only what the route accepts', () => {
  it('a complete new draft becomes the body, its slug from the name', () => {
    const checked = checkDraft(fresh(), { isNew: true, hasSecrets: false });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.input).toMatchObject({
      slug: 'look_up_order',
      allowedHosts: ['api.example.com'],
      authKind: 'none',
      secrets: {},
      parameters: { type: 'object', properties: {}, required: [] },
      timeoutMs: 10000,
    });
  });

  it.each([
    ['name', { name: ' ' }],
    ['description', { description: '' }],
    ['whenToUse', { whenToUse: '' }],
    ['urlTemplate', { urlTemplate: 'api.example.com/orders' }],
    ['allowedHosts', { allowedHosts: ' , ' }],
    ['hostNotAllowed', { allowedHosts: 'other.example.com' }],
    ['parameters', { parameters: '[1,2]' }],
    ['parameters', { parameters: '{nope' }],
    ['timeout', { timeoutMs: '500' }],
    ['authName', { authKind: 'api_key' as const, apiKey: 'k', authName: '' }],
  ])('%s is caught before the request', (problem, over) => {
    expect(problemsOf(fresh(over))).toContain(problem);
  });

  it('★ a new tool needs its secret; an edit keeps the stored one when left empty', () => {
    expect(problemsOf(fresh({ authKind: 'bearer' }))).toContain('secret');
    const edit = draftOf(customTool());
    expect(edit.bearer).toBe('');
    const checked = checkDraft(edit, { isNew: false, hasSecrets: true });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.input.secrets).toEqual({ bearer: '' });
  });

  it('an edit carries the stored slug, never one made from a new name', () => {
    const checked = checkDraft({ ...draftOf(customTool()), name: 'Renamed' }, { isNew: false, hasSecrets: true });
    expect(checked.ok && checked.input.slug).toBe('lookup_order');
  });

  it('headers with no name or no value are dropped; output paths are split', () => {
    const checked = checkDraft(
      fresh({
        headers: [
          { key: 'X-A', value: '1' },
          { key: ' ', value: '2' },
          { key: 'X-B', value: '' },
        ],
        responseFields: 'data.id, , data.status',
      }),
      { isNew: true, hasSecrets: false },
    );
    expect(checked.ok && checked.input.headers).toEqual({ 'X-A': '1' });
    expect(checked.ok && checked.input.responseFields).toEqual(['data.id', 'data.status']);
  });

  it('an existing tool opens with what it has: its input schema as text, hosts as one line', () => {
    const draft = draftOf(customTool());
    expect(JSON.parse(draft.parameters)).toEqual(customTool().parameters);
    expect(draft.allowedHosts).toBe('api.shop-example.co.il');
    expect(draft.responseFields).toBe('data.status');
  });
});
