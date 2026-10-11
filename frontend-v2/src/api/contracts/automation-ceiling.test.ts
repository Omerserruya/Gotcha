import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTOMATABLE_GROUPS,
  automationCeiling,
  bodyFor,
  capabilitySchema,
  choicesFor,
  confirmBeforeChoosing,
  currentChoice,
  NEVER_AUTOMATIC_GROUPS,
  type Capability,
} from './capabilities';

/**
 * Screen 10's ceiling on automation.
 *
 * These are the tests for a control that changes what the AI may do to
 * customers without anyone watching. Nothing here presses the write - the
 * subject is which choices are OFFERED, and that is decided before any
 * request is made.
 */

const tool = (over: Record<string, unknown> = {}): Capability =>
  capabilitySchema.parse({ toolName: 'shopify.get_order', riskGroup: 'read_only', ...over });

/*
 * S2 (Omer, 2026-10-11): Do it · Ask me · Never move freely within what the
 * SERVER allows. The PUT refuses `requiresApproval: false` for exactly
 * delete, financial and administrative (`NEVER_AUTO_APPROVE`, 422
 * `approval_cannot_be_removed`); the list read sends the same
 * `riskGroupFor(toolName)` as `riskGroup`. The table below is the server's.
 */
const SERVER_TABLE: Record<string, 'allowed' | 'refused'> = {
  read_only: 'allowed',
  create_update: 'allowed',
  sensitive_data: 'allowed',
  delete: 'refused',
  financial: 'refused',
  administrative: 'refused',
};

describe('★★ "Do it" is offered exactly where the server allows it', () => {
  it('★★ every one of the server’s six groups, row for row', () => {
    // The six are `RISK_GROUPS` in packages/shared - all of them, no more.
    expect(Object.keys(SERVER_TABLE).sort()).toEqual(
      [...AUTOMATABLE_GROUPS, ...NEVER_AUTOMATIC_GROUPS].sort(),
    );
    for (const [group, server] of Object.entries(SERVER_TABLE)) {
      const row = tool({ toolName: `x.${group}`, riskGroup: group });
      if (server === 'allowed') {
        expect(automationCeiling(row), group).toBeNull();
        expect(choicesFor(row), group).toEqual(['do_it', 'ask_me', 'never']);
      } else {
        expect(automationCeiling(row), group).toBe('deletes_money_or_settings');
        expect(choicesFor(row), group).toEqual(['ask_me', 'never']);
      }
    }
  });

  it('★ create_update, the classifier’s no-match, is allowed - as the server allows it', () => {
    const cancel = tool({ toolName: 'shopify.cancel_order', riskGroup: 'create_update' });
    expect(automationCeiling(cancel)).toBeNull();
  });

  it('★★ no group, an empty one, or one the server never sends: locked, "we can’t tell"', () => {
    // The server always computes one of six; a row without one cannot say which.
    for (const riskGroup of [null, '', '   ', 'unclassified', 'critical']) {
      expect(automationCeiling(tool({ riskGroup })), String(riskGroup)).toBe('unclassified');
      expect(choicesFor(tool({ riskGroup })), String(riskGroup)).toEqual(['ask_me', 'never']);
    }
  });

  it('★ separates "deletes, money or settings" from "we could not classify it"', () => {
    expect(automationCeiling(tool({ riskGroup: 'financial' }))).not.toBe(
      automationCeiling(tool({ riskGroup: null })),
    );
  });
});

/*
 * The table above, read against the server's own source where the monorepo
 * holds it (`packages/shared/src/lib/tool-availability.ts`). Outside the
 * monorepo the source is absent and this is SKIPPED - reported as skipped,
 * never passed.
 */
