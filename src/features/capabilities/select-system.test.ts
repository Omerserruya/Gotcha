import { describe, expect, it } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';

import { actionCounts, selectSystem } from './select-system';

const cap = (toolName: string, integration: string | null) =>
  capabilitySchema.parse({ toolName, integration });
const sys = (slug: string, connected = true) =>
  integrationSchema.parse({
    id: slug,
    slug,
    name: slug,
    tenantConnection: connected ? { id: `c-${slug}`, status: 'CONNECTED' } : null,
  });

const CAPS = [
  cap('send_message', null),
  cap('shopify.lookup', 'shopify'),
  cap('shopify.refund', 'shopify'),
  cap('hubspot.find', 'hubspot'),
];
const SYSTEMS = [sys('hubspot', false), sys('shopify'), sys('empty')];

describe('★ which system 10 shows', () => {
  it('the one asked for, with only its actions', () => {
    const picked = selectSystem('shopify', CAPS, SYSTEMS);
    expect(picked.selected).toBe('shopify');
    expect(picked.actions.map((c) => c.toolName)).toEqual(['shopify.lookup', 'shopify.refund']);
  });

  it('★ "builtin" is the actions that belong to no provider', () => {
    const picked = selectSystem('builtin', CAPS, SYSTEMS);
    expect(picked.integration).toBeNull();
    expect(picked.actions.map((c) => c.toolName)).toEqual(['send_message']);
  });

  it('★★ a system that is not connected is its own screen, with nothing to set yet (Omer, 2026-10-04)', () => {
    const picked = selectSystem('hubspot', CAPS, SYSTEMS);
    expect(picked.selected).toBe('hubspot');
    expect(picked.integration?.slug).toBe('hubspot');
    // Its tool-permission rows (a stale connection's) are not settable from here.
    expect(picked.actions).toEqual([]);
  });

  it('★★ an unknown or absent system falls back — never an empty detail', () => {
    for (const wanted of ['nope', undefined]) {
      // The first CONNECTED system that brings actions: not `empty`, not `hubspot`.
      expect(selectSystem(wanted, CAPS, SYSTEMS).selected).toBe('shopify');
    }
  });

  it('nothing connected brings actions: the built-in ones', () => {
    expect(selectSystem(undefined, CAPS, [sys('empty')]).selected).toBe('builtin');
  });

  it('counts each system’s actions by slug, leaving the built-in ones out', () => {
    expect(actionCounts(CAPS)).toEqual({ shopify: 2, hubspot: 1 });
  });
});
