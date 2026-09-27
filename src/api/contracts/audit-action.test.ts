import { describe, expect, it } from 'vitest';

import { auditVerdict, describeAuditAction } from './security';

/**
 * "Everything that happened", in words.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A PLAIN-ENGLISH HEADING OVER A LIST OF MACHINE KEYS
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk read this off Settings · Security, verbatim, on a page an
 * account owner opens:
 *
 *     Everything that happened
 *     ai.responded                              1083
 *     adapter.ok.shopify.get_customer_by_phone  1081
 *     adapter.err.shopify.get_customer_by_phone  742
 *
 * It qualifies under the criterion the assertion sweep produced: a name exists
 * and the code refuses it.
 */

describe('★★ an audit action is a tool and an outcome, not a key', () => {
  it('★★ names the tool and takes the outcome off the front', () => {
    expect(describeAuditAction('adapter.ok.shopify.get_customer_by_phone')).toEqual({
      name: 'Shopify get customer by phone',
      outcome: 'ok',
    });
    expect(describeAuditAction('adapter.err.shopify.get_customer_by_phone')).toEqual({
      name: 'Shopify get customer by phone',
      outcome: 'err',
    });
  });

  it('★★ gives the two outcomes of one tool the SAME name', () => {
    /*
     * The point of separating the outcome. With `err` inside the name, the two
     * rows read as two different tools and the reader cannot see that the same
     * call succeeded 1081 times and failed 742.
     */
    const ok = describeAuditAction('adapter.ok.shopify.get_shop');
    const err = describeAuditAction('adapter.err.shopify.get_shop');
    expect(ok.name).toBe(err.name);
    expect(ok.outcome).not.toBe(err.outcome);
  });

  it('★ names an `ai.*` action without pretending it is a tool call', () => {
    // `adapter.*` is the AI calling somebody else's system; `ai.*` is the AI
    // acting on its own. The prefix is meaningful here, so it stays.
    expect(describeAuditAction('ai.responded')).toEqual({ name: 'AI responded', outcome: null });
    expect(describeAuditAction('ai.bot_turn')).toEqual({ name: 'AI bot turn', outcome: null });
  });

  it('★★ an `adapter.*` with no outcome segment has an UNKNOWN outcome, not a good one', () => {
    /*
     * The emitter is free to send this and the reassuring reading would be "no
     * error means it worked". We were not told.
     */
    expect(describeAuditAction('adapter.shopify.get_shop')).toEqual({
      name: 'Shopify get shop',
      outcome: null,
    });
  });

  it('★ leaves an action it has never seen readable rather than dropping it', () => {
    expect(describeAuditAction('warehouse.stock_synced').name).toBe('Warehouse stock synced');
  });
});

describe('★★ the verdict reads both sources, and keeps three states', () => {
  it('★★ an `err` in the name is a recorded failure, not a missing verdict', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * 742 KNOWN FAILURES WERE FILED AS "WE DID NOT RECORD WHETHER THIS WORKED"
     * ════════════════════════════════════════════════════════════════════════
     * `AuditEntry.succeeded` is `null` on every `adapter.*` row while the action
     * name says `err` in so many words. Reading only the column throws away a
     * verdict we were given — it is just encoded in a string.
     */
    expect(auditVerdict(null, 'adapter.err.shopify.get_shop')).toBe(false);
    expect(auditVerdict(undefined, 'adapter.err.shopify.get_shop')).toBe(false);
    expect(auditVerdict(null, 'adapter.ok.shopify.get_shop')).toBe(true);
  });

  it('★★ the explicit column beats the substring, in both directions', () => {
    /*
     * A column and a name can disagree. The column is a field somebody set; the
     * name is a convention. Asserted in both directions, because a rule that
     * only prefers the column when the column says "false" is a rule about
     * pessimism rather than about provenance.
     */
    expect(auditVerdict(false, 'adapter.ok.shopify.get_shop')).toBe(false);
    expect(auditVerdict(true, 'adapter.err.shopify.get_shop')).toBe(true);
  });

  it('★★ says nothing when neither source says anything', () => {
    /*
     * The third state, and the reason it exists: collapsing it to "failed" would
     * alarm a reader about things that did not go wrong, and collapsing it to
     * "worked" is the reassuring lie.
     */
    expect(auditVerdict(null, 'ai.responded')).toBeNull();
    expect(auditVerdict(undefined, 'warehouse.stock_synced')).toBeNull();
  });
});
