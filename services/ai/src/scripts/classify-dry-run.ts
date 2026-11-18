/**
 * Read-only dry run of the conversation relevance classifier (Omer, 2026-11-17), before it ever
 * gates a reply. Runs INSIDE the ai container (its env, its code):
 *
 *   npx tsx src/scripts/classify-dry-run.ts --tenant <id> --days 60 --out /tmp/classify-<tenant>.md [--limit 2000]
 *
 * Classifies every conversation with a message in the last --days and writes a markdown report:
 *   - counts per category, per channel, and a confidence histogram;
 *   - 15 samples per category (channel, who wrote first, the subject or first line up to 80 characters,
 *     the label, the confidence, the reason);
 *   - every conversation a label would SILENCE (personal, notice, marketing) with confidence < 0.85.
 * Writes nothing to the database, unless --write (NEEDS the a6459560 columns): then each label is written
 * through the conversation service's internal route, never over a person's override (the backfill).
 * The model calls are platform-paid ("_classify", outside the tenant's
 * budgets). The report holds message lines for the reviewer; the console prints counts only.
 */
import fs from "fs";
import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { initAIService } from "../services/ai.service";
import { getCompanyContext } from "../services/company-context.service";
import { writeLabel } from "../services/reply-engine/relevance-gate";
import { classifyConversation, SILENCING, RELEVANCE_CATEGORIES, teamIdentityOf, type Relevance, type RelevanceInput, type RelevanceProfile } from "../services/conversation-relevance.service";

export interface DryArgs { tenant: string; days: number; out: string; limit: number; write: boolean }
export function parseDryArgs(argv: string[]): DryArgs {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const tenant = get("--tenant");
  if (!tenant) throw new Error("usage: --tenant <id> [--days 60] [--out file.md] [--limit 2000]");
  const days = Number(get("--days") ?? 60);
  const limit = Number(get("--limit") ?? 2000);
  return {
    tenant,
    days: Number.isFinite(days) && days > 0 ? Math.min(365, Math.floor(days)) : 60,
    out: get("--out") ?? `/tmp/classify-${tenant}.md`,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(10000, Math.floor(limit)) : 2000,
    write: argv.includes("--write"),
  };
}

export interface DryRow { conversationId: string; channel: string; firstWriter: "business" | "contact" | "unknown"; line: string; label: Relevance }

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cell = (s: string) => s.replace(/\|/g, "\\|");

/** The report, from the classified rows (pure, tested). */
export function dryRunReport(tenant: string, days: number, rows: DryRow[]): string {
  const md: string[] = [`# Relevance dry run: tenant ${tenant}, last ${days} days`, "", `Conversations: ${rows.length}`, ""];
  const by = (f: (r: DryRow) => string) => { const m = new Map<string, number>(); for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1); return m; };
  md.push("## Per category", "", "| category | count | fast path | model |", "|---|---|---|---|");
  for (const c of RELEVANCE_CATEGORIES) {
    const of = rows.filter((r) => r.label.category === c);
    md.push(`| ${c} | ${of.length} | ${of.filter((r) => r.label.source === "fast").length} | ${of.filter((r) => r.label.source === "model").length} |`);
  }
  md.push("", "## Per channel", "", `| channel | ${RELEVANCE_CATEGORIES.join(" | ")} |`, `|---|${RELEVANCE_CATEGORIES.map(() => "---").join("|")}|`);
  for (const ch of [...by((r) => r.channel).keys()].sort()) {
    md.push(`| ${ch} | ${RELEVANCE_CATEGORIES.map((c) => rows.filter((r) => r.channel === ch && r.label.category === c).length).join(" | ")} |`);
  }
  md.push("", "## Confidence", "", "| confidence | count |", "|---|---|");
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    md.push(`| ${lo.toFixed(1)}-${hi.toFixed(1)} | ${rows.filter((r) => r.label.confidence >= lo && (b === 9 ? r.label.confidence <= hi : r.label.confidence < hi)).length} |`);
  }
  for (const c of RELEVANCE_CATEGORIES) {
    const of = rows.filter((r) => r.label.category === c).slice(0, 15);
    if (!of.length) continue;
    md.push("", `## Samples: ${c}`, "", "| conversation | channel | first | subject / first line | confidence | reason |", "|---|---|---|---|---|---|");
    for (const r of of) md.push(`| ${r.conversationId} | ${r.channel} | ${r.firstWriter} | ${cell(clip(r.line, 80))} | ${r.label.confidence.toFixed(2)} | ${cell(clip(r.label.reason, 100))} |`);
  }
  const review = rows.filter((r) => SILENCING.has(r.label.category) && r.label.confidence < 0.85);
  // Every business label where the business wrote first: the loop risk the first-mover rule guards.
  const firstBiz = rows.filter((r) => r.label.category === "business" && r.firstWriter === "business");
  md.push("", `## Would silence the AI, confidence < 0.85 (${review.length}): review these`, "", "| conversation | channel | first | subject / first line | label | confidence | reason |", "|---|---|---|---|---|---|---|");
  for (const r of review) md.push(`| ${r.conversationId} | ${r.channel} | ${r.firstWriter} | ${cell(clip(r.line, 80))} | ${r.label.category} | ${r.label.confidence.toFixed(2)} | ${cell(clip(r.label.reason, 100))} |`);
  md.push("", `## Business although the business wrote first (${firstBiz.length}): review these`, "", "| conversation | channel | subject / first line | confidence | reason |", "|---|---|---|---|---|");
  for (const r of firstBiz) md.push(`| ${r.conversationId} | ${r.channel} | ${cell(clip(r.line, 80))} | ${r.label.confidence.toFixed(2)} | ${cell(clip(r.label.reason, 100))} |`);
  return md.join("\n") + "\n";
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]); }
  }));
  return out;
}

