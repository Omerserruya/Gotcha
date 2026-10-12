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
  HIGH_RISK_GROUPS,
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
 * S2 (Omer, 2026-10-12): Do it · Ask me · Never move freely within what the
 * SERVER allows. Since Backend 817508a7 the PUT refuses `requiresApproval:
 * false` (422 `approval_cannot_be_removed`) only for delete, financial and
 * administrative, and only while the kill switch `HIGH_RISK_AUTORUN=off` is
 * set; the list read sends that answer as `autoRunAllowed`, beside
 * `riskGroupFor(toolName)` as `riskGroup`. The table below is the server's,
 * for each thing the read can say about those three.
 */
type Read = 'open' | 'kill switch' | 'stale read';
const SERVER_TABLE: Record<string, Record<Read, 'allowed' | 'refused'>> = {
  read_only: { open: 'allowed', 'kill switch': 'allowed', 'stale read': 'allowed' },
  create_update: { open: 'allowed', 'kill switch': 'allowed', 'stale read': 'allowed' },
  sensitive_data: { open: 'allowed', 'kill switch': 'allowed', 'stale read': 'allowed' },
  delete: { open: 'allowed', 'kill switch': 'refused', 'stale read': 'refused' },
  financial: { open: 'allowed', 'kill switch': 'refused', 'stale read': 'refused' },
  administrative: { open: 'allowed', 'kill switch': 'refused', 'stale read': 'refused' },
};
const AUTO_RUN: Record<Read, boolean | undefined> = {
  open: true,
  'kill switch': false,
  // A read from before 817508a7: no field, and that server refused the three.
  'stale read': undefined,
};

describe('★★ "Do it" is offered exactly where the server allows it', () => {
  it('★★ every one of the server’s six groups, row for row, as each read says it', () => {
    // The six are `RISK_GROUPS` in packages/shared - all of them, no more.
    expect(Object.keys(SERVER_TABLE).sort()).toEqual(
      [...AUTOMATABLE_GROUPS, ...HIGH_RISK_GROUPS].sort(),
    );
    for (const [group, reads] of Object.entries(SERVER_TABLE)) {
      for (const [read, server] of Object.entries(reads) as [Read, string][]) {
        const row = tool({
          toolName: `x.${group}`,
          riskGroup: group,
          autoRunAllowed: AUTO_RUN[read],
        });
        const label = `${group}, ${read}`;
        if (server === 'allowed') {
          expect(automationCeiling(row), label).toBeNull();
          expect(choicesFor(row), label).toEqual(['do_it', 'ask_me', 'never']);
        } else {
          expect(automationCeiling(row), label).toBe('deletes_money_or_settings');
          expect(choicesFor(row), label).toEqual(['ask_me', 'never']);
        }
      }
    }
  });

  it('★ the read keeps `autoRunAllowed` - a contract that strips it locks all three', () => {
    expect(tool({ riskGroup: 'financial', autoRunAllowed: true }).autoRunAllowed).toBe(true);
  });

  it('★ create_update, the classifier’s no-match, is allowed - as the server allows it', () => {
    const cancel = tool({ toolName: 'shopify.cancel_order', riskGroup: 'create_update' });
    expect(automationCeiling(cancel)).toBeNull();
  });

  it('★★ no group, an empty one, or one the server never sends: locked, "we can’t tell"', () => {
    // The server always computes one of six; a row without one cannot say
    // which - nor which sentence a confirm would need - even when it says yes.
    for (const riskGroup of [null, '', '   ', 'unclassified', 'critical']) {
      for (const autoRunAllowed of [true, false, undefined]) {
        const row = tool({ riskGroup, autoRunAllowed });
        expect(automationCeiling(row), String(riskGroup)).toBe('unclassified');
        expect(choicesFor(row), String(riskGroup)).toEqual(['ask_me', 'never']);
      }
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

  it('NEVER_AUTO_APPROVE is exactly the groups the kill switch locks and the screen confirms', () => {
    const never =
      /NEVER_AUTO_APPROVE[^=]*= new Set<RiskGroup>\(\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(quoted(never)).toEqual([...HIGH_RISK_GROUPS].sort());
  });
});

/*
 * `autoRunAllowed` is the PUT's own answer only while both call the same
 * guard with the same switch. Read against the route where the monorepo holds
 * it; SKIPPED outside it, never passed.
 */
const ROUTE = join(process.cwd(), '..', 'services/ai/src/routes/tool-permissions.ts');
describe.skipIf(!existsSync(ROUTE))('★★ the read’s `autoRunAllowed` is the PUT’s guard', () => {
  const route = existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : '';

  it('every row kind sends it from mayBeAlwaysAllowed with the kill switch', () => {
    const sent = [
      ...route.matchAll(/autoRunAllowed: mayBeAlwaysAllowed\(riskGroupFor\([^)]*\), (\w+)\)/g),
    ];
    expect(sent).toHaveLength(2);
    for (const [, flag] of sent) {
      expect(route).toContain(`const ${flag} = highRiskAutoRunPermitted();`);
    }
  });

  it('and the PUT refuses with the same guard and the same switch', () => {
    expect(route).toMatch(
      /requiresApproval === false && !mayBeAlwaysAllowed\(riskGroup, highRiskAutoRunPermitted\(\)\)/,
    );
  });
});

describe('★★ one confirm, in its group’s words: customer details, money, a delete, settings', () => {
  const at = (riskGroup: string, choice: 'do_it' | 'ask_me' | 'never') =>
    tool({
      riskGroup,
      autoRunAllowed: true,
      enabled: choice !== 'never',
      requiresApproval: choice !== 'do_it',
    });
  const ASKS = ['sensitive_data', 'financial', 'delete', 'administrative'];

  it('★★ each of the four, from Ask me or from Never to Do it, names itself', () => {
    for (const group of ASKS) {
      expect(confirmBeforeChoosing(at(group, 'ask_me'), 'do_it'), group).toBe(group);
      expect(confirmBeforeChoosing(at(group, 'never'), 'do_it'), group).toBe(group);
    }
  });

  it('not when tightening, not when already Do it, and not for any other group', () => {
    for (const group of ASKS) {
      expect(confirmBeforeChoosing(at(group, 'do_it'), 'ask_me'), group).toBeNull();
      expect(confirmBeforeChoosing(at(group, 'do_it'), 'never'), group).toBeNull();
      expect(confirmBeforeChoosing(at(group, 'do_it'), 'do_it'), group).toBeNull();
      expect(confirmBeforeChoosing(at(group, 'ask_me'), 'never'), group).toBeNull();
    }
    for (const group of Object.keys(SERVER_TABLE).filter((g) => !ASKS.includes(g))) {
      expect(confirmBeforeChoosing(at(group, 'ask_me'), 'do_it'), group).toBeNull();
      expect(confirmBeforeChoosing(at(group, 'never'), 'do_it'), group).toBeNull();
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
