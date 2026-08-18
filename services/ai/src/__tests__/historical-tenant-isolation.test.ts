import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Tenant isolation across the historical pipeline.
 *
 * The material this feature handles is a business's entire customer
 * correspondence - two years of it, including whatever their customers happened
 * to type into a chat window. A leak here is not a leak of metadata.
 *
 * Two boundaries have to hold, and they are enforced in different places:
 *
 *   1. **Postgres.** The shared client's tenant guard already refuses any bulk
 *      query on a tenant-scoped model without a tenantId filter, and the new
 *      tables are covered by the same models list. That guard is tested with
 *      the client; what is checked here is that this pipeline never opts OUT of
 *      it via `withCrossTenantAccess`.
 *
 *   2. **Qdrant.** Vectors live outside Postgres and outside the guard
 *      entirely. Nothing stops a search from returning another tenant's points
 *      except the filter written into the query, so every search and every
 *      write is checked for one.
 */

const PIPELINE_DIR = join(__dirname, "..", "services", "historical-intelligence");
const CANDIDATE_INDEX = join(PIPELINE_DIR, "candidate-index.ts");

function pipelineFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(PIPELINE_DIR);
  return out;
}

describe("the vector store is filtered by tenant on every call", () => {
  const src = readFileSync(CANDIDATE_INDEX, "utf8");

  it("filters cluster lookups by tenant AND import", () => {
    // Without the tenant filter, one business's mined questions would cluster
    // into another's, and the review queue would show a stranger's policy.
    const search = src.match(/qdrant\.search\(COLLECTION_NAME, \{([\s\S]*?)\}\);/);
    expect(search, "no qdrant.search found in candidate-index").toBeTruthy();
    expect(search![1]).toContain('key: "tenantId"');
    expect(search![1]).toContain('key: "importId"');
  });

  it("stamps the tenant on every point it writes", () => {
    const upsert = src.match(/qdrant\.upsert\(COLLECTION_NAME, \{([\s\S]*?)\n  \}\);/);
    expect(upsert, "no qdrant.upsert found in candidate-index").toBeTruthy();
    expect(upsert![1]).toContain("tenantId: args.tenantId");
  });

  it("creates the tenant payload index, without which the filter is a slow lie", () => {
    expect(src).toContain('field_name: "tenantId"');
  });

  it("scopes the existing-knowledge probe to this tenant's own bases", () => {
    // The probe reuses `searchSimilar`, which applies the tenant filter itself,
    // and the knowledge-base id list is resolved from this tenant's rows. Both
    // halves matter: the id list alone would leak if a base id were guessed,
    // and the search alone would return this tenant's archived bases.
    const start = src.indexOf("export async function findExistingKnowledge");
    expect(start, "findExistingKnowledge not found").toBeGreaterThan(-1);
    // Sliced to the next top-level export rather than to the first "\n}", which
    // would stop at the end of the argument type literal.
    const nextExport = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, nextExport > -1 ? nextExport : undefined);

    expect(body).toContain("knowledgeBase.findMany");
    expect(body).toMatch(/tenantId: args\.tenantId/);
    expect(body).toContain("searchSimilar(args.tenantId");
  });

  it("scopes a cluster deletion to one tenant and one import", () => {
    const drop = src.match(/export async function dropImportClusters\(([\s\S]*?)\n\}/);
    expect(drop).toBeTruthy();
    expect(drop![1]).toContain('key: "tenantId"');
    expect(drop![1]).toContain('key: "importId"');
  });

  it("uses a collection of its own, separate from the live knowledge base", () => {
    // An unapproved candidate landing in `knowledge_chunks` would be retrieved
    // by the AI mid-conversation - the exact silent promotion this feature
    // exists to prevent.
    expect(src).toContain('const COLLECTION_NAME = "historical_knowledge_candidates"');
  });
});

describe("the pipeline never disables the Postgres tenant guard", () => {
  const files = pipelineFiles();

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it("never calls withCrossTenantAccess", () => {
    // `withHistoricalRecords` widens the ORIGIN filter and nothing else. The
    // tenant guard is a different mechanism and this pipeline has no business
    // switching it off.
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\n");
      expect(code, `${file} must not disable the tenant guard`).not.toContain(
        "withCrossTenantAccess",
      );
    }
  });

  it("passes a tenantId into every Prisma query it makes", () => {
    // The guard would throw at runtime on a missing tenantId, which is the real
    // backstop. This catches it at test time instead of on a customer's import.
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const queries = src.match(/prisma\.\w+\.(findMany|findFirst|count|aggregate|groupBy|updateMany|deleteMany)\(\{[\s\S]{0,400}?\}\)/g);
      for (const q of queries ?? []) {
        // `historicalImportEvent` and `historicalImportChunk` are reached only
        // through an importId that was itself resolved under a tenant filter,
        // and neither model carries a tenantId column on every path.
        if (/historicalImportEvent|historicalImportChunk/.test(q)) continue;
        expect(q, `${file}: query without a tenant filter:\n${q}`).toMatch(/tenantId/);
      }
    }
  });
});

describe("evidence stays with its tenant", () => {
  it("stamps the tenant on every evidence row written", () => {
    const extraction = readFileSync(join(PIPELINE_DIR, "knowledge-extraction.stage.ts"), "utf8");
    const evidence = extraction.match(/knowledgeCandidateEvidence\.create\(\{([\s\S]*?)\n  \}\);/);
    expect(evidence).toBeTruthy();
    expect(evidence![1]).toContain("tenantId");
  });
});
