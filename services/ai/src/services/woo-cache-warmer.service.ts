/**
 * Keeps the WooCommerce store caches warm OFF the customer's turn (prod replay
 * 7, Tehila: the first search of a process took 13.98s, cold categories plus the
 * catalogue, and timed out at 8s; warm it is 1.0 to 1.5s).
 *
 * At boot (after a short delay) and every 8 minutes (the catalogue is fresh for
 * 10), for every tenant whose reply engine is on (shadow or autonomous) with a
 * CONNECTED WooCommerce store: categories and the whole catalogue, in each
 * language a turn reads. Read-only GETs to the store, one store at a time;
 * a failure is logged and the next tick tries again. The caches are per
 * process, so every ai replica warms its own.
 */
import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { loadConnection } from "./connectors/integration-framework";
import { warmWooCatalog } from "./connectors/woocommerce.adapter";
import { replyEngineMode } from "./reply-engine/flags";

export const WARM_EVERY_MS = 8 * 60_000;
const BOOT_DELAY_MS = 20_000;

export interface WarmDeps {
  tenants?: () => Promise<string[]>;
  load?: typeof loadConnection;
  warm?: typeof warmWooCatalog;
  mode?: typeof replyEngineMode;
}

/** Tenants with a CONNECTED WooCommerce store. */
async function wooTenants(): Promise<string[]> {
  const rows: any[] = await withCrossTenantAccess(() => prisma.tenantIntegration.findMany({
    where: { status: "CONNECTED", integration: { slug: "woocommerce" } },
    select: { tenantId: true },
    distinct: ["tenantId"],
  } as any));
  return rows.map((r) => r.tenantId);
}

/** One pass: warm each engine tenant's store; returns what was warmed (for the log and tests). */
export async function warmWooCachesOnce(deps: WarmDeps = {}): Promise<Array<{ tenantId: string; ok: boolean; ms: number }>> {
  const mode = deps.mode ?? replyEngineMode;
  const ids = (await (deps.tenants ?? wooTenants)().catch(() => [] as string[])).filter((t) => mode(t) !== "off");
  const out: Array<{ tenantId: string; ok: boolean; ms: number }> = [];
  for (const tenantId of ids) {
    try {
      const conn = await (deps.load ?? loadConnection)({ tenantId, slug: "woocommerce" });
      if (!conn) continue;
      const r = await (deps.warm ?? warmWooCatalog)(conn.credentials, conn.config);
      out.push({ tenantId, ...r });
    } catch (err: any) {
      console.warn(`[woo-warm] tenant=${tenantId} failed:`, err?.message ?? err);
      out.push({ tenantId, ok: false, ms: 0 });
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
export function startWooCacheWarmer(): void {
  if (timer || process.env.WOO_CACHE_WARMER === "off") return;
  const tick = () => {
    void warmWooCachesOnce()
      .then((r) => { if (r.length) console.log(`[woo-warm] ${r.map((x) => `${x.tenantId}:${x.ok ? `${x.ms}ms` : "failed"}`).join(" ")}`); })
      .catch((err) => console.warn("[woo-warm] pass failed:", err?.message ?? err));
  };
  setTimeout(tick, BOOT_DELAY_MS).unref?.();
  timer = setInterval(tick, WARM_EVERY_MS);
  timer.unref?.();
}
