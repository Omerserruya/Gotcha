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
import { prisma, withCrossTenantAccess, withHistoricalRecords } from "@chatcenter/shared";
import { isPersonOutbound } from "../services/conversation-history.service";
import { initAIService } from "../services/ai.service";
import "../services/connectors";
import { runReplyEngineTurn } from "../services/reply-engine/engine";
import { isCannedTeamLine, automatedInbound } from "../services/reply-engine/gates";

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

export interface PlannedTurn { conversationId: string; messageId: string; asOf: Date; body: string; sentAfter: string[]; aiAgentId: string; skip?: ReplaySkip }

/** Why live would not have called the AI for this message (the worker's Gate 1, as of it). */
export type ReplaySkip = "handed_over" | "human_owned" | "owner_recent" | "automated";
const HANDOVER_EVENTS = new Set(["ai_bot_escalation", "visitor_requested_human", "whatsapp_app_takeover", "flow_ended_handoff", "agent_transferred"]);
const OWNER_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * The worker's Gate 1 rebuilt as of message i (prod replay 4: the replay ran v2
 * on turns a person owned, which live never would). From the handover history
 * and the messages before it:
 *   - the last handover before it went to a person, or a handover event since the
 *     last hand-back to the AI -> handed_over;
 *   - a person wrote (inbox or phone) since the last hand-back -> human_owned
 *     (a takeover lasts until someone hands it back);
 *   - nothing sent yet in this conversation and the owner wrote to this customer
 *     from the phone in the 24h before -> owner_recent.
 * Not rebuilt: business hours, the autonomy budget, an inactive routing flow.
 */
export function gateAsOf(msgs: any[], i: number, handovers: Array<{ toHandler: string; at: Date }>, ownerRecent: boolean): ReplaySkip | null {
  const asOf = new Date(msgs[i].createdAt).getTime();
  const before = handovers.filter((h) => new Date(h.at).getTime() < asOf);
  const last = before.at(-1);
  if (last?.toHandler === "human") return "handed_over";
  const since = last ? new Date(last.at).getTime() : -Infinity;
  const earlier = msgs.slice(0, i).filter((m) => new Date(m.createdAt).getTime() >= since);
  if (earlier.some((m) => HANDOVER_EVENTS.has((m.metadata as any)?.systemEvent))) return "handed_over";
  if (earlier.some((m) => isPersonOutbound(m))) return "human_owned";
  if (ownerRecent && !msgs.slice(0, i).some((m) => m.direction === "OUTBOUND")) return "owner_recent";
  return null;
}

/**
 * Where one turn's time went, numbers and tool names only (no customer text): the
 * engine's cumulative stage marks, rounds, the rewrite and its own lookups, and each tool.
 */
