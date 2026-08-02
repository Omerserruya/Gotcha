/**
 * LOOP-EVAL - statistical evaluation of the Agent Loop's BEHAVIOR (not outcomes vs
 * legacy). Reads persisted agent_loop_runs + agent_loop_iterations and computes, per
 * run, the metrics that tell us whether the loop behaves like an excellent employee:
 *
 *   iterations · operations · repeated operations · termination · wallMs · AI units ·
 *   runtime failures · authorization failures · observations · final outcome
 *
 * Then flags the pathologies to optimize away:
 *   stuck loops · repeated operations · unnecessary operations · excessive reasoning ·
 *   early/incorrect termination · hallucinated operations · excessive cost
 *
 * Pure read + aggregate - cheap and re-runnable as the corpus grows. Populate the
 * corpus with `loop-replay-batch.ts` (autonomous over simulated connectors).
 *
 *   ... npx tsx scripts/loop-eval.ts [days=90] [mode=all|autonomous|advisory]
 */
import { prisma } from "@chatcenter/shared";

const TENANT_ID = process.env.PILOT_TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";
const TERMINAL_STUCK = new Set(["timeout", "max_iterations", "no_progress", "budget_exceeded"]);
const EXCESSIVE_ITERS = 6;
const EXCESSIVE_UNITS = 12000;

interface RunEval {
  loopId: string; conversationId: string; mode: string; termination: string;
  iterations: number; wallMs: number; units: number;
  ops: string[]; uniqueOps: number; repeatedOps: string[];
  runtimeFailures: number; authzFailures: number; hallucinated: number;
  hasReply: boolean;
  pathologies: string[];
}

function evalRun(run: any, iters: any[]): RunEval {
  const ops = iters.map((i) => i.proposedOperation).filter(Boolean) as string[];
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o] = (counts[o] ?? 0) + 1;
  const repeatedOps = Object.entries(counts).filter(([, n]) => n > 1).map(([o, n]) => `${o}×${n}`);
  const obsReason = (it: any) => String(it.observation?.reason ?? "");
  const runtimeFailures = iters.filter((i) => i.runtimeResult === "FAILED").length;
  const authzFailures = iters.filter((i) => i.runtimeResult === "DENIED" || /not_permitted|unauthori|forbidden|denied/i.test(obsReason(i))).length;
  const hallucinated = iters.filter((i) => i.runtimeResult === "BLOCKED" && /unknown_operation|no_capability/i.test(obsReason(i))).length;

  const p: string[] = [];
  if (TERMINAL_STUCK.has(run.terminationReason)) p.push(`stuck:${run.terminationReason}`);
  if (repeatedOps.length) p.push("repeated_ops");
  if ((run.iterationCount ?? iters.length) > EXCESSIVE_ITERS) p.push("excessive_iterations");
  if ((run.spentUnits ?? 0) > EXCESSIVE_UNITS) p.push("excessive_cost");
  if (hallucinated > 0) p.push("hallucinated_ops");
  if (runtimeFailures > 0) p.push("runtime_failures");
  if (authzFailures > 0) p.push("authz_failures");
  if (!run.reply) p.push("no_reply");
  // (No-op finishes are NOT flagged: a plain "bye/thanks" close is correct behavior,
  // not early termination. Real early/incorrect termination is judged separately.)

  return {
    loopId: run.loopId, conversationId: run.conversationId, mode: run.mode, termination: run.terminationReason,
    iterations: run.iterationCount ?? iters.length, wallMs: run.wallMs ?? 0, units: run.spentUnits ?? 0,
    ops, uniqueOps: Object.keys(counts).length, repeatedOps,
    runtimeFailures, authzFailures, hallucinated, hasReply: !!run.reply, pathologies: p,
  };
}

function pct(n: number, d: number) { return d ? ((n / d) * 100).toFixed(1) : "0.0"; }
function median(xs: number[]) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

async function main() {
  const days = Number(process.argv[2] || "90");
  const modeFilter = process.argv[3] || "all";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where: any = { tenantId: TENANT_ID, createdAt: { gte: since } };
  if (modeFilter !== "all") where.mode = modeFilter;
  const allRuns: any[] = await (prisma as any).agentLoopRun.findMany({ where, orderBy: { createdAt: "desc" } });
  // Exclude synthetic harness conversations - evaluate only REAL customer traffic.
  const SYNTHETIC = /^(pilot-loop|pilot-book|pilot-move|crm-)/;
  const runs = allRuns.filter((r) => !SYNTHETIC.test(String(r.conversationId)));
  const evals: RunEval[] = [];
  for (const run of runs) {
    const iters = await (prisma as any).agentLoopIteration.findMany({ where: { loopId: run.loopId }, orderBy: { iteration: "asc" } });
    evals.push(evalRun(run, iters));
  }

  const n = evals.length;
  console.log(`\n=== LOOP-EVAL (n=${n} runs, last ${days}d, mode=${modeFilter}) ===`);
  if (!n) { console.log("no runs - populate with loop-replay-batch.ts"); await prisma.$disconnect(); return; }

  // Distributions
  const iterArr = evals.map((e) => e.iterations), unitArr = evals.map((e) => e.units), wallArr = evals.map((e) => e.wallMs);
  console.log(`\n-- distributions --`);
  console.log(`  iterations: median=${median(iterArr)} max=${Math.max(...iterArr)} avg=${(iterArr.reduce((a, b) => a + b, 0) / n).toFixed(1)}`);
  console.log(`  AI units:   median=${median(unitArr)} max=${Math.max(...unitArr)} avg=${Math.round(unitArr.reduce((a, b) => a + b, 0) / n)}`);
  console.log(`  wall ms:    median=${median(wallArr)} max=${Math.max(...wallArr)}`);

  // Termination breakdown
  const term: Record<string, number> = {};
  for (const e of evals) term[e.termination] = (term[e.termination] ?? 0) + 1;
  console.log(`\n-- termination reasons --`);
  for (const [t, c] of Object.entries(term).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${c} (${pct(c, n)}%)`);

  // Pathology prevalence
  const pathCount: Record<string, number> = {};
  for (const e of evals) for (const p of e.pathologies) pathCount[p] = (pathCount[p] ?? 0) + 1;
  console.log(`\n-- PATHOLOGIES (runs affected) --`);
  const sortedPath = Object.entries(pathCount).sort((a, b) => b[1] - a[1]);
  if (!sortedPath.length) console.log("  (none flagged)");
  for (const [p, c] of sortedPath) console.log(`  ${p}: ${c} (${pct(c, n)}%)`);

  const clean = evals.filter((e) => e.pathologies.length === 0).length;
  console.log(`\n  CLEAN runs (no pathology): ${clean}/${n} (${pct(clean, n)}%)`);

  // Worst offenders
  const worst = [...evals].sort((a, b) => b.pathologies.length - a.pathologies.length || b.iterations - a.iterations).slice(0, 12);
  console.log(`\n-- WORST OFFENDERS (top ${worst.length}) --`);
  for (const e of worst) {
    if (!e.pathologies.length) continue;
    console.log(`  ${e.conversationId} [${e.mode}] term=${e.termination} iters=${e.iterations} units=${e.units}`);
    console.log(`     ops=[${e.ops.join(",")}] repeated=[${e.repeatedOps.join(",")}] rtFail=${e.runtimeFailures} authzFail=${e.authzFailures} halluc=${e.hallucinated}`);
    console.log(`     pathologies: ${e.pathologies.join(", ")}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("LOOP-EVAL FAILED:", e); await prisma.$disconnect(); process.exit(1); });
