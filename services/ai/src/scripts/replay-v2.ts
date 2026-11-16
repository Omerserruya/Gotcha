/**
 * Replay real conversations through reply engine v2, AS OF each customer
 * message, before v2 goes autonomous (Omer 2026-11-16). Runs INSIDE the ai
 * container (it needs its env and its code):
 *
 *   npx tsx src/scripts/replay-v2.ts --tenants <id,id> [--per-tenant 15] [--cap 150] [--dry] [--keep] [--out /tmp/replay-v2.md]
 *
 * What it does, per tenant: the last N conversations with at least one customer
 * message (no sandbox, test or imported ones); for each customer message, in
 * order, one v2 turn with history cut at that message, on lane "replay".
 *   - Store reads are real. Writes, approvals, cards, team questions and sends
 *     are simulated, exactly as shadow (nothing reaches a customer or the store).
 *   - Billed to the platform (platformPaidScope), never the tenant.
 *   - The employee is the conversation's assigned AI employee, else the tenant's
 *     first ACTIVE one: its own config, as autonomous would use.
 *   - At the end the replay-lane conversation_states rows of the replayed
 *     conversations are deleted (one statement, count printed), unless --keep.
 * --dry lists what it would replay and calls no model and writes nothing.
 *
 * The markdown holds customer messages: it is written to --out for the person
 * the replay is for. The console prints the numeric summary only.
 */
import fs from "fs";
import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { initAIService } from "../services/ai.service";
import "../services/connectors";
import { runReplyEngineTurn } from "../services/reply-engine/engine";

interface Args { tenants: string[]; perTenant: number; cap: number; dry: boolean; keep: boolean; out: string }

export function parseArgs(argv: string[]): Args {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const tenants = String(get("--tenants") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tenants.length) throw new Error("--tenants <id,id> is required");
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    tenants,
    perTenant: n(get("--per-tenant"), 15),
    cap: n(get("--cap"), 150),
    dry: argv.includes("--dry"),
    keep: argv.includes("--keep"),
    out: get("--out") ?? "/tmp/replay-v2.md",
  };
}

export interface PlannedTurn { conversationId: string; messageId: string; asOf: Date; body: string; sentAfter: string[]; aiAgentId: string }

