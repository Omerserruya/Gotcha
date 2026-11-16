/**
 * Skills for v2: the agent always sees a short list (name + when to use) and
 * opens a full playbook with `read_skill`. Sources, in order:
 *   1. the role skill (skills.ts, by AIAgent.role);
 *   2. the business skills attached to this employee (AgentSkill on/watch, BusinessSkill active);
 *   3. for a store tenant with no business skill attached, the starter store library
 *      (starter-skills.ts), read in memory: nothing is written to the tenant.
 */
import { selectSkill, renderSkill } from "../skills";
import { loadSkillContext, type SkillCandidate } from "../skill-runtime.service";
import { starterStoreSkills } from "../starter-skills";

export interface EngineSkill {
  /** Stable name the model passes to read_skill. */
  name: string;
  whenToUse: string;
  source: "role" | "business" | "starter";
  /** The skill when it is a business skill (for approvalOverAmount). */
  candidate?: SkillCandidate;
  render: () => string;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function renderBusinessSkill(s: { name: string; situation?: string | null; whenToUse?: string | null; steps?: any[]; rules?: any[]; requiredInfo?: any[]; exclusions?: any[] }): string {
  const lines = [`# Playbook: ${s.name}`];
  if (s.situation) lines.push(`Situation: ${s.situation}`);
  if (s.whenToUse) lines.push(`When to use: ${s.whenToUse}`);
  const ex = (s.exclusions ?? []).map((e: any) => e?.text).filter(Boolean);
  if (ex.length) lines.push(`Not for: ${ex.join("; ")}`);
  const req = (s.requiredInfo ?? []).slice().sort((a: any, b: any) => (a?.priority ?? 9) - (b?.priority ?? 9));
  if (req.length) lines.push(`Information you need from the customer (ask only what is missing, one at a time): ${req.map((r: any) => r.label || r.key).join("; ")}`);
  const steps = s.steps ?? [];
  if (steps.length) {
    lines.push("Steps:");
    steps.forEach((st: any, i: number) => {
      const native: Record<string, string> = { escalate_to_human: "respond.handoff", send_product_card: "respond.cards", send_product_carousel: "respond.cards" };
      const tools = Array.isArray(st?.tools) && st.tools.length ? ` [tools: ${[...new Set(st.tools.map((t: string) => native[t] ?? t))].join(", ")}]` : "";
      const over = st?.approvalOverAmount != null ? ` [over ${st.approvalOverAmount} needs a person's approval]` : "";
      lines.push(`${i + 1}. ${st?.title ?? st?.kind ?? "step"}${tools}${over}${st?.guidance ? ` - ${st.guidance}` : ""}${st?.elseNote ? ` (otherwise: ${st.elseNote})` : ""}`);
    });
  }
  for (const r of s.rules ?? []) if (r?.text) lines.push(`${r.type === "handover" ? "Hand over to a person when" : "Never"}: ${r.text}`);
  return lines.join("\n");
}

async function starterSkills(platform: "shopify" | "woocommerce", locale: "he" | "en"): Promise<EngineSkill[]> {
  try {
    const list = starterStoreSkills(platform, locale);
    return list.map(({ key, skill }) => ({
      name: clip(key || skill?.name, 60),
      whenToUse: clip(skill?.whenToUse ?? skill?.situation ?? skill?.name, 160),
      source: "starter" as const,
      render: () => renderBusinessSkill(skill as any),
    }));
  } catch {
    return [];
  }
}

export async function loadEngineSkills(opts: {
  tenantId: string;
  aiAgentId: string;
  conversationId: string;
  role: string | null | undefined;
  storePlatform: "shopify" | "woocommerce" | null;
  locale: "he" | "en";
}): Promise<EngineSkill[]> {
  const role = selectSkill(opts.role);
  const out: EngineSkill[] = [
    { name: `role_${String(role.id).toLowerCase()}`, whenToUse: clip(role.mission, 160), source: "role", render: () => renderSkill(role) },
  ];
  const ctx = await loadSkillContext(opts.tenantId, opts.aiAgentId, opts.conversationId).catch(() => null);
  const business = (ctx?.candidates ?? []).filter((c) => c.mode === "on");
  for (const c of business) {
    out.push({ name: clip(c.name, 60), whenToUse: clip(c.whenToUse ?? c.situation ?? c.name, 160), source: "business", candidate: c, render: () => renderBusinessSkill(c as any) });
  }
  if (!business.length && opts.storePlatform) out.push(...(await starterSkills(opts.storePlatform, opts.locale)));
  // Stable order for the cached prefix.
  return out.sort((a, b) => (a.source === "role" ? -1 : b.source === "role" ? 1 : a.name.localeCompare(b.name)));
}

export function renderSkillList(skills: EngineSkill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.whenToUse}`).join("\n");
}

export function findSkill(skills: EngineSkill[], name: unknown): EngineSkill | null {
  const n = clip(name, 80).toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === n) ?? skills.find((s) => s.name.toLowerCase().includes(n) && n.length >= 3) ?? null;
}

/** Playbooks small enough to sit in the cached prefix are inlined there: no read_skill round at all. */
export function inlineBudgetChars(): number {
  const n = Number(process.env.REPLY_ENGINE_INLINE_SKILLS_CHARS);
  return Number.isFinite(n) && n >= 0 ? n : 7000;
}

export function splitInline(skills: EngineSkill[], budget = inlineBudgetChars()): { inline: EngineSkill[]; listed: EngineSkill[] } {
  const readable = skills.filter((s) => s.source !== "role");
  const total = readable.reduce((n, s) => n + s.render().length, 0);
  return total <= budget ? { inline: readable, listed: [] } : { inline: [], listed: readable };
}
