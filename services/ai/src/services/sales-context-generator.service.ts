/**
 * Sales Context generator — auto-fills an AI Employee's Product Qualification
 * Context (`agent.salesContext`) at the end of the creation wizard, so the admin
 * never starts from six blank fields.
 *
 * Source of truth, in priority order:
 *   1. The tenant's onboarding `BusinessProfile` (what the company does/sells) —
 *      via getCompanyContext(). This is the universal anchor.
 *   2. The agent's own role + goal (and funnel, if sales-oriented).
 *   3. The titles of the knowledge bases attached to the agent (hints at the
 *      product surface area the employee was trained on).
 *
 * An LLM turns that into the six structured fields. The result is NORMALIZED and
 * only PROPOSED — the admin can edit every field afterward in the editor. This is
 * best-effort: any failure returns null and the wizard completes unchanged.
 *
 * Layers under per-agent `salesContext` semantics — see company-context.service.ts
 * and prompt-builder.service.ts (buildSalesContextBlock).
 */

import { prisma } from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "./ai.service";
import { getCompanyContext } from "./company-context.service";

export interface SalesContext {
  whatWeSell?: string;
  idealCustomerProfile?: string;
  problemsSolved?: string[];
  expectedOutcomes?: string[];
  qualificationSignals?: string[];
  disqualifiers?: string[];
}

/** Trim/clean the model output into the canonical salesContext shape, dropping
 *  empties. Returns null when nothing usable was produced (so callers skip the
 *  write and leave the fields blank rather than store an empty object). */
function normalize(raw: unknown): SalesContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string" && !!x.trim())
          .map((s) => s.trim())
          .slice(0, 8)
      : [];

  const out: SalesContext = {};
  const whatWeSell = str(r.whatWeSell);
  const idealCustomerProfile = str(r.idealCustomerProfile);
  const problemsSolved = list(r.problemsSolved);
  const expectedOutcomes = list(r.expectedOutcomes);
  const qualificationSignals = list(r.qualificationSignals);
  const disqualifiers = list(r.disqualifiers);

  if (whatWeSell) out.whatWeSell = whatWeSell;
  if (idealCustomerProfile) out.idealCustomerProfile = idealCustomerProfile;
  if (problemsSolved.length) out.problemsSolved = problemsSolved;
  if (expectedOutcomes.length) out.expectedOutcomes = expectedOutcomes;
  if (qualificationSignals.length) out.qualificationSignals = qualificationSignals;
  if (disqualifiers.length) out.disqualifiers = disqualifiers;

  return Object.keys(out).length ? out : null;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

/**
 * Generate a salesContext object for an agent from company + agent context.
 * Returns null on any failure or when there is not enough signal — the caller
 * decides whether to persist. Never throws.
 */
export async function generateSalesContext(
  tenantId: string,
  agentId: string,
): Promise<SalesContext | null> {
  try {
    const agent: any = await prisma.aIAgent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true, role: true, goal: true, identity: true },
    });
    if (!agent) return null;

    const [company, kbLinks] = await Promise.all([
      getCompanyContext(tenantId),
      prisma.aIAgentKnowledge.findMany({
        where: { aiAgentId: agentId },
        select: { knowledgeBase: { select: { name: true } } },
        take: 20,
      }),
    ]);

    // Need at least SOMETHING to ground on — a company description or a goal.
    // Otherwise the model would invent a generic offer, which is worse than blank.
    const companyDesc = company?.businessDescription?.trim();
    if (!companyDesc && !agent.goal?.trim() && !company?.organizationName) return null;

    const kbNames = kbLinks
      .map((k: any) => k.knowledgeBase?.name)
      .filter((n: any): n is string => typeof n === "string" && !!n.trim());

    const identity = (agent.identity && typeof agent.identity === "object" ? agent.identity : {}) as any;

    const contextLines = [
      company?.organizationName ? `Company: ${company.organizationName}` : null,
      company?.industry ? `Industry: ${company.industry}` : null,
      companyDesc ? `What the company does: ${companyDesc}` : null,
      company?.websiteDomain ? `Website: ${company.websiteDomain}` : null,
      `AI employee role: ${agent.role || "customer_support"}`,
      agent.goal?.trim() ? `AI employee goal: ${agent.goal.trim()}` : null,
      identity.responsibility ? `Responsibility: ${identity.responsibility}` : null,
      kbNames.length ? `Knowledge it was given: ${kbNames.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const system = [
      "You write the SALES CONTEXT for a company's AI employee — the offer and qualification frame it uses to size up prospects.",
      "Ground everything STRICTLY in the company details provided. Do NOT invent products, markets, or claims that aren't implied by them.",
      "Write in the SAME LANGUAGE as the company description.",
      "Be concrete and specific to THIS company — avoid generic SaaS boilerplate.",
      "",
      "Respond ONLY with a JSON object (no prose, no code fences) with EXACTLY these keys:",
      '  "whatWeSell": string — 1-3 sentences naming the actual product/offer and who it is for.',
      '  "idealCustomerProfile": string — 1-2 sentences describing the best-fit customer.',
      '  "problemsSolved": string[] — 3-5 short bullet phrases, one problem each.',
      '  "expectedOutcomes": string[] — 3-5 short bullet phrases, one outcome each.',
      '  "qualificationSignals": string[] — 3-5 short signals that a prospect is a good fit.',
      '  "disqualifiers": string[] — 2-4 short signals that a prospect is NOT a fit.',
      "Omit a key only if the company details give you no honest basis for it.",
    ].join("\n");

    const resp = await generateResponse({
      tenantId,
      model: getDefaultModel(),
      temperature: 0.3,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
      metadata: { type: "sales_context_autofill", aiAgentId: agentId },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Company & employee details:\n${contextLines}\n\nReturn the sales context JSON.` },
      ],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(resp.content ?? ""));
    } catch {
      return null;
    }
    return normalize(parsed);
  } catch (err: any) {
    console.warn("[sales-context-generator] generation failed:", err?.message);
    return null;
  }
}