/** The turns to replay: per tenant, newest conversations first, each one's customer messages in order; capped. */
export async function planReplay(args: Args, db: any = prisma): Promise<Map<string, PlannedTurn[]>> {
  const plan = new Map<string, PlannedTurn[]>();
  let total = 0;
  for (const tenantId of args.tenants) {
    const fallbackAgent = await db.aIAgent.findFirst({ where: { tenantId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const convs = await db.conversation.findMany({
      where: {
        tenantId, isTest: false, origin: "LIVE",
        NOT: { customerExternalId: { startsWith: "sandbox:" } },
        messages: { some: { direction: "INBOUND" } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: args.perTenant,
      select: { id: true, assignedAiAgentId: true },
    });
    const turns: PlannedTurn[] = [];
    for (const c of convs) {
      const aiAgentId = c.assignedAiAgentId ?? fallbackAgent?.id;
      if (!aiAgentId) continue;
      const msgs = await db.message.findMany({
        where: { tenantId, conversationId: c.id, origin: "LIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, direction: true, body: true, createdAt: true, senderName: true, metadata: true },
      });
      msgs.forEach((m: any, i: number) => {
        if (m.direction !== "INBOUND" || !String(m.body ?? "").trim()) return;
        if (total >= args.cap) return;
        // What actually went out after this message, until the customer's next one.
        const sentAfter: string[] = [];
        for (let j = i + 1; j < msgs.length && msgs[j].direction !== "INBOUND"; j++) {
          const kind = (msgs[j].metadata as any)?.kind;
          if (kind === "interim_ack" || kind === "holding") continue;
          sentAfter.push(`${msgs[j].senderName ?? "?"}: ${String(msgs[j].body ?? "").trim()}`);
        }
        turns.push({ conversationId: c.id, messageId: m.id, asOf: m.createdAt, body: String(m.body), sentAfter, aiAgentId });
        total++;
      });
    }
    plan.set(tenantId, turns);
  }
  return plan;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const oneLine = (s: unknown, n = 600) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export interface TenantSummary { tenantId: string; turns: number; errors: number; handoffs: number; teamQuestions: number; teamQuestionRepeats: number; fallbacks: number; rewrites: number; toolErrors: number; toolErrorKinds: Record<string, number>; gate3Kinds: Record<string, number>; p50: number; p95: number }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set: run this inside the ai container");
  initAIService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });

  const plan = await withCrossTenantAccess(() => planReplay(args));
  if (args.dry) {
    for (const [t, turns] of plan) {
      console.log(`[replay][dry] tenant=${t} conversations=${new Set(turns.map((x) => x.conversationId)).size} turns=${turns.length}`);
      for (const x of turns) console.log(`  conv=${x.conversationId} msg=${x.messageId} at=${x.asOf.toISOString()} agent=${x.aiAgentId}`);
    }
    return;
  }

  const md: string[] = [`# Reply engine v2 replay (${new Date().toISOString()})`, "", `Model: ${process.env.REPLY_ENGINE_MODEL || process.env.OPENAI_DEFAULT_MODEL || "default"}. Lane: replay (writes simulated, platform-paid).`, ""];
  const summaries: TenantSummary[] = [];
  const replayed = new Set<string>();

  for (const [tenantId, turns] of plan) {
    const s: TenantSummary = { tenantId, turns: 0, errors: 0, handoffs: 0, teamQuestions: 0, teamQuestionRepeats: 0, fallbacks: 0, rewrites: 0, toolErrors: 0, toolErrorKinds: {}, gate3Kinds: {}, p50: 0, p95: 0 };
    const ms: number[] = [];
    md.push(`## Tenant ${tenantId}`, "");
    let lastConv = "";
    for (const t of turns) {
      replayed.add(t.conversationId);
      if (t.conversationId !== lastConv) { md.push(`### Conversation ${t.conversationId}`, ""); lastConv = t.conversationId; }
      const t0 = Date.now();
      try {
        const r: any = await withCrossTenantAccess(() => runReplyEngineTurn(
          { tenantId, conversationId: t.conversationId, aiAgentId: t.aiAgentId, incomingMessage: t.body, replay: { asOf: t.asOf, messageId: t.messageId } },
          "autonomous",
        ));
        const took = Date.now() - t0;
        ms.push(took);
        s.turns++;
        const handoff = r.escalation?.reason ?? null;
        if (handoff) s.handoffs++;
        if (r.trace?.gate3?.rewrite === "fallback") s.fallbacks++;
        if (r.trace?.gate3?.rewrite === "rewritten") s.rewrites++;
        const tools = (r.trace?.tools ?? []) as any[];
        const errored = tools.filter((x) => x.outcome === "error" || x.outcome === "timeout");
        s.toolErrors += errored.length;
        // Codes only (tool name + error code), never arguments or results: safe for the console.
        for (const x of errored) { const k = `${x.tool}:${x.errorKind ?? x.outcome}`; s.toolErrorKinds[k] = (s.toolErrorKinds[k] ?? 0) + 1; }
        for (const p of (r.trace?.gate3?.problems ?? []) as any[]) {
          const ks = p.kind === "style" ? (p.codes ?? []).map((c: string) => `style:${c}`) : [p.kind];
          for (const k of ks) s.gate3Kinds[k] = (s.gate3Kinds[k] ?? 0) + 1;
        }
        const teamQ = r.trace?.teamQuestion ?? null;
        if (teamQ) s.teamQuestions++;
        if (r.trace?.teamQuestionRepeat) s.teamQuestionRepeats++;
        md.push(
          `**Customer:** ${oneLine(t.body)}`,
          "",
          `**Actually sent:** ${t.sentAfter.length ? t.sentAfter.map((x) => oneLine(x, 400)).join(" / ") : "(nothing)"}`,
          "",
          `**v2:** ${oneLine(r.reply ?? "(no reply)")}`,
          "",
          `- tools: ${tools.length ? tools.map((x) => `${x.tool} ${x.outcome ?? x.decision}${x.errorKind ? `[${x.errorKind}]` : ""}${x.resultCount != null ? ` (${x.resultCount})` : ""} ${x.ms}ms${x.retried ? " retried" : ""}`).join("; ") : "none"}`,
          `- gate3: ${r.trace?.gate3?.rewrite ?? "?"}${r.trace?.gate3?.problems?.length ? ` [${r.trace.gate3.problems.map((p: any) => p.kind).join(", ")}]` : ""}`,
          `- handoff: ${handoff ?? "none"}; team question: ${teamQ ? oneLine(teamQ, 200) : r.trace?.teamQuestionRepeat ? "(repeat of the open one, not recorded)" : "none"}`,
          `- rounds ${r.trace?.rounds ?? "?"}, ${took}ms`,
          "",
        );
      } catch (err: any) {
        s.errors++;
        md.push(`**Customer:** ${oneLine(t.body)}`, "", `**v2 ERROR:** ${oneLine(err?.message ?? err, 300)}`, "");
      }
    }
    s.p50 = pct(ms, 50);
    s.p95 = pct(ms, 95);
    summaries.push(s);
  }

  md.push("## Summary", "", "| tenant | turns | errors | handoffs | team questions (new) | repeats | gate3 rewrites | gate3 fallbacks | tool errors | p50 ms | p95 ms |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) md.push(`| ${s.tenantId} | ${s.turns} | ${s.errors} | ${s.handoffs} | ${s.teamQuestions} | ${s.teamQuestionRepeats} | ${s.rewrites} | ${s.fallbacks} | ${s.toolErrors} | ${s.p50} | ${s.p95} |`);
  fs.writeFileSync(args.out, md.join("\n"));

  if (!args.keep && replayed.size) {
    const del: any = await withCrossTenantAccess(() => (prisma as any).conversationState.deleteMany({ where: { lane: "replay", conversationId: { in: [...replayed] } } }));
    console.log(`[replay] deleted ${del.count} replay-lane conversation_states rows`);
  } else {
    console.log(`[replay] kept the replay-lane rows (${replayed.size} conversations)`);
  }
  // The console carries numbers only; the markdown (customer messages) is in the file.
  for (const s of summaries) console.log(`[replay] ${JSON.stringify(s)}`);
  console.log(`[replay] report written to ${args.out}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[replay] failed:", err?.message ?? err); process.exit(1); });
}
