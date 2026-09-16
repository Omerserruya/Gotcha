import { describe, expect, it } from 'vitest';

import { resolveStance, toolSlugOf, type Integration } from '@/api/contracts/integrations';

import { buildSystemRows, stanceCounts } from './rows';

const tool = (slug: string, enabled = true) => ({
  id: `t-${slug}`,
  slug,
  name: slug,
  riskLevel: null,
  enabled,
});

const integration = (over: Partial<Integration> = {}): Integration => ({
  id: 'i1',
  slug: 'shopify',
  name: 'Shopify',
  authType: 'OAUTH2',
  catalogTools: [],
  tenantConnection: { id: 'c1', status: 'CONNECTED' },
  ...over,
});

describe('toolSlugOf', () => {
  it('takes the slug from both spellings the backend produces', () => {
    expect(toolSlugOf('integration.process_refund')).toBe('process_refund');
    expect(toolSlugOf('shopify.process_refund')).toBe('process_refund');
  });

  it('rejects an internal tool, which is not an integration capability', () => {
    expect(toolSlugOf('get_contact')).toBeNull();
    expect(toolSlugOf('send_message')).toBeNull();
  });
});

describe('resolveStance', () => {
  it('gates on ACTIVATION, which is what the runtime gates on', () => {
    // `getAvailableTools` builds the AI's surface from
    // tenantTool.findMany({ isEnabled: true, tenantIntegration: CONNECTED }).
    expect(resolveStance(false, undefined)).toBe('never');
    expect(resolveStance(true, undefined)).toBe('allow');
  });

  it('reports approval-required as its own state, not as allowed', () => {
    expect(resolveStance(true, { toolName: 'x.y', enabled: true, requiresApproval: true })).toBe(
      'ask',
    );
  });

  it('IGNORES ToolPermission.enabled, which nothing enforces', () => {
    // `TenantToolPermission` has a row disabling `integration.process_refund`,
    // and no execution path reads that table — only routes do. The
    // tool-permissions route even hardcodes `enabled: true` for integration
    // tools. Rendering that row as "Never" would report a restriction the
    // runtime does not apply: wrong in the cautious direction, which is better
    // than the reassuring one and still a false statement about what the AI
    // may do.
    expect(resolveStance(true, { toolName: 'x.y', enabled: false, requiresApproval: false })).toBe(
      'allow',
    );
  });

  it('never invents "ask" without an approval requirement', () => {
    expect(resolveStance(true, undefined)).not.toBe('ask');
    expect(resolveStance(false, undefined)).not.toBe('ask');
  });
});

describe('buildSystemRows', () => {
  it('marks a capability that needs approval as "ask"', () => {
    const rows = buildSystemRows(
      [integration({ catalogTools: [tool('process_refund', true)] })],
      [{ toolName: 'integration.process_refund', enabled: true, requiresApproval: true }],
      true,
      'en',
    );
    expect(rows[0]!.capabilities[0]!.stance).toBe('ask');
  });

  it('reports that nothing runs while the system is down', () => {
    // The surface query requires `tenantIntegration.status = CONNECTED`, so a
    // broken system's capabilities are inert however they are configured.
    const down = buildSystemRows(
      [integration({ tenantConnection: { id: 'c1', status: 'ERROR' } })],
      [],
      true,
      'en',
    );
    expect(down[0]!.capabilitiesRunning).toBe(false);
    expect(buildSystemRows([integration()], [], true, 'en')[0]!.capabilitiesRunning).toBe(true);
  });

  it('leaves every stance null when the policy read failed', () => {
    // Not "allow", and not "never". We do not know, and this screen must not
    // guess about whether an AI may issue a refund.
    const rows = buildSystemRows(
      [integration({ catalogTools: [tool('process_refund', true)] })],
      [],
      false,
      'en',
    );
    expect(rows[0]!.capabilities[0]!.stance).toBeNull();
    expect(stanceCounts(rows[0]!).unknown).toBe(1);
  });

  it('shows only systems the tenant has actually connected', () => {
    // The catalogue lists every published integration. This screen is "your
    // business systems", not a marketplace.
    const rows = buildSystemRows(
      [integration(), integration({ id: 'i2', slug: 'hubspot', tenantConnection: null })],
      [],
      true,
      'en',
    );
    expect(rows.map((r) => r.slug)).toEqual(['shopify']);
  });

  it('treats a failed test as failing even when the status says otherwise', () => {
    const rows = buildSystemRows(
      [
        integration({
          tenantConnection: { id: 'c1', status: 'CONNECTED', lastTestResult: false },
        }),
      ],
      [],
      true,
      'en',
    );
    expect(rows[0]!.failing).toBe(true);
  });

  it('sorts a failing system above a healthy one', () => {
    const rows = buildSystemRows(
      [
        integration({ id: 'ok', slug: 'aaa', name: 'Aaa' }),
        integration({
          id: 'bad',
          slug: 'zzz',
          name: 'Zzz',
          tenantConnection: { id: 'c2', status: 'ERROR' },
        }),
      ],
      [],
      true,
      'en',
    );
    expect(rows[0]!.slug).toBe('zzz');
  });

  it('keeps the platform error text rather than a paraphrase', () => {
    const rows = buildSystemRows(
      [
        integration({
          tenantConnection: {
            id: 'c1',
            status: 'ERROR',
            lastError: 'token_refresh_failed:shopify_token_refresh_failed_401',
          },
        }),
      ],
      [],
      true,
      'en',
    );
    expect(rows[0]!.error).toBe('token_refresh_failed:shopify_token_refresh_failed_401');
  });

  it('distinguishes never-tested from tested-and-failed', () => {
    const never = buildSystemRows([integration()], [], true, 'en');
    expect(never[0]!.lastCheckPassed).toBeNull();

    const failed = buildSystemRows(
      [integration({ tenantConnection: { id: 'c1', status: 'ERROR', lastTestResult: false } })],
      [],
      true,
      'en',
    );
    expect(failed[0]!.lastCheckPassed).toBe(false);
  });

  it('marks an OAuth system as not repairable from here', () => {
    // Repairing one means re-authorising at the provider, and the callback
    // returns to whichever app FRONTEND_URL names — not this one.
    expect(buildSystemRows([integration()], [], true, 'en')[0]!.repairableHere).toBe(false);
    expect(
      buildSystemRows([integration({ authType: 'API_KEY' })], [], true, 'en')[0]!.repairableHere,
    ).toBe(true);
  });

  it('counts the three stances separately', () => {
    const rows = buildSystemRows(
      [integration({ catalogTools: [tool('a'), tool('b'), tool('c')] })],
      [{ toolName: 'integration.a', enabled: true, requiresApproval: true }],
      true,
      'en',
    );
    expect(stanceCounts(rows[0]!)).toEqual({ allow: 2, ask: 1, never: 0, unknown: 0 });
  });
});