async function main() {
  const a = parseDryArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set: run this inside the ai container");
  initAIService({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  await withCrossTenantAccess(async () => {
    const since = new Date(Date.now() - a.days * 24 * 60 * 60_000);
    const cc = await getCompanyContext(a.tenant).catch(() => null);
    const agent: any = await (prisma as any).aIAgent.findFirst({ where: { tenantId: a.tenant, status: "ACTIVE" }, select: { salesContext: true } }).catch(() => null);
    const profile: RelevanceProfile | null = cc ? { ...cc, whatWeSell: agent?.salesContext?.whatWeSell ?? null } : null;
    // The team, for the internal label (phones and emails only; nothing printed).
    const users: any[] = await (prisma as any).user.findMany({ where: { tenantId: a.tenant }, select: { email: true, phoneNumber: true }, take: 500 }).catch(() => []);
    const team = teamIdentityOf(users);
    const convs: any[] = await (prisma as any).conversation.findMany({
      where: { tenantId: a.tenant, lastMessageAt: { gte: since }, NOT: { customerExternalId: { startsWith: "sandbox:" } } },
      orderBy: { lastMessageAt: "desc" },
      take: a.limit,
      select: { id: true, channel: true, customerExternalId: true, ...(a.write ? { relevanceOverriddenBy: true } : {}) },
    });
    console.log(`[classify] tenant=${a.tenant} conversations=${convs.length}`);
    let done = 0;
    let written = 0;
    let writeFailed = 0;
    const rows = await pool(convs, 3, async (c): Promise<DryRow> => {
      const [last, first] = await Promise.all([
        (prisma as any).message.findMany({ where: { tenantId: a.tenant, conversationId: c.id }, orderBy: { createdAt: "desc" }, take: 12, select: { direction: true, body: true, createdAt: true, messageType: true, metadata: true } }),
        (prisma as any).message.findFirst({ where: { tenantId: a.tenant, conversationId: c.id, NOT: { messageType: "system" } }, orderBy: { createdAt: "asc" }, select: { direction: true } }),
      ]);
      const messages = (last as any[]).reverse();
      const lastIn = [...messages].reverse().find((m) => m.direction === "INBOUND");
      const subject = (lastIn?.metadata as any)?.email?.subject ?? null;
      const input: RelevanceInput = { channel: String(c.channel), customerExternalId: c.customerExternalId, firstDirection: first?.direction ?? null, messages, subject, team };
      const label = await classifyConversation(a.tenant, profile, input).catch((err: any) => ({ category: "unclear" as const, confidence: 0, reason: `error: ${clip(err?.message ?? err, 60)}`, source: "model" as const, classifiedAt: new Date().toISOString() }));
      // The backfill: never over a person's override, never an error's "unclear".
      if (a.write && !c.relevanceOverriddenBy && !label.reason.startsWith("error:")) {
        try { await writeLabel(a.tenant, c.id, label); written++; } catch { writeFailed++; }
      }
      if (++done % 25 === 0) console.log(`[classify] ${done}/${convs.length}`);
      const firstIn = messages.find((m: any) => m.direction === "INBOUND" && clip(m.body, 1));
      return { conversationId: c.id, channel: String(c.channel), firstWriter: first?.direction === "OUTBOUND" ? "business" : first?.direction === "INBOUND" ? "contact" : "unknown", line: subject ?? clip(firstIn?.body, 80), label };
    });
    fs.writeFileSync(a.out, dryRunReport(a.tenant, a.days, rows));
    const counts = RELEVANCE_CATEGORIES.map((k) => `${k}=${rows.filter((r) => r.label.category === k).length}`).join(" ");
    console.log(`[classify] done: ${counts}; silencing under 0.85: ${rows.filter((r) => SILENCING.has(r.label.category) && r.label.confidence < 0.85).length}; report ${a.out}${a.write ? `; written ${written}, write failed ${writeFailed}` : ""}`);
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[classify] failed:", err?.message ?? err); process.exit(1); });
}
