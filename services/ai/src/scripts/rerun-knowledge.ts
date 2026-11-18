/**
 * The knowledge-only rerun of a settled import, then (optionally) the auto-approve step (2026-11-18, Smoovee).
 *
 *   npx tsx src/scripts/rerun-knowledge.ts --import <id> --dry                 counts only, writes nothing
 *   npx tsx src/scripts/rerun-knowledge.ts --import <id>                       rerun the knowledge (WRITES)
 *   npx tsx src/scripts/rerun-knowledge.ts --import <id> --auto-approve        rerun, then auto-approve (WRITES)
 *   npx tsx src/scripts/rerun-knowledge.ts --import <id> --auto-approve --no-rerun   auto-approve only (WRITES)
 *
 * The rerun deletes and re-creates only the import's PENDING candidates and their vectors; it runs extraction,
 * clustering, dedupe, curation and the review only: no customer memories, brand voice, analytics or email.
 * Auto-approve approves through the bulk-approve path (a knowledge document each, the duplicate check, the
 * embedding, the audit; decidedBy "auto"). The console prints counts only. On prod only on Omer's word.
 */
import { prisma } from "@chatcenter/shared";
import { initAIService } from "../services/ai.service";
import { rerunKnowledgeOnly } from "../services/historical-intelligence/knowledge-rerun";
import { autoApproveImport } from "../services/historical-intelligence/approve";

export function parseRerunArgs(argv: string[]): { importId: string; dry: boolean; autoApprove: boolean; rerun: boolean } {
  const i = argv.indexOf("--import");
  const importId = i >= 0 ? String(argv[i + 1] ?? "").trim() : "";
  if (!importId) throw new Error("usage: rerun-knowledge.ts --import <id> [--dry] [--auto-approve] [--no-rerun]");
  const rerun = !argv.includes("--no-rerun");
  const autoApprove = argv.includes("--auto-approve");
  if (!rerun && !autoApprove) throw new Error("--no-rerun without --auto-approve does nothing");
  return { importId, dry: argv.includes("--dry"), autoApprove, rerun };
}

async function main(): Promise<void> {
  const a = parseRerunArgs(process.argv.slice(2));
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });
  const imp = await prisma.historicalImport.findUnique({ where: { id: a.importId }, select: { id: true, tenantId: true } });
  if (!imp) throw new Error(`import ${a.importId} not found`);
  if (a.rerun) {
    const r = await rerunKnowledgeOnly({ tenantId: imp.tenantId, importId: imp.id, dryRun: a.dry });
    console.log(`[rerun-knowledge] ${JSON.stringify(r)}`);
    if (!r.ok) throw new Error(r.reason ?? "rerun refused");
  }
  if (a.autoApprove) {
    const r = await autoApproveImport({ tenantId: imp.tenantId, importId: imp.id, dryRun: a.dry, force: true });
    console.log(`[auto-approve] ${JSON.stringify({ ...r, ids: r.ids.length })}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[rerun-knowledge] failed:", err?.message ?? err); process.exit(1); });
}
