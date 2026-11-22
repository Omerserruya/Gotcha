/**
 * The "customer is waiting" alert never fires for a hidden conversation (2026-11-22). The rule is written
 * into findWaiting's SQL; this holds that SQL to the one rule (packages/shared relevance-hidden.ts):
 * the same five labels, a person's mark on any account, a classifier label from 0.7 on an account whose
 * filter is on. The SQL itself was checked on Postgres with EXPLAIN (see the commit).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_HIDDEN_CATEGORIES, HIDDEN_CONFIDENCE } from "@chatcenter/shared/src/lib/relevance-hidden";
import { WAITING_HIDDEN_SQL_CATEGORIES } from "../services/waiting-alert.service";

const source = readFileSync(join(__dirname, "../services/waiting-alert.service.ts"), "utf8");
const sql = source.slice(source.indexOf("export async function findWaiting"), source.indexOf("LIMIT 2000"));

describe("findWaiting leaves hidden conversations out", () => {
  it("the SQL's labels are the rule's labels", () => {
    expect([...WAITING_HIDDEN_SQL_CATEGORIES].sort()).toEqual([...AUTOMATION_HIDDEN_CATEGORIES].sort());
    const listed = sql.match(/COALESCE\(c\.relevance_category, ''\) IN \(([^)]*)\)/)?.[1] ?? "";
    expect(listed.split(",").map((s) => s.trim().replace(/'/g, "")).sort()).toEqual([...AUTOMATION_HIDDEN_CATEGORIES].sort());
  });

  it("a person's mark hides on any account; a classifier label from the threshold, unless the account's filter is off", () => {
    const clause = sql.slice(sql.indexOf("AND NOT ("));
    expect(clause).toMatch(/c\.relevance_overridden_by IS NOT NULL\s+OR \(/);
    expect(clause).toContain(`COALESCE(c.relevance_confidence, 0)::float8 >= ${HIDDEN_CONFIDENCE}`);
    expect(clause).toContain("AND NOT EXISTS (SELECT 1 FROM channel_accounts ca WHERE ca.id = c.channel_account_id AND ca.relevance_filter_enabled = false)");
  });
});