export function stagesLine(trace: any): string {
  const st = trace?.stageMs ?? {};
  const marks = Object.entries(st).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => `${k}=${Number(v)}`).join(" ");
  const tools = ((trace?.tools ?? []) as any[]).map((x) => `${x.tool}:${x.outcome ?? x.decision ?? "?"}:${Number(x.ms) || 0}ms${x.retried ? ":retried" : ""}`).join(" ");
  return `- stages: ${marks || "-"} | rounds=${trace?.rounds ?? "?"} rewriteRounds=${trace?.rewriteRounds ?? 0} autoLookupMs=${trace?.autoLookupMs ?? 0} rewriteMs=${trace?.rewriteMs ?? 0} | tools: ${tools || "-"}`;
}

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
      select: { id: true, assignedAiAgentId: true, channel: true, customerExternalId: true },
    });
    const turns: PlannedTurn[] = [];
    for (const c of convs) {
      const aiAgentId = c.assignedAiAgentId ?? fallbackAgent?.id;
      if (!aiAgentId) continue;
      const msgs = await db.message.findMany({
        where: { tenantId, conversationId: c.id, origin: "LIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, direction: true, body: true, createdAt: true, senderName: true, metadata: true, origin: true, messageType: true },
      });
      const handovers: any[] = await db.conversationHandover?.findMany({
        where: { tenantId, conversationId: c.id }, orderBy: { at: "asc" }, select: { toHandler: true, at: true },
      }).catch(() => []) ?? [];
      // The owner on the phone in the 24h before (same rule as the worker's owner-recent).
      const ownerRecentAt = async (asOf: Date): Promise<boolean> => {
        if (c.channel !== "WHATSAPP" || !c.customerExternalId) return false;
        try {
          const hit = await withHistoricalRecords(() => db.message.findFirst({
            where: {
              tenantId, channel: "WHATSAPP", direction: "OUTBOUND",
              createdAt: { gte: new Date(asOf.getTime() - OWNER_RECENT_MS), lt: asOf },
              conversation: { customerExternalId: c.customerExternalId },
              OR: [{ origin: "HISTORICAL_IMPORT" }, { metadata: { path: ["source"], equals: "whatsapp_business_app" } }],
            },
            select: { id: true },
          }));
          return !!hit;
        } catch { return false; }
      };
      for (let i = 0; i < msgs.length; i++) {
        const m: any = msgs[i];
        if (m.direction !== "INBOUND" || !String(m.body ?? "").trim() || (m.messageType ?? "text") === "system") continue;
        if (total >= args.cap) continue;
        const firstOfConv = !msgs.slice(0, i).some((x: any) => x.direction === "OUTBOUND");
        // Automated mail is skipped exactly as live skips it (the engine's own check, before any model call).
        const platformSender = /<([^>]+)>/.exec(String(process.env.SMTP_FROM ?? ""))?.[1] ?? process.env.SMTP_FROM ?? null;
        const skip = gateAsOf(msgs, i, handovers, firstOfConv ? await ownerRecentAt(new Date(m.createdAt)) : false)
          ?? (automatedInbound({ channel: c.channel, sender: c.customerExternalId, body: m.body, metadata: m.metadata, platformSender }) ? "automated" as const : null);
        // What actually went out after this message, until the customer's next one.
        const sentAfter: string[] = [];
        for (let j = i + 1; j < msgs.length && msgs[j].direction !== "INBOUND"; j++) {
          const kind = (msgs[j].metadata as any)?.kind;
          if (kind === "interim_ack" || kind === "holding" || msgs[j].messageType === "system") continue;
          sentAfter.push(`${msgs[j].senderName ?? "?"}: ${String(msgs[j].body ?? "").trim()}`);
        }
        turns.push({ conversationId: c.id, messageId: m.id, asOf: m.createdAt, body: String(m.body), sentAfter, aiAgentId, ...(skip ? { skip } : {}) });
        // A skipped turn costs no model call: only the ones that run count against the cap.
        if (!skip) total++;
      }
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

export interface TenantSummary { tenantId: string; turns: number; errors: number; handoffs: number; teamQuestions: number; teamQuestionRepeats: number; skipped: number; skippedReasons: Record<string, number>; priceStripped: number; rewriteRounds: Record<string, number>; rewriteP95: Record<string, number>; fallbackKinds: Record<string, number>; toolP95: Record<string, number>; rewriteMsP95: number; autoLookupMsP95: number; rewriteCut: Record<string, number>; cannedFrom: Record<string, number>; handoffSetInCode: number; withCards: number; withList: number; fallbacks: number; rewrites: number; cleaned: number; silent: number; cannedLines: number; toolErrors: number; toolErrorKinds: Record<string, number>; gate3Kinds: Record<string, number>; p50: number; p95: number }

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
  // This is its own process: the server's warm store caches are not here. Warm the replayed
  // tenants' stores first, so the replay measures what live (server + warmer) does.
  if (!args.dry) {
    const { warmWooCachesOnce } = await import("../services/woo-cache-warmer.service");
    const warmed = await withCrossTenantAccess(() => warmWooCachesOnce({ tenants: async () => args.tenants, scope: "all" })).catch(() => []);
    console.log(`[replay] warmed ${warmed.map((w: any) => `${w.tenantId}:${w.ok ? `${w.ms}ms` : "failed"}`).join(" ") || "no Woo stores"}`);
    const { cacheCounts } = await import("../services/connectors/woocommerce.adapter");
    for (const k of Object.keys(cacheCounts)) delete (cacheCounts as any)[k];
  }
  if (args.dry) {
    for (const [t, turns] of plan) {
      console.log(`[replay][dry] tenant=${t} conversations=${new Set(turns.map((x) => x.conversationId)).size} turns=${turns.filter((x) => !x.skip).length} skipped=${turns.filter((x) => x.skip).length}`);
      for (const x of turns) console.log(`  conv=${x.conversationId} msg=${x.messageId} at=${x.asOf.toISOString()} agent=${x.aiAgentId}${x.skip ? ` SKIP:${x.skip}` : ""}`);
    }
    return;
  }

  const md: string[] = [`# Reply engine v2 replay (${new Date().toISOString()})`, "", `Model: ${process.env.REPLY_ENGINE_MODEL || process.env.OPENAI_DEFAULT_MODEL || "default"}. Lane: replay (writes simulated, platform-paid).`, ""];
  const summaries: TenantSummary[] = [];
  const replayed = new Set<string>();

  for (const [tenantId, turns] of plan) {
    const s: TenantSummary = { tenantId, turns: 0, errors: 0, handoffs: 0, teamQuestions: 0, teamQuestionRepeats: 0, skipped: 0, skippedReasons: {}, priceStripped: 0, rewriteRounds: {}, rewriteP95: {}, fallbackKinds: {}, toolP95: {}, rewriteMsP95: 0, autoLookupMsP95: 0, rewriteCut: {}, cannedFrom: {}, handoffSetInCode: 0, withCards: 0, withList: 0, fallbacks: 0, rewrites: 0, cleaned: 0, silent: 0, cannedLines: 0, toolErrors: 0, toolErrorKinds: {}, gate3Kinds: {}, p50: 0, p95: 0 };
    const ms: number[] = [];
    const byRounds: Record<string, number[]> = {};
    const toolMs: Record<string, number[]> = {};
    const rewriteMs: number[] = [];
    const autoMs: number[] = [];
    md.push(`## Tenant ${tenantId}`, "");
    let lastConv = "";
    for (const t of turns) {
      replayed.add(t.conversationId);
      if (t.conversationId !== lastConv) { md.push(`### Conversation ${t.conversationId}`, ""); lastConv = t.conversationId; }
      if (t.skip) {
        // Live would not have called the AI here: not run, not rated.
        s.skipped++;
        s.skippedReasons[t.skip] = (s.skippedReasons[t.skip] ?? 0) + 1;
        md.push(`**Customer:** ${oneLine(t.body)}`, "", `- skipped: ${t.skip} (live would not have called the AI)`, "");
        continue;
      }
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
        if (r.trace?.gate3?.rewrite === "cleaned") s.cleaned++;
        if (r.trace?.priceStripped) s.priceStripped++;
        // Where the time goes: turns by the number of model calls the rewrite took, and the p95 of each group.
        const rr = String(r.trace?.rewriteRounds ?? 0);
        s.rewriteRounds[rr] = (s.rewriteRounds[rr] ?? 0) + 1;
        (byRounds[rr] ??= []).push(took);
        for (const k of (r.trace?.fallbackKinds ?? []) as string[]) s.fallbackKinds[k] = (s.fallbackKinds[k] ?? 0) + 1;
        if (r.trace?.gate3?.rewrite === "silent") s.silent++;
        if (isCannedTeamLine(r.reply)) {
          s.cannedLines++;
          // The engine's fallback, or the model writing the same words itself (with a real team question).
          const from = r.trace?.gate3?.rewrite === "fallback" ? "fallback" : "model";
          s.cannedFrom[from] = (s.cannedFrom[from] ?? 0) + 1;
        }
        for (const x of (r.trace?.tools ?? []) as any[]) (toolMs[x.tool] ??= []).push(Number(x.ms) || 0);
        if (r.trace?.rewriteMs != null && (r.trace?.rewriteRounds ?? 0) > 0) rewriteMs.push(r.trace.rewriteMs);
        if (r.trace?.autoLookupMs != null) autoMs.push(r.trace.autoLookupMs);
        if (r.trace?.handoffSetInCode) s.handoffSetInCode++;
        if ((r.trace?.cards ?? []).length) s.withCards++;
        if ((r.trace?.listedProducts ?? []).length) s.withList++;
        if (r.trace?.rewriteCut) s.rewriteCut[r.trace.rewriteCut] = (s.rewriteCut[r.trace.rewriteCut] ?? 0) + 1;
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
          `- cards: ${(r.trace?.cards ?? []).length ? `[${r.trace.cards.join(", ")}]` : "none"}; text list: ${(r.trace?.listedProducts ?? []).length ? `[${r.trace.listedProducts.join(", ")}] (part of the reply above, as live)` : "none"}${r.trace?.handoffSetInCode ? "; handoff set in code" : ""}`,
          `- gate3: ${r.trace?.gate3?.rewrite ?? "?"}${r.trace?.gate3?.problems?.length ? ` [${r.trace.gate3.problems.map((p: any) => p.kind).join(", ")}]` : ""}`,
          `- handoff: ${handoff ?? "none"}; team question: ${teamQ ? oneLine(teamQ, 200) : r.trace?.teamQuestionRepeat ? "(repeat of the open one, not recorded)" : "none"}`,
          `- rounds ${r.trace?.rounds ?? "?"}, ${took}ms`,
          stagesLine(r.trace),
          "",
        );
      } catch (err: any) {
        s.errors++;
        md.push(`**Customer:** ${oneLine(t.body)}`, "", `**v2 ERROR:** ${oneLine(err?.message ?? err, 300)}`, "");
      }
    }
    s.p50 = pct(ms, 50);
    s.p95 = pct(ms, 95);
    for (const [k, v] of Object.entries(byRounds)) s.rewriteP95[k] = pct(v, 95);
    for (const [k, v] of Object.entries(toolMs)) s.toolP95[k] = pct(v, 95);
    s.rewriteMsP95 = pct(rewriteMs, 95);
    s.autoLookupMsP95 = pct(autoMs, 95);
    summaries.push(s);
  }

  md.push("## Summary", "", "| tenant | turns | errors | handoffs | team questions (new) | repeats | gate3 rewrites | cleaned | gate3 fallbacks | silent | canned lines | tool errors | p50 ms | p95 ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) md.push(`| ${s.tenantId} | ${s.turns} | ${s.errors} | ${s.handoffs} | ${s.teamQuestions} | ${s.teamQuestionRepeats} | ${s.rewrites} | ${s.cleaned} | ${s.fallbacks} | ${s.silent} | ${s.cannedLines} | ${s.toolErrors} | ${s.p50} | ${s.p95} |`);
  fs.writeFileSync(args.out, md.join("\n"));

  if (!args.keep && replayed.size) {
    const del: any = await withCrossTenantAccess(() => (prisma as any).conversationState.deleteMany({ where: { lane: "replay", conversationId: { in: [...replayed] } } }));
    console.log(`[replay] deleted ${del.count} replay-lane conversation_states rows`);
  } else {
    console.log(`[replay] kept the replay-lane rows (${replayed.size} conversations)`);
  }
  // Store caches during the turns (after the warm-up): hit, stale (served while refreshing), miss.
  try {
    const { cacheCounts } = await import("../services/connectors/woocommerce.adapter");
    console.log(`[replay] store cache ${JSON.stringify(cacheCounts)}`);
  } catch { /* no Woo */ }
  // The console carries numbers only; the markdown (customer messages) is in the file.
  for (const s of summaries) console.log(`[replay] ${JSON.stringify(s)}`);
  console.log(`[replay] report written to ${args.out}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[replay] failed:", err?.message ?? err); process.exit(1); });
}
