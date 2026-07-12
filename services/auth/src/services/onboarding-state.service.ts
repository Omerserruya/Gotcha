/**
 * Onboarding State — the single source of truth for "where is this tenant in
 * onboarding?". One place computes the snapshot (milestones, progress, health,
 * current stage, next recommended action) so the System Admin console, the
 * Nudge Engine's personalization, and the reset flow all agree.
 *
 * Everything here is DERIVED from real product signals (BusinessDiscovery,
 * BusinessProfile, TenantOnboarding, TenantIntegration, ChannelAccount,
 * KnowledgeBase, AIAgent) — never a manual checkbox — so it can never drift
 * from reality.
 */

import { prisma } from "@chatcenter/shared";

// Kept in sync with onboarding.ts CORE_SYSTEM_SLUGS (the systems that can be a
// tenant's customer source-of-truth). Small, stable duplication — see note.
export const CORE_SYSTEM_SLUGS = ["hubspot", "salesforce", "zoho_crm", "shopify", "fireberry", "airtable"] as const;

/** Slug of the first CONNECTED + usable core system, or null. Airtable only
 *  counts once its column mapping is saved. */
export async function connectedCoreSystem(tenantId: string): Promise<string | null> {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED", integration: { slug: { in: CORE_SYSTEM_SLUGS as unknown as string[] } } },
    include: { integration: true },
    orderBy: { createdAt: "asc" },
  });
  return firstUsableCoreSlug(rows);
}

function firstUsableCoreSlug(rows: any[]): string | null {
  for (const ti of rows || []) {
    const slug = ti?.integration?.slug as string | undefined;
    if (!slug) continue;
    if (slug === "airtable") {
      const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as any;
      const fm = cfg.fieldMap;
      if (!fm || !(fm.email || fm.phone) || !fm.display_name) continue;
    }
    return slug;
  }
  return null;
}

export type OnboardingStage = "not_started" | "discovery" | "review" | "goal" | "connect" | "ready" | "active";
export type OnboardingHealth = "activated" | "on_track" | "at_risk" | "stuck";

export interface OnboardingSnapshot {
  tenantId: string;
  company: string;
  slug: string;
  status: string;
  createdAt: Date;
  // Milestones
  discoveryComplete: boolean;
  reviewComplete: boolean;
  goalSelected: boolean;
  crmConnected: boolean;
  crmSlug: string | null;
  channelsConnected: number;
  integrationsConnected: number;
  knowledgeCount: number;
  knowledgeStatus: "none" | "detected" | "imported";
  aiEmployeeCreated: boolean;
  aiEmployeeName: string | null;
  // Derived
  currentStage: OnboardingStage;
  progressPct: number;
  health: OnboardingHealth;
  nextRecommendedAction: string;
  lastActivity: Date;
  lastNudgeSentAt: Date | null;
  gaps: string[];
  primaryGoal: string | null;
  assignedCsm: string | null; // future-ready
}

interface Facts {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  tenantUpdatedAt: Date;
  discoveryStatus: string | null;
  discoveryUpdatedAt: Date | null;
  gaps: string[];
  discoveryGoal: string | null;
  reviewComplete: boolean;
  businessGoals: string[];
  profileUpdatedAt: Date | null;
  onboardingUpdatedAt: Date | null;
  crmSlug: string | null;
  channelsConnected: number;
  integrationsConnected: number;
  knowledgeCount: number;
  aiEmployeeName: string | null;
  lastNudgeSentAt: Date | null;
}

const DAY = 24 * 60 * 60 * 1000;

function deriveStage(f: Facts): OnboardingStage {
  if (f.status === "ACTIVE") return "active";
  if (f.aiEmployeeName) return "ready";
  if (f.crmSlug || f.channelsConnected > 0) return "connect";
  if (goalSelected(f)) return "connect";
  if (f.reviewComplete) return "goal";
  if (f.discoveryStatus === "COMPLETE") return "review";
  if (f.discoveryStatus) return "discovery";
  return "not_started";
}

function goalSelected(f: Facts): boolean {
  return !!f.discoveryGoal || (f.businessGoals?.length ?? 0) > 0;
}

function deriveProgress(f: Facts): number {
  let p = 0;
  if (f.discoveryStatus === "COMPLETE") p += 15;
  if (f.reviewComplete) p += 15;
  if (goalSelected(f)) p += 10;
  if (f.crmSlug) p += 15;
  if (f.channelsConnected > 0) p += 15;
  if (f.knowledgeCount > 0) p += 10;
  if (f.aiEmployeeName) p += 20;
  return Math.min(100, p);
}

