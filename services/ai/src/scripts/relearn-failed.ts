/**
 * Re-learn Smoovee's customers whose memory was dropped by the old schema
 * (off-list category, more than 8 facts). Prod only, on Omer's word.
 *
 * Run INSIDE the ai container, from /app/services/ai, at this path
 * (src/scripts/relearn-failed.ts), so it uses that container's code and env:
 *   npx tsx src/scripts/relearn-failed.ts            dry run
 *   APPLY=1 npx tsx src/scripts/relearn-failed.ts    reset and re-learn
 *
 * It does not touch the import's status or its other stages: it resets the
 * FAILED rows to PENDING and calls the customer-learning stage directly until
 * none are pending. The stage enqueues nothing (index.ts does that), so no
 * knowledge stage runs again.
 *
 * 2026-11-14, first prod run: every call failed with "[aiService] Not
 * initialized". A standalone process does not run services/ai's index.ts, which
 * is what calls initAIService; the stage swallowed the error per customer and
 * put all 9 rows back to FAILED (nothing spent). This script now initialises
 * the AI service exactly as index.ts does, from the same env, before anything
 * else, and stops after a round that learned nothing.
 */
import { prisma, historicalIntelligenceQueue, withHistoricalRecords } from "@chatcenter/shared";
import { initAIService, getDefaultModel } from "../services/ai.service";
import * as stage from "../services/historical-intelligence/customer-learning.stage";

export const IMPORT_ID = "cmweqwb6y00ipkdj30mmzm9rt";
export const TENANT_ID = "cmw7mzuo2004cnwkxrz960vgv";
const ERROR = "no schema-valid model output";
/** About 0.4 units a call, two calls at worst; a wide margin on top. */
const UNITS_PER_ROW = 2;

export class Stop extends Error {}
function stop(msg: string): never {
  throw new Stop(msg);
}

/** services/ai/src/index.ts, the "Initialize central AI service" block, verbatim in its arguments. */
export function initAsTheAiProcess(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.OPENAI_API_KEY) stop("OPENAI_API_KEY is not set: run this inside the ai container");
  initAIService({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || undefined,
    defaultModel: env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: env.EMBEDDING_MODEL || undefined,
  });
}

export async function relearn(opts: { apply: boolean; log?: (s: string) => void }): Promise<{ before: number; after: Record<string, number> } | null> {
  const log = opts.log ?? console.log;
  if (!("FACT_CATEGORIES" in stage) || !("cutAtWord" in stage)) stop("the memory fix is not in this container's code");

  initAsTheAiProcess();
  log(`ai service initialised (model ${getDefaultModel()}, micro ${process.env.OPENAI_MICRO_MODEL || "gpt-5-nano"})`);

  const imp = await prisma.historicalImport.findFirst({ where: { id: IMPORT_ID }, select: { tenantId: true, status: true } });
  if (!imp) stop("import not found");
  if (imp.tenantId !== TENANT_ID) stop("tenant does not match");
  if (!["REVIEW_READY", "COMPLETED"].includes(imp.status)) stop(`import is ${imp.status}; run only once it has settled`);

  const failed = await prisma.historicalCustomer.count({ where: { importId: IMPORT_ID, tenantId: TENANT_ID, learningStatus: "FAILED", learningError: ERROR } });
  const pending = await prisma.historicalCustomer.count({ where: { importId: IMPORT_ID, tenantId: TENANT_ID, learningStatus: "PENDING" } });
  if (pending > 0) stop(`${pending} rows already PENDING; something else is learning`);

  const jobs = await historicalIntelligenceQueue.getJobs(["active", "waiting", "delayed"]);
  if (jobs.some((j: any) => j?.data?.importId === IMPORT_ID)) stop("a historical-intelligence job for this import is queued or running");

  const lots = await prisma.aiUnitLot.findMany({
    where: { tenantId: TENANT_ID, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { unitsRemaining: true },
  });
  const units = lots.reduce((s: number, l: any) => s + Number(l.unitsRemaining), 0);
  log(`import ${imp.status}; FAILED rows to re-learn: ${failed}; units available: ${units}`);
  if (units < failed * UNITS_PER_ROW) stop(`units ${units} below ${failed * UNITS_PER_ROW}`);
  if (failed === 0) { log("nothing to do"); return null; }
  if (!opts.apply) { log("dry run: set APPLY=1 to reset and re-learn"); return null; }

  const reset = await prisma.historicalCustomer.updateMany({
    where: { importId: IMPORT_ID, tenantId: TENANT_ID, learningStatus: "FAILED", learningError: ERROR },
    data: { learningStatus: "PENDING", learningError: null },
  });
  log(`reset ${reset.count} rows to PENDING`);

  for (let round = 0; round < 10; round++) {
    const r = await stage.runCustomerLearningStage({ tenantId: TENANT_ID, importId: IMPORT_ID });
    log(`round ${round + 1}: ${JSON.stringify(r.detail ?? {})}`);
    // A round where every call failed means the calls themselves are broken
    // (as on the first prod run); more rounds would only repeat it.
    const d: any = r.detail ?? {};
    if (!d.learned && !d.skipped && d.failed) stop(`round ${round + 1} learned nothing and failed ${d.failed}: see the warnings above; the rows are FAILED again`);
    if (r.done) break;
  }

  const groups = await prisma.historicalCustomer.groupBy({
    by: ["learningStatus"], where: { importId: IMPORT_ID, tenantId: TENANT_ID }, _count: true,
  });
  const after = Object.fromEntries(groups.map((g: any) => [g.learningStatus, g._count]));
  log(`after: ${Object.entries(after).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return { before: failed, after };
}

if (require.main === module) {
  withHistoricalRecords(() => relearn({ apply: process.env.APPLY === "1" }))
    .then(async () => { await prisma.$disconnect(); await historicalIntelligenceQueue.close(); process.exit(0); })
    .catch(async (e) => {
      console.error(e instanceof Stop ? `STOP: ${e.message}` : (e?.message ?? e));
      await prisma.$disconnect().catch(() => {});
      await historicalIntelligenceQueue.close().catch(() => {});
      process.exit(e instanceof Stop ? 2 : 1);
    });
}
