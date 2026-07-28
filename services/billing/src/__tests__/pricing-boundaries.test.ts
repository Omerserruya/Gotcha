import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The boundaries this round must not leak across, asserted against the source
 * rather than trusted to review.
 *
 * Layer A (actual tokens, provider cost, margin) is Sysadmin-only.
 * Layer B (the public commercial estimate) is manually configured and never
 * derived from layer A.
 * Layer C (the credit ledger) is the source of truth for balances and is never
 * written by a pricing change.
 */

// __dirname rather than import.meta.url: this package compiles as CommonJS, so
// import.meta fails `tsc --noEmit` even though vitest resolves it fine.
const SRC = join(__dirname, "..");
const SHARED = join(SRC, "../../../packages/shared/src");
const read = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("layer B never reads layer A", () => {
  const estimation = read(join(SHARED, "lib/billing/estimation.ts"));

  it("the estimation engine does not import the usage aggregate", () => {
    expect(estimation).not.toContain("conversation-usage");
    expect(estimation).not.toContain("conversationUsageAggregate");
  });

  it("the estimation engine does not read UsageLog or the cost engine", () => {
    expect(estimation).not.toContain("usageLog");
    expect(estimation).not.toContain("billableModel");
    expect(estimation).not.toContain("unitPricingConfig");
    expect(estimation).not.toContain("priceUsageFromDb");
  });

  it("its only DB reads are the manual estimation config", () => {
    const reads = [...estimation.matchAll(/prisma\.(\w+)\./g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["publicEstimationConfig"]));
  });

  it("the documented fallback is a constant, not an analytics lookup", () => {
    expect(estimation).toMatch(/FALLBACK_ESTIMATION[\s\S]{0,200}chatCreditsPerEstimatedConversation:\s*8/);
  });
});