function lastActivity(f: Facts): Date {
  const times = [f.tenantUpdatedAt, f.discoveryUpdatedAt, f.profileUpdatedAt, f.onboardingUpdatedAt]
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  return new Date(times.length ? Math.max(...times) : f.createdAt.getTime());
}

function deriveHealth(f: Facts): OnboardingHealth {
  if (f.status === "ACTIVE") return "activated";
  const idleMs = Date.now() - lastActivity(f).getTime();
  if (idleMs > 3 * DAY) return "stuck";
  if (idleMs > 12 * 60 * 60 * 1000) return "at_risk";
  return "on_track";
}

/** The "Next Recommended Action" column — a single operator-facing label. */
export function deriveNextAction(f: Facts): string {
  if (f.status === "ACTIVE") {
    if (!f.aiEmployeeName) return "Create First AI Employee";
    if (f.channelsConnected === 0) return "Connect WhatsApp";
    return "Ready to Go Live";
  }
  if (!f.discoveryStatus || f.discoveryStatus === "PENDING") return "Waiting for Customer";
  if (f.discoveryStatus === "SCANNING") return "Waiting for Discovery";
  if (f.discoveryStatus === "FAILED") return "Re-run Business Discovery";
  if (!f.reviewComplete) return "Finish Business Review";
  if (!goalSelected(f)) return "Select Business Goal";
  if (!f.crmSlug) return "Connect CRM";
  if (f.channelsConnected === 0) return "Connect WhatsApp";
  return "Finish & Activate";
}

function knowledgeStatus(f: Facts): "none" | "detected" | "imported" {
  if (f.knowledgeCount > 0) return "imported";
  if (f.gaps.length > 0 || f.discoveryStatus === "COMPLETE") return "detected";
  return "none";
}

function buildSnapshot(f: Facts): OnboardingSnapshot {
  return {
    tenantId: f.tenantId,
    company: f.name,
    slug: f.slug,
    status: f.status,
    createdAt: f.createdAt,
    discoveryComplete: f.discoveryStatus === "COMPLETE",
    reviewComplete: f.reviewComplete,
    goalSelected: goalSelected(f),
    crmConnected: !!f.crmSlug,
    crmSlug: f.crmSlug,
    channelsConnected: f.channelsConnected,
    integrationsConnected: f.integrationsConnected,
    knowledgeCount: f.knowledgeCount,
    knowledgeStatus: knowledgeStatus(f),
    aiEmployeeCreated: !!f.aiEmployeeName,
    aiEmployeeName: f.aiEmployeeName,
    currentStage: deriveStage(f),
    progressPct: deriveProgress(f),
    health: deriveHealth(f),
    nextRecommendedAction: deriveNextAction(f),
    lastActivity: lastActivity(f),
    lastNudgeSentAt: f.lastNudgeSentAt,
    gaps: f.gaps,
    primaryGoal: f.discoveryGoal || f.businessGoals[0] || null,
    assignedCsm: null,
  };
}

/** Single-tenant snapshot — used by the nudge engine and reset flow. */
export async function getOnboardingSnapshot(tenantId: string): Promise<OnboardingSnapshot | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, status: true, createdAt: true, updatedAt: true },
  });
  if (!tenant) return null;

  const [discovery, profile, onboarding, agent, channels, integrations, kbCount, lastNudge] = await Promise.all([
    prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { status: true, gaps: true, primaryGoal: true, updatedAt: true } }).catch(() => null),
    prisma.businessProfile.findUnique({ where: { tenantId }, select: { businessGoals: true, updatedAt: true } }).catch(() => null),
    prisma.tenantOnboarding.findUnique({ where: { tenantId }, select: { updatedAt: true } }).catch(() => null),
    prisma.aIAgent.findFirst({ where: { tenantId }, select: { name: true }, orderBy: { createdAt: "asc" } }).catch(() => null),
    prisma.channelAccount.count({ where: { tenantId, connectionStatus: "CONNECTED" } }).catch(() => 0),
    prisma.tenantIntegration.findMany({ where: { tenantId, status: "CONNECTED" }, include: { integration: true }, orderBy: { createdAt: "asc" } }).catch(() => []),
    prisma.knowledgeBase.count({ where: { tenantId } }).catch(() => 0),
    prisma.scheduledNudge.findFirst({ where: { tenantId, status: "SENT" }, select: { sentAt: true }, orderBy: { sentAt: "desc" } }).catch(() => null),
  ]);

  const f: Facts = {
    tenantId: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt,
    tenantUpdatedAt: tenant.updatedAt,
    discoveryStatus: discovery?.status ?? null,
    discoveryUpdatedAt: discovery?.updatedAt ?? null,
    gaps: Array.isArray(discovery?.gaps) ? discovery.gaps.map((g: any) => g?.label).filter(Boolean) : [],
    discoveryGoal: discovery?.primaryGoal ?? null,
    reviewComplete: !!profile,
    businessGoals: Array.isArray(profile?.businessGoals) ? (profile!.businessGoals as string[]) : [],
    profileUpdatedAt: profile?.updatedAt ?? null,
    onboardingUpdatedAt: onboarding?.updatedAt ?? null,
    crmSlug: firstUsableCoreSlug(integrations),
    channelsConnected: channels,
    integrationsConnected: Array.isArray(integrations) ? integrations.length : 0,
    knowledgeCount: kbCount,
    aiEmployeeName: agent?.name ?? null,
    lastNudgeSentAt: lastNudge?.sentAt ?? null,
  };
  return buildSnapshot(f);
}

