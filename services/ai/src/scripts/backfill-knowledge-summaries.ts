/**
 * One-off, idempotent backfill: give existing knowledge documents their stored
 * summary (B3, 2026-10-12). New and updated documents get one when processed;
 * this covers the ones processed before that existed.
 *
 * Usage (inside the ai container, from services/ai):
 *   npx tsx src/scripts/backfill-knowledge-summaries.ts <tenantId>           # dry run: counts only
 *   npx tsx src/scripts/backfill-knowledge-summaries.ts <tenantId> --apply   # writes
 *
 * One tenant per run, always named. Only READY documents. A document whose
 * summary is fresh is skipped without a model call, so a re-run costs nothing.
 */
import { prisma } from "@chatcenter/shared";
import { initAIService } from "../services/ai.service";
import { ensureDocumentSummary, summaryOf } from "../services/knowledge-summary.service";

async function main() {
  const tenantId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!tenantId || tenantId.startsWith("--")) throw new Error("tenantId is required");
  if (apply) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    initAIService({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
      defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
    });
  }

  const docs = await prisma.knowledgeDocument.findMany({
    where: { tenantId, status: "ready" },
    select: { id: true, title: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });
  const without = docs.filter((d) => !summaryOf(d.metadata));
  console.log(`[backfill-summaries] tenant=${tenantId} ready=${docs.length} without_summary=${without.length} apply=${apply}`);
  if (!apply) { process.exit(0); }

  const counts: Record<string, number> = {};
  for (const d of docs) {
    const r = await ensureDocumentSummary(d.id);
    counts[r] = (counts[r] ?? 0) + 1;
    console.log(`  ${r.padEnd(7)} ${d.id} ${d.title.slice(0, 60)}`);
  }
  console.log(`[backfill-summaries] done ${JSON.stringify(counts)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-summaries] failed:", err?.message ?? err);
  process.exit(1);
});
