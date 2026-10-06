import { describe, expect, it } from 'vitest';

import {
  automationCeiling,
  bodyFor,
  capabilitySchema,
  choicesFor,
  currentChoice,
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

describe('★★ "Do it" needs a positive read_only, not the absence of a warning', () => {
  it('★★ withholds automation from create_update, which is the NO-MATCH fallback', () => {
    /*
     * THE MEASUREMENT THIS RULE COMES FROM.
     *
     * `riskGroupFor` tests four name patterns and falls through to
     * `create_update`. Neither "cancel" nor "return" is in any of them, so
     * `shopify.cancel_order` and `shopify.create_return` both land here and
     * the platform's own `mayBeAlwaysAllowed` returns TRUE for them - while
     * the design puts both under "Changing orders and money · Comes to
     * Approvals".
     *
     * `create_update` is not a judgement. It is the absence of four
     * judgements, and reading it as "assessed and found low-risk" is the
     * same error as reading an empty conflict list as "nothing disagrees".
     */
    const cancel = tool({ toolName: 'shopify.cancel_order', riskGroup: 'create_update' });
    expect(automationCeiling(cancel)).toBe('unclassified');
    expect(choicesFor(cancel)).toEqual(['ask_me', 'never']);
  });

  it('★★ withholds it from every group the platform DOES name as risky', () => {
    for (const group of ['financial', 'delete', 'administrative', 'sensitive_data']) {
      const risky = tool({ riskGroup: group });
      expect(automationCeiling(risky), group).toBe('changes_orders_or_money');
      expect(choicesFor(risky), group).toEqual(['ask_me', 'never']);
    }
  });

  it('★ withholds it when the group is missing entirely', () => {
    // A tool we were told nothing about is not a tool we may automate.
    expect(automationCeiling(tool({ riskGroup: null }))).toBe('unclassified');
  });

  it('offers it for a positively read-only tool', () => {
    expect(automationCeiling(tool())).toBeNull();
    expect(choicesFor(tool())).toEqual(['do_it', 'ask_me', 'never']);
  });

  it('★ separates "changes money" from "we could not classify it"', () => {
    /*
     * Two different sentences. The first is about the tool and a reader can
     * act on it; the second is about us. Collapsing them would tell an admin
     * their calendar tool moves money.
     */
    expect(automationCeiling(tool({ riskGroup: 'financial' }))).not.toBe(
      automationCeiling(tool({ riskGroup: 'create_update' })),
    );
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
     * existed, or by curl, since the write does not enforce the guard.
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
