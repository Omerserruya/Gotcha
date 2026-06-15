/**
 * Smoke test for the copilot request-dedup layer.
 *
 * Exercises the three code paths of `runDeduped`:
 *   1. "primary"   - first request runs fn
 *   2. "attached"  - concurrent requests with same key share one fn run
 *   3. "idempotent" - same requestInstanceId returns cached result
 *
 * Plus failure-mode invariants:
 *   4. Rejected fn does NOT poison the slot - next call runs fresh
 *   5. Pruner does not blow up after many idempotency entries
 *
 * Run inside the ai container after rebuild:
 *   docker compose exec ai npx tsx /app/scripts/smoke-copilot-dedup.ts
 *
 * Exits 0 on PASS, 1 on FAIL.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
import {
  runDeduped,
  __resetCopilotDedupForTests,
  getCopilotDedupStats,
} from "../services/ai/src/services/copilot-dedup.service";

type Row = { name: string; pass: boolean; detail: string };
const results: Row[] = [];

function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}${detail ? "  - " + detail : ""}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ── 1. Primary path runs fn exactly once ───────────────────
  {
    __resetCopilotDedupForTests();
    let called = 0;
    const out = await runDeduped({
      key: "conv:1",
      requestInstanceId: "ri-A",
      fn: async () => { called++; return "value-A"; },
    });
    record(
      "primary returns fn result + reason=primary",
      out.result === "value-A" && out.reason === "primary" && called === 1,
      `reason=${out.reason} result=${out.result} called=${called}`,
    );
  }

  // ── 2. Concurrent requests attach to in-flight Promise ────
  {
    __resetCopilotDedupForTests();
    let called = 0;
    let release: () => void = () => {};
    const block = new Promise<void>((r) => { release = r; });
    const work = async () => { called++; await block; return "value-B"; };

    const p1 = runDeduped({ key: "conv:2", requestInstanceId: "ri-B1", fn: work });
    // Wait a tick so p1 establishes the in-flight entry before p2 lands.
    await sleep(10);
    const p2 = runDeduped({ key: "conv:2", requestInstanceId: "ri-B2", fn: work });
    const p3 = runDeduped({ key: "conv:2", requestInstanceId: "ri-B3", fn: work });

    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    record(
      "concurrent calls share one fn invocation",
      called === 1 &&
        r1.reason === "primary" &&
        r2.reason === "attached" &&
        r3.reason === "attached" &&
        r1.result === "value-B" &&
        r2.result === "value-B" &&
        r3.result === "value-B",
      `called=${called} reasons=[${r1.reason},${r2.reason},${r3.reason}]`,
    );
  }

  // ── 3. Idempotency cache short-circuits repeat instance ids
  {
    __resetCopilotDedupForTests();
    let called = 0;
    const out1 = await runDeduped({
      key: "conv:3",
      requestInstanceId: "ri-C",
      fn: async () => { called++; return "value-C"; },
    });
    // Same instance id, totally different fn - must NOT run.
    const out2 = await runDeduped({
      key: "conv:3",
      requestInstanceId: "ri-C",
      fn: async () => { called++; return "WRONG"; },
    });
    record(
      "same requestInstanceId returns cached result without rerunning fn",
      out1.result === "value-C" &&
        out2.result === "value-C" &&
        out2.reason === "idempotent" &&
        called === 1,
      `called=${called} out2.reason=${out2.reason} out2.result=${out2.result}`,
    );
  }

  // ── 4. Different instance id, same key, sequential → "primary" twice (in-flight cleared)
  {
    __resetCopilotDedupForTests();
    let called = 0;
    const out1 = await runDeduped({
      key: "conv:4",
      requestInstanceId: "ri-D1",
      fn: async () => { called++; return "v1"; },
    });
    const out2 = await runDeduped({
      key: "conv:4",
      requestInstanceId: "ri-D2",
      fn: async () => { called++; return "v2"; },
    });
    record(
      "sequential distinct ids run fn twice",
      called === 2 && out1.reason === "primary" && out2.reason === "primary" && out2.result === "v2",
      `called=${called} reasons=[${out1.reason},${out2.reason}]`,
    );
  }

  // ── 5. Failure does not poison the in-flight slot ─────────
  {
    __resetCopilotDedupForTests();
    let called = 0;
    try {
      await runDeduped({
        key: "conv:5",
        requestInstanceId: "ri-E1",
        fn: async () => { called++; throw new Error("boom"); },
      });
      record("failure throws (1)", false, "expected throw");
    } catch (err: any) {
      // Expected
    }
    const stats = getCopilotDedupStats();
    const slotCleared = stats.inflight === 0;
    // Now a second call with a DIFFERENT key+instance must succeed.
    const out = await runDeduped({
      key: "conv:5",
      requestInstanceId: "ri-E2",
      fn: async () => { called++; return "recovered"; },
    });
    record(
      "rejected fn cleans inflight slot; next call succeeds",
      slotCleared && called === 2 && out.result === "recovered" && out.reason === "primary",
      `slotCleared=${slotCleared} called=${called} reason=${out.reason}`,
    );
  }

  // ── 6. Stats reflect cached idempotency entries ───────────
  {
    __resetCopilotDedupForTests();
    for (let i = 0; i < 20; i++) {
      await runDeduped({
        key: `conv:bulk:${i}`,
        requestInstanceId: `ri-bulk-${i}`,
        fn: async () => i,
      });
    }
    const stats = getCopilotDedupStats();
    record(
      "after 20 primaries, idempotent cache holds 20, inflight is 0",
      stats.inflight === 0 && stats.idempotent === 20,
      `inflight=${stats.inflight} idempotent=${stats.idempotent}`,
    );
  }

  // ── Summary ───────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("");
  console.log(`──────────────────────────────────────────────`);
  console.log(`Total: ${results.length}  Passed: ${passed}  Failed: ${failed}`);
  console.log(`──────────────────────────────────────────────`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
