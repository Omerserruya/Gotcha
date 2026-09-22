import { describe, expect, it } from 'vitest';

import {
  actsAlone,
  capabilitySchema,
  DESCRIBED_TOOLS,
  hasOwnWords,
  humaniseToolName,
  capabilityStance,
  groupByCategory,
  isUniform,
  RISK_GROUPS,
  type Capability,
} from './capabilities';

/** The rulings on screen 10, as assertions. Seventeen rows on this tenant. */

const capability = (over: Partial<Capability> = {}): Capability => ({
  toolName: 'update_crm',
  kind: 'action',
  category: 'crm',
  description: 'Update a customer record',
  enabled: true,
  requiresApproval: true,
  isDefault: true,
  approverRole: null,
  expiresAfterMin: 30,
  allowModification: false,
  riskGroup: 'create_update',
  integration: null,
  ...over,
});

describe('the three stances the design promises', () => {
  it('maps disabled to never', () => {
    expect(capabilityStance(capability({ enabled: false }))).toBe('never');
  });

  it('maps enabled plus approval to ask-first', () => {
    expect(capabilityStance(capability({ requiresApproval: true }))).toBe('ask_first');
  });

  it('maps enabled without approval to on-its-own', () => {
    expect(capabilityStance(capability({ requiresApproval: false }))).toBe('on_its_own');
  });

  it('counts only the ones that act without asking', () => {
    const rows = [
      capability({ toolName: 'a', requiresApproval: false }),
      capability({ toolName: 'b', requiresApproval: true }),
      capability({ toolName: 'c', enabled: false, requiresApproval: false }),
    ];
    expect(actsAlone(rows).map((c) => c.toolName)).toEqual(['a']);
  });
});

describe('the risk ordering is contractual', () => {
  it('runs least to most consequential', () => {
    // `tool-availability.ts`: "ordered least to most consequential. The UI
    // groups rows by these; the ordering is the display order, so it is part
    // of the contract." Do not reorder.
    expect([...RISK_GROUPS]).toEqual([
      'read_only',
      'create_update',
      'delete',
      'financial',
      'sensitive_data',
      'administrative',
    ]);
  });
});

describe('grouping is by category, never by risk', () => {
  it('groups on the stored field', () => {
    const rows = [
      capability({ toolName: 'a', category: 'crm' }),
      capability({ toolName: 'b', category: 'messaging' }),
      capability({ toolName: 'c', category: 'crm' }),
    ];
    const groups = groupByCategory(rows);
    expect(groups.map((g) => g.category)).toEqual(['crm', 'messaging']);
    expect(groups[0]!.capabilities).toHaveLength(2);
  });

  it('does not separate two rows that differ only by a regex match on their name', () => {
    /*
     * `riskGroupFor` is a regex over the tool NAME with `create_update` as
     * its no-match fallback. On this tenant:
     *
     *   update_contact -> sensitive_data   (SENSITIVE_RE matches "contact")
     *   update_crm     -> create_update    ("crm" matches nothing)
     *
     * The same operation on the same data, in two groups, because one name
     * contains a word. Grouping by that would render a regex miss as a risk
     * finding — so both land together, by category.
     */
    const groups = groupByCategory([
      capability({ toolName: 'update_contact', category: 'crm', riskGroup: 'sensitive_data' }),
      capability({ toolName: 'update_crm', category: 'crm', riskGroup: 'create_update' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.capabilities).toHaveLength(2);
  });
});

describe('isUniform — said once, not seventeen times', () => {
  it('is true when every row shares a value', () => {
    const rows = [capability({ toolName: 'a' }), capability({ toolName: 'b' })];
    expect(isUniform(rows, (c) => c.allowModification)).toBe(true);
    expect(isUniform(rows, (c) => c.expiresAfterMin)).toBe(true);
  });

  it('is false as soon as one row differs', () => {
    const rows = [
      capability({ toolName: 'a', requiresApproval: true }),
      capability({ toolName: 'b', requiresApproval: false }),
    ];
    expect(isUniform(rows, (c) => c.requiresApproval)).toBe(false);
  });

  it('is false for an empty list rather than vacuously true', () => {
    // "Every row agrees" is not a thing to say about no rows, and a sentence
    // claiming a platform default would render with nothing behind it.
    expect(isUniform([], (c: Capability) => c.enabled)).toBe(false);
  });
});

describe('a capability carries nothing that could become a false claim', () => {
  it('exposes no usage, failure or limit fields', () => {
    /*
     * The design shows "Used 1,840 times this week · never failed" and
     * numeric limits. The only usage route reads ToolExecution, which has
     * zero rows; the populated ToolExecutionRequest has no route at all; and
     * no row carries a limit.
     */
    const surface = Object.keys(capabilitySchema.parse(capability()));
    expect(surface.filter((k) => /used|usage|failures?|limit|quota|maxAmount/i.test(k))).toEqual(
      [],
    );
  });

  it('keeps allowModification, which is false everywhere and read by nothing', () => {
    // Approvals established that no code path consults it. It is kept so the
    // screen can SAY nobody can edit an approved action, and no control is
    // drawn for it.
    expect(capabilitySchema.parse(capability()).allowModification).toBe(false);
  });
});

describe("the platform's own descriptions never reach the screen", () => {
  it('has words of its own for every action this tenant has', () => {
    // Sixteen mapped. If the route grows one, the fallback covers it — but
    // the map is the answer and this test says how much of it is covered.
    expect(DESCRIBED_TOOLS.length).toBeGreaterThanOrEqual(16);
    expect(hasOwnWords('close_conversation')).toBe(true);
  });

  it('falls back to the tool name, never to the platform prose', () => {
    /*
     * The platform's `description` is written for whoever CALLS the tool:
     *
     *   "Mark the current conversation as resolved (autonomous bot only)."
     *   "Returns a draft body; use `schedule_followup` … to actually dispatch it."
     *
     * Seventeen rows of that is an API reference on a merchant's screen. An
     * unmapped tool gets its own name made readable instead — short, true,
     * and a missing translation that looks like one.
     */
    expect(humaniseToolName('shopify.cancel_order')).toBe('Shopify cancel order');
    expect(humaniseToolName('close_conversation')).toBe('Close conversation');
    expect(hasOwnWords('some_tool_added_next_quarter')).toBe(false);
  });
});
