/**
 * Read-only: what search_knowledge finds for a question, with scores (prod
 * replay 5: the studio address and a pickup city were "not available" while the
 * documents say them). Runs INSIDE the ai container (its env, its code):
 *
 *   npx tsx src/scripts/knowledge-probe.ts --tenant <id> [--agent <aiAgentId>] [--k 5] --q "איפה הסטודיו" --q "כתובת"
 *
 * For each question it prints:
 *   - the vector hits (score, document title, chunk, the first 120 characters);
 *   - the keyword-fallback hits and the words it searched;
 *   - the merged list v2 now uses, and whether the old path would have dropped
 *     everything as weak (score < KNOWLEDGE_GAP_SCORE).
 * Also whether the business profile has an address. Writes nothing; the embedding
 * calls are billed to the platform. Chunk text is the business's own documents,
 * never customer messages.
 */
import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { initAIService, platformPaidScope } from "../services/ai.service";
import { getCompanyContext } from "../services/company-context.service";
import { retrieveRelevantChunks, lexicalKnowledge, lexicalTerms, mergeKnowledge, knowledgeLimit, documentAddress, KNOWLEDGE_GAP_SCORE } from "../services/knowledge.service";

export function parseProbeArgs(argv: string[]): { tenant: string; agent: string | null; k: number; queries: string[] } {
  const all = (k: string) => argv.flatMap((a, i) => (a === k && argv[i + 1] != null ? [argv[i + 1]] : []));
  const tenant = all("--tenant")[0];
  const queries = all("--q").map((q) => q.trim()).filter(Boolean);
  if (!tenant || !queries.length) throw new Error('usage: --tenant <id> --q "question" [--q ...] [--agent <id>] [--k 5]');
  const k = Number(all("--k")[0] ?? 5);
  return { tenant, agent: all("--agent")[0] ?? null, k: Number.isFinite(k) && k > 0 ? Math.min(20, Math.floor(k)) : 5, queries };
}

const line = (c: any) => `  ${Number(c.score ?? 0).toFixed(3)}  ${String(c.documentTitle ?? "").slice(0, 50)} #${c.chunkIndex}  ${String(c.content ?? "").replace(/\s+/g, " ").slice(0, 120)}`;

async function main() {
  const a = parseProbeArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set: run this inside the ai container");
  initAIService({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined });
  await withCrossTenantAccess(async () => {
    const bp: any = await (prisma as any).businessProfile.findUnique({ where: { tenantId: a.tenant }, select: { address: true } }).catch(() => null);
    const docAddr = await documentAddress(a.tenant, a.agent).catch(() => null);
    // What v2's prompt gets: the profile address (rendered "Address: ..."), else the documents' one.
    const cc = await getCompanyContext(a.tenant).catch(() => null);
    console.log(`[probe] prompt address line: ${cc?.address ? "profile address (Address: ...)" : docAddr ? "documents' address" : "none"}; companyContext=${cc ? "loaded" : "none"}`);
    // The business block exactly as v2's prompt carries it (the business's own details, no customer text).
    const { businessBlock } = await import("../services/reply-engine/prompt");
    const { profileHasStreet } = await import("../services/reply-engine/engine");
    // The channel line here is the probe's own ("-"): the live prompt names the conversation's channel and whether it shows cards.
    console.log(`[probe] v2 business block (channel line: probe placeholder):\n${businessBlock(cc ? { ...cc, documentAddress: profileHasStreet(cc.address) ? null : docAddr } : null)}`);
    console.log(`[probe] tenant=${a.tenant} agent=${a.agent ?? "(tenant-wide)"} businessProfile.address=${bp?.address ? "set" : "empty"} documentAddress=${docAddr ? JSON.stringify(docAddr) : "none"} gap=${KNOWLEDGE_GAP_SCORE}`);
    for (const q of a.queries) {
      const [vector, lexical] = await platformPaidScope.run({ reason: "knowledge_probe" }, () => Promise.all([
        retrieveRelevantChunks(a.tenant, q, a.k, a.agent),
        lexicalKnowledge(a.tenant, q, a.k, a.agent),
      ]));
      const merged = mergeKnowledge(vector, lexical, Math.max(a.k, knowledgeLimit(q)));
      const t = lexicalTerms(q);
      console.log(`\n[probe] q="${q}"`);
      console.log(` vector (${vector.length})${vector.length && vector.every((c) => (c.score ?? 0) < KNOWLEDGE_GAP_SCORE) ? "  ALL WEAK: the old path dropped these" : ""}`);
      for (const c of vector) console.log(line(c));
      console.log(` keyword (${lexical.length}) own=[${t.own.join(", ")}] answer-words=[${t.expanded.join(", ")}]`);
      for (const c of lexical) console.log(line(c));
      console.log(` merged (${merged.length})`);
      for (const c of merged) console.log(line(c));
    }
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[probe] failed:", err?.message ?? err); process.exit(1); });
}
