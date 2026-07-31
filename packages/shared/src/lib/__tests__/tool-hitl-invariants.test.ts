import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../prisma";

/**
 * Guards the tool-policy invariants that the 2026-07-31 audit found violated.
 *
 * These assert against the CATALOG DEFAULT (`catalog_tools.hitl_policy`) — the
 * floor a tenant inherits when they have never expressed a policy of their own.
 * A tenant override in `tenant_tools.config_overrides` is authoritative and is
 * deliberately NOT asserted here: tenants are allowed to make their own call,
 * including a looser one, and this file must not pretend otherwise.
 *
 * Needs a database. Skipped rather than failed when there is none, so a
 * contributor without Postgres does not see a red suite they cannot fix.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("catalog HITL defaults cannot ship a dangerous tool as autonomous", () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it("NO HIGH-risk tool defaults to autonomous", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ tool: string }>>(`
      select c.slug || '.' || t.slug as tool
      from catalog_tools t join integration_catalog c on c.id = t.integration_id
      where t.risk_level = 'HIGH'
        and coalesce(t.hitl_policy->>'mode', 'never') = 'never'
    `);
    // shopify.edit_order and returngo.update_transaction were the two that
    // shipped this way: one rewrites a customer's order, the other mutates a
    // refund transaction, both with no human in the loop.
    expect(rows.map((r) => r.tool)).toEqual([]);
  });

  it("customer-visible sends require approval", async () => {
    // The customer receives an email either way. An AI sending one unprompted
    // is not undone by reverting a row.
    const rows = await prisma.$queryRawUnsafe<Array<{ tool: string; mode: string }>>(`
      select c.slug || '.' || t.slug as tool, coalesce(t.hitl_policy->>'mode','never') as mode
      from catalog_tools t join integration_catalog c on c.id = t.integration_id
      where (c.slug, t.slug) in (('shopify','send_invoice'), ('shopify','resend_confirmation'))
    `);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.mode, r.tool).not.toBe("never");
  });

  it("a direct-database INSERT is gated no less than its own UPDATE sibling", async () => {
    // insert_row being autonomous while update_row required approval was an
    // inconsistency rather than a decision.
    const rows = await prisma.$queryRawUnsafe<Array<{ integ: string; op: string; mode: string }>>(`
      select c.slug as integ, t.slug as op, coalesce(t.hitl_policy->>'mode','never') as mode
      from catalog_tools t join integration_catalog c on c.id = t.integration_id
      where c.slug in ('postgresql','mongodb','aws_rds')
        and t.slug in ('insert_row','update_row','insert_document','update_document')
    `);
    const by = new Map(rows.map((r) => [`${r.integ}.${r.op}`, r.mode]));
    for (const [ins, upd] of [
      ["postgresql.insert_row", "postgresql.update_row"],
      ["aws_rds.insert_row", "aws_rds.update_row"],
      ["mongodb.insert_document", "mongodb.update_document"],
    ]) {
      if (!by.has(ins) || !by.has(upd)) continue;
      const gated = (m?: string) => m !== "never";
      if (gated(by.get(upd))) expect(gated(by.get(ins)), ins).toBe(true);
    }
  });

  it("record CREATION stays autonomous - that is the product, not an oversight", async () => {
    // Deliberate counter-assertion: capturing a new lead is the core autonomous
    // value. If someone later gates these wholesale, this test should make them
    // argue for it rather than doing it by reflex.
    const rows = await prisma.$queryRawUnsafe<Array<{ tool: string; mode: string }>>(`
      select c.slug || '.' || t.slug as tool, coalesce(t.hitl_policy->>'mode','never') as mode
      from catalog_tools t join integration_catalog c on c.id = t.integration_id
      where (c.slug, t.slug) in (('hubspot','create_lead'), ('hubspot','create_contact'),
                                 ('salesforce','create_lead'))
    `);
    for (const r of rows) expect(r.mode, r.tool).toBe("never");
  });
});
