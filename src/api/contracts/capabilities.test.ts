import { describe, expect, it } from 'vitest';

import {
  actsAlone,
  capabilitySchema,
  DESCRIBED_TOOLS,
  hasOwnWords,
  groupIntegrationRows,
  humaniseCode,
  humaniseToolName,
  capabilityStance,
  groupByCategory,
  isUniform,
  looksLikeCode,
  readableValues,
  RISK_GROUPS,
  type Capability,
} from './capabilities';

/** The rulings on screen 10, as assertions. Seventeen rows on this tenant. */

const capability = (over: Partial<Capability> = {}): Capability => ({
  riskLevel: null,
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
    // The catalogue's acronyms survive a name it does not carry (10's fallback).
    expect(humaniseCode('add_vip_tag')).toBe('Add VIP tag');
    expect(humaniseCode('check_delivery_eta')).toBe('Check delivery ETA');
    expect(humaniseCode('get_sku_stock')).toBe('Get SKU stock');
    expect(hasOwnWords('some_tool_added_next_quarter')).toBe(false);
  });
});

describe('★★ looksLikeCode separates a machine value from something a person wrote', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * THE PROPERTY IS "ONE TOKEN, NO SPACES" — NOT "HAS AN UNDERSCORE"
   * ════════════════════════════════════════════════════════════════════════════
   * Two instruments missed `WHATSAPP` on the same day. One swept where text
   * appears rather than what it does. The other REQUIRED an underscore, for the
   * sound reason that a bare run of capitals is how `CRM` and `VAT` legitimately
   * render — and that is exactly how a screaming identifier which happens to be
   * one word walked past it, reporting green.
   *
   * Both matched the shape in front of them (`SHOPIFY_LIVE_CHAT`) instead of the
   * property they meant. So these cases are chosen to disagree with the
   * underscore rule and with the upper-case rule in both directions.
   */
  it('★★ matches a one-word screaming identifier, which has no underscore', () => {
    expect(looksLikeCode('WHATSAPP')).toBe(true);
  });

  it('★★ matches a lowercase code, which has no capitals either', () => {
    // `crm` reached the DOM lowercase and a stylesheet made it `Crm`.
    expect(looksLikeCode('crm')).toBe(true);
    expect(looksLikeCode('he')).toBe(true);
  });

  it('matches the snake and dotted forms', () => {
    expect(looksLikeCode('SHOPIFY_LIVE_CHAT')).toBe(true);
    expect(looksLikeCode('intent.automatable')).toBe(true);
    expect(looksLikeCode('ai-bot')).toBe(true);
  });

  it('★★ leaves anything with a space alone — prose and names are not ours', () => {
    expect(looksLikeCode('Urban Supply - GOTCHA Demo')).toBe(false);
    expect(looksLikeCode('A Shopify storefront')).toBe(false);
    expect(looksLikeCode('חנות מקוונת')).toBe(false);
  });

  it('★★ leaves an address, a URL and a date alone', () => {
    /*
     * These are the values `humaniseCode` would DAMAGE: it replaces dots with
     * spaces, so an email becomes two words. The guard exists for them, not for
     * the codes.
     */
    expect(looksLikeCode('avery@example.com')).toBe(false);
    expect(looksLikeCode('https://example.com/a')).toBe(false);
    expect(looksLikeCode('2026-09-27')).toBe(false);
    expect(looksLikeCode('19%')).toBe(false);
  });
});

describe('★★ readableValues closes the spread, not the placeholder', () => {
  it('★★ humanises every string key, including ones nobody anticipated', () => {
    /*
     * The defect was `71 conversations came through WHATSAPP`. Repairing
     * `{channel}` would have fixed that sentence and left every future key with
     * the same free pass — which is the difference between a site and a hole.
     * `department` has no resolver and no catalogue and must still be readable.
     */
    expect(readableValues({ channel: 'WHATSAPP', department: 'customer_success' })).toEqual({
      channel: 'WhatsApp',
      department: 'Customer success',
    });
  });

  it('★★ passes numbers through untouched', () => {
    // `30` is not a code, and humanising a formatted number would be a second
    // formatter fighting the locale's.
    expect(readableValues({ count: 71, days: 30, percent: 0 })).toEqual({
      count: 71,
      days: 30,
      percent: 0,
    });
  });

  it('★★ drops a non-scalar rather than printing [object Object]', () => {
    expect(readableValues({ nested: { a: 1 }, list: [1], ok: 'a plain sentence' })).toEqual({
      ok: 'a plain sentence',
    });
  });

  it('★ capitalises a single lowercase word, which is the cost of the rule', () => {
    /*
     * `fine` is indistinguishable from `refunds` by any rule that does not know
     * the domain, so a one-word value arrives capitalised. That is right for the
     * taxonomy values these two call sites carry and it is a real cost
     * elsewhere: this asserts it so the next caller reads it as a decision
     * rather than discovering it.
     */
    expect(readableValues({ topic: 'refunds' })).toEqual({ topic: 'Refunds' });
  });

  it('★★ leaves a value a person wrote exactly as they wrote it', () => {
    const written = 'Urban Supply - GOTCHA Demo';
    expect(readableValues({ name: written })).toEqual({ name: written });
  });

  it('★★ prefers a resolver, because the humaniser answers in English only', () => {
    /*
     * `humaniseCode('SHOPIFY_LIVE_CHAT')` is "Shopify live chat" — right in
     * English and English on a Hebrew screen. Where a translated catalogue
     * exists the caller supplies it; the fallback is what cannot go stale.
     */
    const out = readableValues({ channel: 'SHOPIFY_LIVE_CHAT', other: 'read_orders' }, (key, v) =>
      key === 'channel' ? `צ'אט ${v}` : null,
    );
    expect(out.channel).toBe("צ'אט SHOPIFY_LIVE_CHAT");
    // And a key the resolver declines still goes through the fallback.
    expect(out.other).toBe('Read orders');
  });

  it('★ falls back when the resolver returns null for a key it does not know', () => {
    expect(readableValues({ channel: 'WHATSAPP' }, () => null)).toEqual({ channel: 'WhatsApp' });
  });
});

describe('★ an integration’s rows by what they do (backend c37f1cf7)', () => {
  it('riskier first; none, an unknown value or the old "meta" last, under no head; empty groups left out', () => {
    const rows = ['READ', 'WRITE', null, 'ACTION', 'meta', 'READ'].map((category, i) =>
      capabilitySchema.parse({ toolName: `shopify.t${i}`, integration: 'shopify', category }),
    );
    expect(
      groupIntegrationRows(rows).map((g) => [g.category, g.capabilities.map((c) => c.toolName)]),
    ).toEqual([
      ['ACTION', ['shopify.t3']],
      ['WRITE', ['shopify.t1']],
      ['READ', ['shopify.t0', 'shopify.t5']],
      [null, ['shopify.t2', 'shopify.t4']],
    ]);
  });

  it('a null category parses as none, never a rejected list', () => {
    expect(capabilitySchema.parse({ toolName: 'shopify.x', category: null }).category).toBe('');
  });
});