describe("changing a public estimate never touches money", () => {
  const admin = read(join(SRC, "routes/admin-pricing.ts"));
  // The estimation publish handler, isolated from the rest of the router.
  const publishBlock = admin.slice(
    admin.indexOf('router.post("/admin/pricing/estimation"'),
    admin.indexOf('// ── Credit packages'),
  );

  it("writes only the estimation config", () => {
    expect(publishBlock).toContain("publicEstimationConfig.create");
    for (const forbidden of ["aiUnitLot", "aiUnitLedgerEntry", "tenantAiBalance", "invoice.", "charge.", "grantUnits", "consumeUnits"]) {
      expect(publishBlock, `estimation publish must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("does not rewrite existing subscriptions", () => {
    expect(publishBlock).not.toContain("subscription.update");
    expect(publishBlock).not.toContain("subscription.updateMany");
  });

  it("does not mutate a plan version", () => {
    expect(publishBlock).not.toContain("plan.update");
  });
});

describe("actual usage analytics cannot publish an estimate", () => {
  const analytics = read(join(SRC, "routes/admin-analytics.ts"));

  it("the analytics router never creates an estimation config", () => {
    expect(analytics).not.toContain("publicEstimationConfig.create");
    expect(analytics).not.toContain("publishEstimation");
  });

  it("the comparison is explicitly advisory", () => {
    expect(analytics).toContain("guarantee");
    expect(analytics).toMatch(/advisory/i);
  });

  it("compareEstimateToActual hardcodes autoApplied to false", () => {
    const usage = read(join(SHARED, "lib/billing/conversation-usage.ts"));
    expect(usage).toMatch(/autoApplied:\s*false/);
    expect(usage).toMatch(/autoApplied:\s*false;/); // and the TYPE is the literal
  });
});

describe("tenant-facing routes never expose internal usage", () => {
  // Customer-facing billing routes. The admin-* routers are platform tier.
  const customerRoutes = ["routes/pricing.ts", "routes/credits.ts", "routes/subscription.ts", "routes/invoices.ts"]
    .map((p) => ({ path: p, src: read(join(SRC, p)) }));

  it.each(customerRoutes.map((r) => [r.path, r.src] as const))(
    "%s does not read token or provider-cost fields",
    (_path, src) => {
      for (const forbidden of [
        "promptTokens", "completionTokens", "totalInputTokens", "totalOutputTokens",
        "costUsd", "modelCostUsd", "marginFactor", "unitCostBasisUsd",
        "billableModel", "unitPricingConfig", "conversationUsageAggregate",
        "getUsageStats", "getStatsByTenant",
      ]) {
        expect(src, `${_path} must not surface ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it("the customer credit contract speaks credits, not tokens", () => {
    const credits = read(join(SRC, "routes/credits.ts"));
    // "tokens" may appear only in a comment explaining the boundary.
    const code = credits.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\btoken/i);
  });

  it("the pricing catalog service exposes no cost data", () => {
    const svc = read(join(SRC, "services/pricing.service.ts"));
    const code = svc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of ["costUsd", "promptTokens", "marginFactor", "unitCostBasis"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe("platform routes are gated by the platform tier, not tenant admin", () => {
  const adminFiles = ["routes/admin-pricing.ts", "routes/admin-analytics.ts"].map((p) => ({
    path: p,
    src: read(join(SRC, p)),
  }));

  it.each(adminFiles.map((f) => [f.path, f.src] as const))("%s gates every route", (_path, src) => {
    const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"([\s\S]{0,400}?)async/g)];
    expect(routes.length).toBeGreaterThan(0);
    for (const [, method, path, middleware] of routes) {
      expect(middleware, `${method.toUpperCase()} ${path} must declare a platform permission`).toContain(
        "requirePlatformPermission",
      );
    }
  });

  it.each(adminFiles.map((f) => [f.path, f.src] as const))(
    "%s never uses a tenant permission gate",
    (_path, src) => {
      expect(src).not.toContain("requirePermission(");
      expect(src).not.toContain("requireRole(");
    },
  );

  it("customer pricing routes are tenant-scoped, never platform-gated", () => {
    const pricing = read(join(SRC, "routes/pricing.ts"));
    expect(pricing).not.toContain("requirePlatformPermission");
    expect(pricing).toContain("resolveTenant");
  });
});

describe("the credit ledger has exactly one writer", () => {
  it("only the wallet creates lots and ledger entries", () => {
    const offenders: string[] = [];
    for (const file of [...walk(join(SRC)), ...walk(join(SHARED, "lib"))]) {
      if (file.endsWith("wallet.ts")) continue; // the one legitimate writer
      const src = read(file).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (/aiUnitLot\.(create|update|updateMany|delete)/.test(src)) offenders.push(`${file}: aiUnitLot write`);
      if (/aiUnitLedgerEntry\.(create|update|delete)/.test(src)) offenders.push(`${file}: ledger write`);
      if (/tenantAiBalance\.(upsert|update|create)/.test(src)) offenders.push(`${file}: balance write`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * One allowance, three rows that describe it.
 *
 * `plans.included_ai_units` is the total. `config:credit_split` says how it is
 * presented per channel and `limit:included_ai_units` is what the entitlement
 * resolver reads. Only the first is what the plan editor asks for - and only
 * the SPLIT is what quoteFor() totals into what a subscriber is sold and
 * granted. They were written once at seed time and cloned forward, so an edited
 * plan kept selling 2,000 credits no matter what a sysadmin typed.
 */
describe("a plan's credit allowance cannot disagree with itself", () => {
  const admin = read(join(SRC, "routes/admin-pricing.ts"));
  const pricing = read(join(SRC, "services/pricing.service.ts"));

  it("every route that writes an allowance rewrites the rows that describe it", () => {
    // Each `includedAiUnits:` write must be followed by a syncCreditRows call
    // before the next one, or that route leaves a stale split behind.
    // `includedAiUnits: number` is a type annotation, not a write.
    const writes = [...admin.matchAll(/includedAiUnits: (?!number)/g)].map((m) => m.index ?? 0);
    const syncs = [...admin.matchAll(/syncCreditRows\(/g)].map((m) => m.index ?? 0);
    const unsynced = writes.filter((at) => !syncs.some((s) => s > at && s - at < 4000));
    expect(unsynced, "an allowance is written with no syncCreditRows after it").toEqual([]);
  });

  it("the split can never be the only place the allowance lives", () => {
    // The read side reconciles too, so rows that drifted before this fix
    // behave correctly without a migration.
    expect(pricing).toContain("const total = Math.max(0, Number(plan.includedAiUnits ?? 0) || 0)");
    expect(pricing).toMatch(/if \(chat \+ voice === total\) return \{ chat, voice \}/);
  });

  it("quoting still totals the split, so the reconciliation is what protects it", () => {
    // If this stops being true the guarantee moves and these tests should move
    // with it - not be deleted.
    expect(pricing).toContain("includedCredits: chatCredits + voiceCredits");
  });
});
