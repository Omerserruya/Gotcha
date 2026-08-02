/**
 * Tenant isolation for the onboarding → Knowledge Base projection.
 *
 * The projection reads one tenant's discovery and writes documents into that
 * tenant's knowledge base. Everything here exists to prove a document can
 * never land in, or be read from, the wrong tenant - the failure that would
 * leak one customer's shipping policy into another customer's AI employee.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";
import { ensureOnboardingKnowledgeBase, applyProjection } from "../services/onboarding-knowledge.service";
import { projectDiscoveryTopics } from "@chatcenter/shared";

const RUN = `kbiso-${Date.now()}`;
const tenantIds: string[] = [];

async function makeTenant(name: string) {
  const n = `${RUN}-${name}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(t.id);
  return t;
}

const CTX = { language: "en", now: "2026-07-29T00:00:00.000Z" };

const DISCOVERY_A = {
  websiteDomain: "alpha.example.com",
  business: { summary: "Alpha sells telescopes to amateur astronomers worldwide." },
  knowledge: { policies: { returns: "ALPHA-SECRET: 90 day returns, no questions." } },
};
const DISCOVERY_B = {
  websiteDomain: "beta.example.com",
  business: { summary: "Beta runs a chain of vegetarian restaurants in Tel Aviv." },
  knowledge: { policies: { returns: "BETA-SECRET: no returns on prepared food." } },
};

describe("onboarding knowledge projection - tenant isolation", () => {
  let a: { id: string }, b: { id: string };

  beforeAll(async () => {
    a = await makeTenant("alpha");
    b = await makeTenant("beta");
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      await prisma.knowledgeDocument.deleteMany({ where: { tenantId: id } }).catch(() => {});
      await prisma.knowledgeBase.deleteMany({ where: { tenantId: id } }).catch(() => {});
      await prisma.tenant.delete({ where: { id } }).catch(() => {});
    }
  });

  it("creates each tenant's knowledge base under that tenant only", async () => {
    const kbA = await ensureOnboardingKnowledgeBase(prisma, a.id);
    const kbB = await ensureOnboardingKnowledgeBase(prisma, b.id);
    expect(kbA).toBeTruthy();
    expect(kbB).toBeTruthy();
    expect(kbA).not.toBe(kbB);

    const rowA = await prisma.knowledgeBase.findUnique({ where: { id: kbA! }, select: { tenantId: true } });
    const rowB = await prisma.knowledgeBase.findUnique({ where: { id: kbB! }, select: { tenantId: true } });
    expect(rowA!.tenantId).toBe(a.id);
    expect(rowB!.tenantId).toBe(b.id);
  });

  it("is idempotent - a second call reuses the same knowledge base", async () => {
    const first = await ensureOnboardingKnowledgeBase(prisma, a.id);
    const second = await ensureOnboardingKnowledgeBase(prisma, a.id);
    expect(second).toBe(first);
    const count = await prisma.knowledgeBase.count({ where: { tenantId: a.id } });
    expect(count).toBe(1);
  });

  it("writes each tenant's content only into its own documents", async () => {
    // Write through the projection layer with a stub transport, so the test
    // exercises the reconciliation + tenant scoping rather than HTTP.
    const created: Array<{ tenantId: string; body: any }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      // Mirror what services/ai does: persist under the KB's OWN tenant.
      const kbId = decodeURIComponent(String(url).split("/knowledge-bases/")[1].split("/")[0]);
      const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId }, select: { tenantId: true } });
      const doc = await prisma.knowledgeDocument.create({
        data: {
          knowledgeBaseId: kbId,
          tenantId: kb!.tenantId,
          title: body.title,
          content: body.content,
          sourceType: body.sourceType || "text",
          sourceUrl: body.sourceUrl || null,
          metadata: body.metadata,
          status: "ready",
        },
      });
      created.push({ tenantId: kb!.tenantId, body });
      return { ok: true, json: async () => ({ data: { id: doc.id } }) };
    }) as any;

    await applyProjection(
      { prisma, fetchFn: fakeFetch, authHeader: "Bearer test" },
      a.id,
      projectDiscoveryTopics(DISCOVERY_A, {}, CTX),
    );
    await applyProjection(
      { prisma, fetchFn: fakeFetch, authHeader: "Bearer test" },
      b.id,
      projectDiscoveryTopics(DISCOVERY_B, {}, CTX),
    );

    const docsA = await prisma.knowledgeDocument.findMany({ where: { tenantId: a.id }, select: { content: true } });
    const docsB = await prisma.knowledgeDocument.findMany({ where: { tenantId: b.id }, select: { content: true } });

    expect(docsA.length).toBeGreaterThan(0);
    expect(docsB.length).toBeGreaterThan(0);

    const blobA = docsA.map((d) => d.content).join("\n");
    const blobB = docsB.map((d) => d.content).join("\n");

    // The decisive assertion: neither tenant's secret appears in the other's
    // knowledge, in either direction.
    expect(blobA).toContain("ALPHA-SECRET");
    expect(blobA).not.toContain("BETA-SECRET");
    expect(blobB).toContain("BETA-SECRET");
    expect(blobB).not.toContain("ALPHA-SECRET");
    expect(blobA).not.toContain("vegetarian");
    expect(blobB).not.toContain("telescopes");
  });

  it("re-running a tenant's projection does not touch the other tenant", async () => {
    const beforeB = await prisma.knowledgeDocument.count({ where: { tenantId: b.id } });
    const beforeA = await prisma.knowledgeDocument.count({ where: { tenantId: a.id } });

    const noopFetch = (async () => ({ ok: true, json: async () => ({ data: { id: "x" } }) })) as any;
    const report = await applyProjection(
      { prisma, fetchFn: noopFetch, authHeader: "Bearer test" },
      a.id,
      projectDiscoveryTopics(DISCOVERY_A, {}, CTX),
    );

    // Everything already matched, so nothing was written for A either.
    expect(report.added).toBe(0);
    expect(report.unchanged).toBeGreaterThan(0);
    expect(await prisma.knowledgeDocument.count({ where: { tenantId: b.id } })).toBe(beforeB);
    expect(await prisma.knowledgeDocument.count({ where: { tenantId: a.id } })).toBe(beforeA);
  });

  it("never writes a tenant id into the document metadata", async () => {
    const docs = await prisma.knowledgeDocument.findMany({
      where: { tenantId: a.id },
      select: { metadata: true },
    });
    const blob = JSON.stringify(docs.map((d) => d.metadata));
    expect(blob).not.toContain(a.id);
    expect(blob).not.toContain(b.id);
    expect(blob).not.toMatch(/tenantId/i);
  });

  it("returns no knowledge base for a tenant that does not exist", async () => {
    // A deleted tenant must not cause a knowledge base to be conjured for it.
    const ghost = `${RUN}-ghost-does-not-exist`;
    const kb = await ensureOnboardingKnowledgeBase(prisma, ghost);
    expect(kb).toBeNull();
    const leaked = await prisma.knowledgeBase.count({ where: { tenantId: ghost } });
    expect(leaked).toBe(0);
  });
});
