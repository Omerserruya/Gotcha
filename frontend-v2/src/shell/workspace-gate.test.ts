import { describe, expect, it } from 'vitest';

import { consoleOnly, isConsolePath, resumeStep, workspaceRoute } from './workspace-gate';

describe("★★ onboarding is a gate: each status to its place (the server's word)", () => {
  const at = (tenantStatus: string | null, role: string | null = 'ADMIN') =>
    workspaceRoute({ tenantStatus, role });

  it('an admin of a workspace being set up: onboarding', () => {
    expect(at('PENDING_ONBOARDING')).toBe('onboarding');
    expect(at('PENDING_ADMIN_SETUP')).toBe('onboarding');
  });

  it('anyone else in it: waits - never the product', () => {
    expect(at('PENDING_ONBOARDING', 'AGENT')).toBe('waiting');
    expect(at('PENDING_ONBOARDING', null)).toBe('waiting');
  });

  /*
   * ★★ PROD HOTFIX (2026-10-23). This test used to assert the defect itself:
   * a SYSTEM_ADMIN in a PENDING_ADMIN_SETUP tenant waited. That is prod's
   * admin@ and its "System" tenant - locked out of the console.
   */
  it.each([
    ['PENDING_ADMIN_SETUP'],
    ['PENDING_ONBOARDING'],
    ['PENDING_PAYMENT'],
    ['SUSPENDED'],
    ['SOMETHING_NEW'],
    ['ACTIVE'],
    [null],
  ])('★★ a SYSTEM_ADMIN passes whatever the status (%s): the product', (status) => {
    expect(at(status, 'SYSTEM_ADMIN')).toBe('product');
    // The role arrives in either case (`/permissions/me` sends it lower-case).
    expect(at(status, 'system_admin')).toBe('product');
  });

  it('…but an unread /me stops even a system admin: then the role is unknown too', () => {
    expect(workspaceRoute(null)).toBe('unavailable');
  });

  it('unpaid: payment, whoever it is', () => {
    expect(at('PENDING_PAYMENT')).toBe('payment');
    expect(at('PENDING_PAYMENT', 'AGENT')).toBe('payment');
  });

  it('live, suspended, or a status this does not know: the product as today', () => {
    expect(at('ACTIVE')).toBe('product');
    expect(at('ACTIVE', 'AGENT')).toBe('product');
    expect(at('SUSPENDED')).toBe('product');
    expect(at('SOMETHING_NEW')).toBe('product');
  });

  it('unread: the Retry screen - not the product, not a lock', () => {
    expect(workspaceRoute(null)).toBe('unavailable');
    expect(at(null)).toBe('unavailable');
  });
});

describe('★ onboarding resumes where it really is', () => {
  it('by the read and the core system', () => {
    expect(resumeStep({ discovery: null, coreConnected: false })).toBe('website');
    expect(resumeStep({ discovery: { status: 'FAILED' }, coreConnected: true })).toBe('website');
    expect(resumeStep({ discovery: { status: 'SCANNING' }, coreConnected: false })).toBe('reading');
    expect(resumeStep({ discovery: { status: 'COMPLETE' }, coreConnected: false })).toBe('learned');
    expect(resumeStep({ discovery: { status: 'COMPLETE' }, coreConnected: true })).toBe('try');
  });
});

describe('★★ onboarding as a preview (Omer, 2026-10-07): a live workspace, an admin, and asked for', () => {
  it('only ACTIVE and ADMIN may', async () => {
    const { mayPreviewOnboarding } = await import('./workspace-gate');
    expect(mayPreviewOnboarding({ tenantStatus: 'ACTIVE', role: 'ADMIN' })).toBe(true);
    expect(mayPreviewOnboarding({ tenantStatus: 'ACTIVE', role: 'AGENT' })).toBe(false);
    expect(mayPreviewOnboarding({ tenantStatus: 'SUSPENDED', role: 'ADMIN' })).toBe(false);
    expect(mayPreviewOnboarding({ tenantStatus: 'PENDING_PAYMENT', role: 'ADMIN' })).toBe(false);
    expect(mayPreviewOnboarding(null)).toBe(false);
  });

  it('asked for: `preview=1` in the query, and nowhere else', async () => {
    const { asksForPreview } = await import('./workspace-gate');
    expect(asksForPreview('/en/onboarding/try?preview=1')).toBe(true);
    expect(asksForPreview('/en/onboarding/truth?system=wix&preview=1')).toBe(true);
    expect(asksForPreview('/en/onboarding/try?preview=0')).toBe(false);
    expect(asksForPreview('/en/onboarding/preview=1')).toBe(false);
    expect(asksForPreview('/en/onboarding/try')).toBe(false);
    expect(asksForPreview(null)).toBe(false);
  });
});

describe('★★ a system admin of a tenant not live works in the console only', () => {
  it('any status but ACTIVE, including unknown and unread status', () => {
    for (const status of [
      'PENDING_ADMIN_SETUP',
      'PENDING_ONBOARDING',
      'PENDING_PAYMENT',
      'SUSPENDED',
      'SOMETHING_NEW',
      null,
    ]) {
      expect(consoleOnly({ tenantStatus: status, role: 'SYSTEM_ADMIN' })).toBe(true);
    }
  });

  it('a system admin of a LIVE tenant, and everyone else, use the product', () => {
    expect(consoleOnly({ tenantStatus: 'ACTIVE', role: 'SYSTEM_ADMIN' })).toBe(false);
    expect(consoleOnly({ tenantStatus: 'PENDING_ADMIN_SETUP', role: 'ADMIN' })).toBe(false);
    expect(consoleOnly({ tenantStatus: 'SUSPENDED', role: 'AGENT' })).toBe(false);
    expect(consoleOnly(null)).toBe(false);
  });

  it('the console is /system and below, with or without a language - nothing that only starts like it', () => {
    for (const p of [
      '/system',
      '/en/system',
      '/he/system/tenants',
      '/en/system/tenants/t1?tab=billing',
      '/system/',
    ]) {
      expect(isConsolePath(p)).toBe(true);
    }
    for (const p of ['/en/home', '/en/systems', '/en/settings/system', '/he/inbox', '']) {
      expect(isConsolePath(p)).toBe(false);
    }
  });
});
