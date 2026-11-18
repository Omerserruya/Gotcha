/**
 * Finish the curation of an existing import without extracting again (2026-11-18: 351 of Smoovee's candidates
 * had no verdict). Curates only candidates still PENDING with no verdict or "unjudged", then rebuilds the review
 * (cross-check and topics). Idempotent: a second run finds nothing left to curate.
 *
 * WRITES to the import's candidates (verdicts, rewrites, drops) and adds events. On prod only on Omer's word.
 *
 *   npx tsx src/scripts/finish-curation.ts --import <id> [--no-review]
 */
import { prisma, withHistoricalRecords } from "@chatcenter/shared";
import { initAIService } from "../services/ai.service";
import { runKnowledgeCurationStage } from "../services/historical-intelligence/knowledge-curation.stage";
import { runKnowledgeReviewStage } from "../services/historical-intelligence/knowledge-review.stage";

export function parseFinishArgs(argv: string[]): { importId: string; review: boolean } {
  const i = argv.indexOf("--import");
  const importId = i >= 0 ? String(argv[i + 1] ?? "").trim() : "";
  if (!importId) throw new Error("usage: finish-curation.ts --import <id> [--no-review]");
  return { importId, review: !argv.includes("--no-review") };
}

async function main(): Promise<void> {
  const args = parseFinishArgs(process.argv.slice(2));
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });
  const imp = await prisma.historicalImport.findUnique({ where: { id: args.importId }, select: { id: true, tenantId: true } });
  if (!imp) throw new Error(`import ${args.importId} not found`);
  await withHistoricalRecords(async () => {
    const curated = await runKnowledgeCurationStage({ tenantId: imp.tenantId, importId: imp.id, onlyUncurated: true });
    console.log(`[finish-curation] ${JSON.stringify(curated.detail ?? {})}`);
    if (args.review) {
      const review = await runKnowledgeReviewStage({ tenantId: imp.tenantId, importId: imp.id });
      console.log(`[finish-curation] review ${JSON.stringify(review.detail ?? {})}`);
    }
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[finish-curation] failed:", err?.message ?? err); process.exit(1); });
}
