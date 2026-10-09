import { describe, expect, it } from 'vitest';

import {
  capabilitySchema,
  isTheAdminsChoice,
  resolveAvailability,
  UNAVAILABLE_REASONS,
  type Capability,
} from './capabilities';

/**
 * Screen 10's four states.
 *
 * A port of `resolveToolAvailability` from the platform's shared lib, and the
 * tests exist mostly to hold the ORDER - which is a design statement, not an
 * implementation detail: *"an unentitled plan cannot be fixed by connecting
 * anything, a disconnected integration cannot be fixed by granting scopes,
 * and a missing scope cannot be fixed by toggling the switch. Reporting the
 * wrong one sends them to the wrong screen."*
 */

const tool = (over: Record<string, unknown> = {}): Capability =>
  capabilitySchema.parse({
    toolName: 'shopify.process_refund',
    enabled: true,
    requiresApproval: false,
    ...over,
  });

describe('★★ the three states the admin owns', () => {
  it('maps the stored preference onto do-it, ask-me and never', () => {
    expect(resolveAvailability(tool({ enabled: true, requiresApproval: false })).state).toBe(
      'always_allow',
    );
    expect(resolveAvailability(tool({ enabled: true, requiresApproval: true })).state).toBe(
      'require_approval',
    );
    expect(resolveAvailability(tool({ enabled: false })).state).toBe('disabled');
  });

  it('★ says the switch IS theirs, rather than giving no reason', () => {
    // `reason: 'ok'` is a statement, not a blank. It is what lets the screen
    // tell "you turned this off" from "you cannot turn this on".
    const off = resolveAvailability(tool({ enabled: false }));
    expect(off.reason).toBe('ok');
    expect(off.overriddenByPlatform).toBe(false);
    expect(isTheAdminsChoice(off)).toBe(true);
  });
});

describe('★★ the fourth state, and the order of its reasons', () => {
  it('★★ a disconnected integration outranks a missing scope', () => {
    /*
     * THE ORDER IS THE WHOLE POINT. Both facts are true on this row. Sending
     * somebody to grant a scope on an integration that is not connected is
     * an instruction to do work that cannot help - they would go to the
     * provider's settings, find nothing to grant, and come back.
     */
    const both = tool({
      integrationConnected: false,
      scopeBlocked: true,
      missingScopes: ['write_orders'],
    });
    expect(resolveAvailability(both).reason).toBe('integration_disconnected');
  });

  it('carries the missing scopes when that is the reason', () => {
    const blocked = tool({ scopeBlocked: true, missingScopes: ['write_orders', 'read_returns'] });
    const resolved = resolveAvailability(blocked);
    expect(resolved.state).toBe('unavailable');
    expect(resolved.missingScopes).toEqual(['write_orders', 'read_returns']);
  });

  it('★★ "we have no record of this provider" is NOT "disconnected"', () => {
    /*
     * The route: *"A tool whose provider we have no record of is not
     * reported as disconnected - we simply do not know, and guessing
     * 'broken' is its own false statement."*
     *
     * `undefined` here with a truthiness check would grey out a working
     * control and tell the admin to go and reconnect something that is
     * connected.
     */
    const unknown = tool({ integrationConnected: undefined });
    expect(resolveAvailability(unknown).state).toBe('always_allow');
  });

  it('★★ an ABSENT scope verdict is not a pass', () => {
    /*
     * *"An absent verdict never means 'definitely fine'."* A provider with
     * no adapter definition supplies no `scopeBlocked`, and then the
     * declared-required against granted comparison is the only evidence
     * there is. Skipping it would report a tool as usable that the runtime
     * will refuse.
     */
    const noVerdict = tool({
      scopeBlocked: undefined,
      requiredScopes: ['write_orders'],
      grantedScopes: [],
    });
    const resolved = resolveAvailability(noVerdict);
    expect(resolved.state).toBe('unavailable');
    expect(resolved.missingScopes).toEqual(['write_orders']);
  });

  it('★ but an explicit "not blocked" stops the fallback', () => {
    // When the runtime HAS spoken, its verdict wins over our comparison -
    // the enforcement source is `missingScopes`, populated from real
    // provider errors, and re-deriving is a second chance to disagree.
    const cleared = tool({
      scopeBlocked: false,
      requiredScopes: ['write_orders'],
      grantedScopes: [],
    });
    expect(resolveAvailability(cleared).state).toBe('always_allow');
  });

  it('an unavailable row is not the admin’s to press', () => {
    expect(isTheAdminsChoice(resolveAvailability(tool({ integrationConnected: false })))).toBe(
      false,
    );
  });
});

describe('★ the domain is the platform’s, including what this route cannot send', () => {
  it('★★ names all five reasons even though two cannot arrive here', () => {
    /*
     * `plan_not_entitled` and `no_catalog_entry` are resolved from
     * `planEntitled` and `hasCatalogEntry`, and `/api/tool-permissions`
     * sends neither - it builds its rows by hand rather than calling the
     * shared resolver.
     *
     * They stay in the enum because one missing member rejects the whole
     * response the day a second caller appears, which is the defect that
     * took the business-core section off screen 14.
     */
    expect([...UNAVAILABLE_REASONS]).toEqual([
      'ok',
      'integration_disconnected',
      'missing_scope',
      'plan_not_entitled',
      'no_catalog_entry',
    ]);
  });

  it('★ keeps the availability facts the contract used to strip', () => {
    // All five arrived on every response and none was named, so the fourth
    // state looked impossible. Fifth field today we were already being sent.
    const parsed = capabilitySchema.parse({
      toolName: 't',
      integrationConnected: true,
      scopeBlocked: false,
      missingScopes: ['a'],
      requiredScopes: ['a', 'b'],
      grantedScopes: ['a'],
    });
    expect(parsed.integrationConnected).toBe(true);
    expect(parsed.scopeBlocked).toBe(false);
    expect(parsed.requiredScopes).toEqual(['a', 'b']);
  });

  it('★★ an absent fact stays absent, never defaulted to false', () => {
    // `.optional()` and not `.nullable().default(false)`: a default would
    // turn every tool with an unrecognised provider into a disconnected one.
    const parsed = capabilitySchema.parse({ toolName: 't' });
    expect(parsed.integrationConnected).toBeUndefined();
    expect(parsed.scopeBlocked).toBeUndefined();
  });
});
