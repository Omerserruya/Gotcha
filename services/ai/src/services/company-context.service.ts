/**
 * Company Context - the employer identity every agent inherits from its tenant.
 *
 * An AI employee must know WHO it works for and WHAT that company does/sells,
 * in EVERY conversation, without per-agent authoring. Previously the prompt only
 * rendered the agent's own name + role ("You are דניאל, a sales representative"),
 * so the agent did generic discovery ("tell me about your business") instead of
 * representing the company. This reads the tenant's onboarding `BusinessProfile`
 * (organizationName, businessDescription, industry, website) - already captured -
 * and exposes it for a stable, cache-safe `# Company` prompt block.
 *
 * Per-agent `salesContext` (what we sell / ICP / qualification) layers ON TOP of
 * this for sales-oriented skills; company context is the universal base.
 */

import { prisma } from "@chatcenter/shared";

export interface CompanyContext {
  organizationName: string;
  businessDescription?: string | null;
  industry?: string | null;
  websiteDomain?: string | null;
}

/**
 * Load the tenant's company context from its BusinessProfile. Returns null when
 * no profile exists or it has no organization name. Never throws - on error the
 * agent simply runs without the company block (degrades, doesn't break).
 */
export async function getCompanyContext(tenantId: string): Promise<CompanyContext | null> {
  try {
    const bp: any = await (prisma as any).businessProfile.findUnique({
      where: { tenantId },
      select: {
        organizationName: true,
        businessDescription: true,
        industry: true,
        websiteDomain: true,
      },
    });
    if (bp && bp.organizationName && String(bp.organizationName).trim()) {
      return {
        organizationName: String(bp.organizationName).trim(),
        businessDescription: bp.businessDescription ? String(bp.businessDescription).trim() : null,
        industry: bp.industry ? String(bp.industry).trim() : null,
        websiteDomain: bp.websiteDomain ? String(bp.websiteDomain).trim() : null,
      };
    }

    // Fallback: no BusinessProfile yet → still anchor the agent to its employer
    // using the tenant name, so EVERY agent (any role) knows it represents the
    // business even before onboarding's business profile is filled in.
    const tenant: any = await (prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (tenant?.name && String(tenant.name).trim()) {
      return { organizationName: String(tenant.name).trim(), businessDescription: null, industry: null, websiteDomain: null };
    }
    return null;
  } catch (err: any) {
    console.warn("[company-context] load failed:", err?.message);
    return null;
  }
}
