/**
 * BOOK_MEETING write-path shadow evidence - isolates every persisted kernel iteration
 * whose proposedOperation is a calendar WRITE and scores it deterministically from the
 * Runtime trace. Also checks, per loop, whether a would-execute BOOK that SKIPPED the
 * `time_genuinely_open` SHOULD was preceded by a CHECK_AVAILABILITY in the same loop
 * (skip-after-check = safe/redundant; skip-without-check = the double-booking gap).
 */
import { prisma } from "@chatcenter/shared";

const WRITES = new Set(["BOOK_MEETING", "MOVE_MEETING", "CANCEL_MEETING"]);

async function main() {
  const iters: any[] = await (prisma as any).agentLoopIteration.findMany({ orderBy: [{ loopId: "asc" }, { iteration: "asc" }] });
  const writeIters = iters.filter((i) => WRITES.has(i.proposedOperation));

  const byLoop: Record<string, any[]> = {};
  for (const it of iters) (byLoop[it.loopId] ??= []).push(it);

  const byOp: Record<string, any[]> = {};
  for (const it of writeIters) (byOp[it.proposedOperation] ??= []).push(it);

  console.log(`\n=== CALENDAR WRITE-PATH SHADOW EVIDENCE ===`);
  console.log(`persisted iterations: ${iters.length}; calendar-write proposals: ${writeIters.length}\n`);

  let skipNoCheck = 0, skipAfterCheck = 0;
  for (const op of Object.keys(byOp)) {
    const rows = byOp[op];
    let recommended = 0, executed = 0, gated = 0, wouldViolate = 0, malformed = 0, openSkipped = 0, openHeld = 0;
    const VALID = new Set(["EXECUTED", "RECOMMENDED", "NEEDS_INPUT", "BLOCKED", "FAILED", "DENIED"]);
    for (const it of rows) {
      const rt = it.runtimeResult;
      const obs = it.observation || {};
      const summary: string = obs.invariantSummary || "";
      const parts = summary.split(",").map((s: string) => s.trim());
      const violated = parts.filter((s) => /:(violated|unsatisfied)$/.test(s));
      const openSkip = parts.some((s) => /^time_genuinely_open:skipped_should$/.test(s));
      const openHold = parts.some((s) => /^time_genuinely_open:held$/.test(s));
      if (rt && !VALID.has(rt)) malformed++;
      if (rt === "RECOMMENDED") recommended++;
      if (rt === "EXECUTED") executed++;
      if (rt === "NEEDS_INPUT" || rt === "BLOCKED") gated++;
      if (violated.length && (rt === "EXECUTED" || rt === "RECOMMENDED")) wouldViolate++;
      if ((rt === "RECOMMENDED" || rt === "EXECUTED") && openSkip) {
        openSkipped++;
        const loopRows = byLoop[it.loopId] || [];
        const checkedEarlier = loopRows.some((r) => r.proposedOperation === "CHECK_AVAILABILITY" && r.iteration <= it.iteration);
        if (checkedEarlier) skipAfterCheck++; else skipNoCheck++;
        console.log(`  [gap-probe] loop=${it.loopId} iter=${it.iteration} BOOK skipped open-check; CHECK earlier in loop? ${checkedEarlier ? "YES (redundant/safe)" : "NO (double-book risk)"}`);
      }
      if ((rt === "RECOMMENDED" || rt === "EXECUTED") && openHold) openHeld++;
    }
    console.log(`\n  ${op} SUMMARY (n=${rows.length}): RECOMMENDED=${recommended} EXECUTED=${executed} gated=${gated} malformed=${malformed} wouldViolateMUST=${wouldViolate}`);
    console.log(`    would-execute open-check: held=${openHeld} skipped=${openSkipped}`);
    console.log(`    → shadow real-writes: ${executed === 0 ? "0 (correct)" : "WARN " + executed}; MUST invariants ${wouldViolate === 0 ? "held ok" : "FAIL"}`);
  }
  console.log(`\n=== AUTONOMOUS-READINESS GATE (BOOK_MEETING) ===`);
  console.log(`  open-check skipped WITHOUT a prior CHECK in-loop (real double-book risk): ${skipNoCheck}`);
  console.log(`  open-check skipped WITH a prior CHECK in-loop (redundant, safe):          ${skipAfterCheck}`);
  console.log(`  VERDICT: ${skipNoCheck === 0 ? "no unguarded books - BOOK_MEETING write-path SAFE for autonomous" : "harden check-before-book before autonomous flip"}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("BOOK-EVIDENCE FAILED:", e); await prisma.$disconnect(); process.exit(1); });