/** All-tenant snapshots for the System Admin console. Batched (no N+1). */
export async function listOnboardingSnapshots(): Promise<OnboardingSnapshot[]> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, slug: true, status: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t.id);

  const [discoveries, profiles, onboardings, agents, channels, integrations, kbs, nudges] = await Promise.all([
    prisma.businessDiscovery.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, status: true, gaps: true, primaryGoal: true, updatedAt: true } }).catch(() => []),
    prisma.businessProfile.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, businessGoals: true, updatedAt: true } }).catch(() => []),
    prisma.tenantOnboarding.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, updatedAt: true } }).catch(() => []),
    prisma.aIAgent.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, name: true, createdAt: true }, orderBy: { createdAt: "asc" } }).catch(() => []),
    prisma.channelAccount.findMany({ where: { tenantId: { in: ids }, connectionStatus: "CONNECTED" }, select: { tenantId: true } }).catch(() => []),
    prisma.tenantIntegration.findMany({ where: { tenantId: { in: ids }, status: "CONNECTED" }, include: { integration: true }, orderBy: { createdAt: "asc" } }).catch(() => []),
    prisma.knowledgeBase.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true } }).catch(() => []),
    prisma.scheduledNudge.findMany({ where: { tenantId: { in: ids }, status: "SENT" }, select: { tenantId: true, sentAt: true }, orderBy: { sentAt: "desc" } }).catch(() => []),
  ]);

  const byTenant = <T extends { tenantId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const a = m.get(r.tenantId) || []; a.push(r); m.set(r.tenantId, a); }
    return m;
  };
  const discMap = new Map(discoveries.map((d: any) => [d.tenantId, d]));
  const profMap = new Map(profiles.map((p: any) => [p.tenantId, p]));
  const onbMap = new Map(onboardings.map((o: any) => [o.tenantId, o]));
  const agentMap = byTenant(agents as any[]);
  const chanMap = byTenant(channels as any[]);
  const intMap = byTenant(integrations as any[]);
  const kbMap = byTenant(kbs as any[]);
  const nudgeMap = byTenant(nudges as any[]);

  return tenants.map((t) => {
    const d: any = discMap.get(t.id);
    const p: any = profMap.get(t.id);
    const o: any = onbMap.get(t.id);
    const tenantIntegrations = intMap.get(t.id) || [];
    const firstAgent = (agentMap.get(t.id) || [])[0] as any;
    const f: Facts = {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: t.createdAt,
      tenantUpdatedAt: t.updatedAt,
      discoveryStatus: d?.status ?? null,
      discoveryUpdatedAt: d?.updatedAt ?? null,
      gaps: Array.isArray(d?.gaps) ? d.gaps.map((g: any) => g?.label).filter(Boolean) : [],
      discoveryGoal: d?.primaryGoal ?? null,
      reviewComplete: !!p,
      businessGoals: Array.isArray(p?.businessGoals) ? (p.businessGoals as string[]) : [],
      profileUpdatedAt: p?.updatedAt ?? null,
      onboardingUpdatedAt: o?.updatedAt ?? null,
      crmSlug: firstUsableCoreSlug(tenantIntegrations),
      channelsConnected: (chanMap.get(t.id) || []).length,
      integrationsConnected: tenantIntegrations.length,
      knowledgeCount: (kbMap.get(t.id) || []).length,
      aiEmployeeName: firstAgent?.name ?? null,
      lastNudgeSentAt: (nudgeMap.get(t.id) || [])[0]?.sentAt ?? null,
    };
    return buildSnapshot(f);
  });
}
