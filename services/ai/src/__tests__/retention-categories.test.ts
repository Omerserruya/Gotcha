import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * The list of retention categories lives in four places. They must agree.
 *
 *   1. `DEFAULTABLE_CATEGORIES` and the `purgeCategory` switch, here in
 *      services/ai - what the engine can actually delete.
 *   2. An allowlist in services/auth `routes/gdpr.ts` - what an admin is
 *      permitted to configure a policy for.
 *   3. A comment on `DataRetentionPolicy.category` in the schema.
 *
 * A category in one and not the other is INERT, and inert in a way that reads
 * as working: the settings page offers a retention policy the engine cannot
 * honour, or the engine grows a capability the API refuses to configure. Either
 * way a tenant is told their data is being aged out and it is not - which is
 * the specific promise GDPR Art. 5(1)(e) makes enforceable.
 *
 * Read from source rather than imported because the two live in different
 * services with no shared module between them; importing services/auth from a
 * services/ai test would be a worse coupling than parsing a literal.
 */

const AI = join(__dirname, "..", "services", "retention-purge.service.ts");
const AUTH = join(__dirname, "..", "..", "..", "auth", "src", "routes", "gdpr.ts");

function engineCategories(): string[] {
  const src = readFileSync(AI, "utf-8");
  const block = src.slice(
    src.indexOf("const DEFAULTABLE_CATEGORIES"),
    src.indexOf("] as const;", src.indexOf("const DEFAULTABLE_CATEGORIES")),
  );
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function purgeableCategories(): string[] {
  const src = readFileSync(AI, "utf-8");
  const fn = src.slice(
    src.indexOf("async function purgeCategory"),
    src.indexOf("const DEFAULTABLE_CATEGORIES"),
  );
  return [...fn.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]);
}

function apiAllowlist(): string[] {
  const src = readFileSync(AUTH, "utf-8");
  const line = src.split("\n").find((l) => l.includes("const allowed = new Set(["))!;
  return [...line.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("retention categories agree across services", () => {
  it("each list is non-empty - a parse failure must not pass silently", () => {
    expect(engineCategories().length).toBeGreaterThan(0);
    expect(purgeableCategories().length).toBeGreaterThan(0);
    expect(apiAllowlist().length).toBeGreaterThan(0);
  });

  it("everything the API accepts, the engine can actually purge", () => {
    const purgeable = new Set(purgeableCategories());
    for (const c of apiAllowlist()) {
      expect(
        purgeable.has(c),
        `gdpr.ts accepts a policy for "${c}" but purgeCategory has no case for it - ` +
          `an admin can configure retention that will never run`,
      ).toBe(true);
    }
  });

  it("everything the engine purges, an admin can configure", () => {
    const allowed = new Set(apiAllowlist());
    for (const c of purgeableCategories()) {
      expect(
        allowed.has(c),
        `purgeCategory handles "${c}" but gdpr.ts rejects it - the capability exists ` +
          `and nobody can reach it`,
      ).toBe(true);
    }
  });

  it("every defaultable category is purgeable", () => {
    // These are applied to tenants with NO policy row, so a category here with
    // no switch case throws inside the purge loop for every such tenant.
    const purgeable = new Set(purgeableCategories());
    for (const c of engineCategories()) {
      expect(purgeable.has(c), `"${c}" is defaultable but not purgeable`).toBe(true);
    }
  });

  it("covers the reasoning artefacts the product actually writes", () => {
    // The audit found agent_loop_runs/iterations growing with nothing deleting
    // them: 2,173 iterations across 492 runs in four days on dev alone.
    expect(purgeableCategories()).toContain("agent_loop_runs");
  });

  it("does NOT expose agent_loop_iterations separately", () => {
    // Iterations cascade off runs. A separate category would let someone purge
    // half a trace, leaving runs whose reasoning is gone - worse than either
    // keeping or deleting the whole thing.
    expect(purgeableCategories()).not.toContain("agent_loop_iterations");
    expect(apiAllowlist()).not.toContain("agent_loop_iterations");
  });
});
