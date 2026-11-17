/**
 * Read-only: how long a store search takes, and where (prod replay 6: Tehila's
 * list_products timed out at 8s twice per run). Runs INSIDE the ai container:
 *
 *   npx tsx src/scripts/woo-search-timing.ts --tenant <id> --q "בנדנה" [--q ...] [--lang he] [--runs 2] [--warm] [--compare]
 *   (--compare: each query live first, WOO_LOCAL_SEARCH=off, then from the cached catalogue; request counts per run)
 *
 * For each query it times, through the same adapter path v2 uses (GETs only, no
 * conversation, so no customer guard is involved):
 *   1. list_products {query}            - the full search (store search, retries,
 *                                         category and description fallbacks);
 *   2. the same again                   - the catalogue cache warm (10 min);
 *   3. list_products {query, per_page 5, lang}.
 * Prints ms, the number of products, and the adapter's own [woo-search] lines.
 * Writes nothing. Product names are the store's catalogue, never customer data.
 */
import { withCrossTenantAccess } from "@chatcenter/shared";
import "../services/connectors";
import { executeAdapterTool } from "../services/connectors/integration-framework";

export function parseTimingArgs(argv: string[]): { tenant: string; queries: string[]; lang: string | null; runs: number } {
  const all = (k: string) => argv.flatMap((a, i) => (a === k && argv[i + 1] != null ? [argv[i + 1]] : []));
  const tenant = all("--tenant")[0];
  const queries = all("--q").map((q) => q.trim()).filter(Boolean);
  if (!tenant || !queries.length) throw new Error('usage: --tenant <id> --q "query" [--q ...] [--lang he] [--runs 2]');
  const runs = Number(all("--runs")[0] ?? 2);
  return { tenant, queries, lang: all("--lang")[0] ?? null, runs: Number.isFinite(runs) && runs > 0 ? Math.min(5, Math.floor(runs)) : 2 };
}

async function timed(tenantId: string, args: Record<string, unknown>) {
  const { searchRequestCounts } = await import("../services/connectors/woocommerce.adapter");
  const before = { ...searchRequestCounts };
  const t0 = Date.now();
  const r: any = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_products", args } as any).catch((err: any) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 120) }));
  const ms = Date.now() - t0;
  const n = r?.ok && Array.isArray(r.result) ? r.result.length : null;
  const req = `local=${searchRequestCounts.local - before.local} live=${searchRequestCounts.live - before.live} capped=${searchRequestCounts.capped - before.capped}`;
  return { ms, ok: !!r?.ok, n, reason: r?.ok ? null : String(r?.reason ?? "").slice(0, 80), req };
}

async function main() {
  const a = parseTimingArgs(process.argv.slice(2));
  // Every store request with its ms (path and parameter names only): where a warm search still spends its time.
  process.env.WOO_REQUEST_TRACE = "1";
  await withCrossTenantAccess(async () => {
    // --warm: fill the store caches first, as the server's warmer does (this script is its own process).
    if (process.argv.includes("--warm")) {
      const { warmWooCachesOnce } = await import("../services/woo-cache-warmer.service");
      const w = await warmWooCachesOnce({ tenants: async () => [a.tenant], scope: "all" });
      console.log(`[timing] warmed first: ${w.map((x) => `${x.ok ? `${x.ms}ms` : "failed"}`).join(" ") || "no Woo store"}`);
    }
    // --compare: each query with the store asked live (WOO_LOCAL_SEARCH=off), then from the cached catalogue.
    const modes = process.argv.includes("--compare") ? ["off", "on"] : [process.env.WOO_LOCAL_SEARCH === "off" ? "off" : "on"];
    for (const q of a.queries) {
      console.log(`\n[timing] q="${q}"`);
      for (const mode of modes) {
        process.env.WOO_LOCAL_SEARCH = mode;
        for (let i = 0; i < a.runs; i++) {
          const r = await timed(a.tenant, { query: q });
          console.log(`  local-search=${mode} run ${i + 1}: ${r.ms}ms ok=${r.ok} products=${r.n ?? "-"} requests ${r.req}${r.reason ? ` reason=${r.reason}` : ""}`);
        }
      }
      process.env.WOO_LOCAL_SEARCH = "on";
      const small = await timed(a.tenant, { query: q, per_page: 5, ...(a.lang ? { lang: a.lang } : {}) });
      console.log(`  per_page 5${a.lang ? ` lang=${a.lang}` : ""}: ${small.ms}ms ok=${small.ok} products=${small.n ?? "-"}${small.reason ? ` reason=${small.reason}` : ""}`);
    }
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[timing] failed:", err?.message ?? err); process.exit(1); });
}