const SHARED = join(process.cwd(), '..', 'packages/shared/src/lib/tool-availability.ts');
describe.skipIf(!existsSync(SHARED))('★★ the server’s own source agrees with the table', () => {
  const source = existsSync(SHARED) ? readFileSync(SHARED, 'utf8') : '';
  const quoted = (block: string) => [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();

  it('RISK_GROUPS is the six groups the table names', () => {
    const groups = /RISK_GROUPS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(quoted(groups)).toEqual(Object.keys(SERVER_TABLE).sort());
  });

  it('NEVER_AUTO_APPROVE is exactly the groups the screen withholds', () => {
    const never =
      /NEVER_AUTO_APPROVE[^=]*= new Set<RiskGroup>\(\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(quoted(never)).toEqual([...NEVER_AUTOMATIC_GROUPS].sort());
  });
});

describe('★★ one confirm: customer details to "Do it", nothing else', () => {
  const at = (riskGroup: string, choice: 'do_it' | 'ask_me' | 'never') =>
    tool({
      riskGroup,
      enabled: choice !== 'never',
      requiresApproval: choice !== 'do_it',
    });

  it('sensitive_data from Ask me or from Never to Do it: confirm', () => {
    expect(confirmBeforeChoosing(at('sensitive_data', 'ask_me'), 'do_it')).toBe(true);
    expect(confirmBeforeChoosing(at('sensitive_data', 'never'), 'do_it')).toBe(true);
  });

  it('not when tightening, not when already Do it, and not for any other group', () => {
    expect(confirmBeforeChoosing(at('sensitive_data', 'do_it'), 'ask_me')).toBe(false);
    expect(confirmBeforeChoosing(at('sensitive_data', 'do_it'), 'never')).toBe(false);
    expect(confirmBeforeChoosing(at('sensitive_data', 'do_it'), 'do_it')).toBe(false);
    expect(confirmBeforeChoosing(at('sensitive_data', 'ask_me'), 'never')).toBe(false);
    for (const group of Object.keys(SERVER_TABLE).filter((g) => g !== 'sensitive_data')) {
      expect(confirmBeforeChoosing(at(group, 'ask_me'), 'do_it'), group).toBe(false);
      expect(confirmBeforeChoosing(at(group, 'never'), 'do_it'), group).toBe(false);
    }
  });
});

describe('★★ the write body always states BOTH fields', () => {
  it('★★ never sends `enabled` without `requiresApproval`', () => {
    /*
     * The route applies `requiresApproval` only when present. So enabling a
     * tool currently set to Never with `{ enabled: true }` alone would
     * restore whatever approval setting it last carried - on a financial
     * tool, possibly none. Every transition states both.
     */
    for (const choice of ['do_it', 'ask_me', 'never'] as const) {
      const body = bodyFor(choice);
      expect(Object.keys(body).sort()).toEqual(['enabled', 'requiresApproval']);
    }
  });

  it('★ "never" asks for approval as well as disabling', () => {
    // Belt and braces in the safe direction: if a later write re-enables it
    // without stating approval, the stored value is the cautious one.
    expect(bodyFor('never')).toEqual({ enabled: false, requiresApproval: true });
  });

  it('maps the other two as the platform does', () => {
    expect(bodyFor('ask_me')).toEqual({ enabled: true, requiresApproval: true });
    expect(bodyFor('do_it')).toEqual({ enabled: true, requiresApproval: false });
  });
});

describe('★ where the tool is now', () => {
  it('reads the stored pair back as one of the three', () => {
    expect(currentChoice(tool({ enabled: false }))).toBe('never');
    expect(currentChoice(tool({ enabled: true, requiresApproval: true }))).toBe('ask_me');
    expect(currentChoice(tool({ enabled: true, requiresApproval: false }))).toBe('do_it');
  });

  it('★★ can report `do_it` on a tool that may no longer be SET to it', () => {
    /*
     * A financial tool stored as auto-approve - set before this ceiling
     * existed.
     * `currentChoice` reports the truth and `choicesFor` withholds the
     * option, so the screen shows what IS without offering to put it back.
     *
     * Hiding the current state would be worse: an admin cannot fix a setting
     * the screen will not show them.
     */
    const stored = tool({ riskGroup: 'financial', enabled: true, requiresApproval: false });
    expect(currentChoice(stored)).toBe('do_it');
    expect(choicesFor(stored)).not.toContain('do_it');
  });
});
