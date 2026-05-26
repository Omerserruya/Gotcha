/**
 * AI Employee end-to-end smoke test.
 *
 * Validates the four spec contracts that fail-silent in production:
 *
 *   1. Skills registry is populated (system skills self-registered).
 *   2. Skill composition is byte-stable for a given (ctx, skillIds).
 *   3. Prompt builder is byte-stable across two builds with identical
 *      inputs — this is what the cached-prefix strategy depends on.
 *   4. Per-block layout is correct: per-agent / per-conv / per-turn
 *      separators in the expected order. If a per-turn-only field
 *      (like behaviorState.toneIntensity) leaks into the per-agent
 *      block, the per-turn drift breaks the cache prefix.
 *
 * Run:
 *   docker compose exec ai npx tsx /app/scripts/smoke-ai-employee.ts
 *
 * Exits 0 on PASS, 1 on FAIL — suitable for CI integration.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
import { createHash } from "crypto";

type ResultRow = { name: string; pass: boolean; detail: string };
const results: ResultRow[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  // eslint-disable-next-line no-console
  console.log(`  ${tag}  ${name}\n         ${detail}`);
}

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("\n── AI Employee smoke test ────────────────────────────\n");

  // ── 1. Skills registry populated ─────────────────────────────
  const skillsMod = await import("../services/ai/src/worker/skills");
  const skills = skillsMod.listSkillMetadata();
  record(
    "Skills registry populated",
    skills.length >= 5,
    `registered=${skills.length}: ${skills.map((s) => s.id).join(", ")}`,
  );
  const expectedSkillIds = [
    "sales",
    "support",
    "hebrew-natural-speech",
    "tool-usage-policy",
    "pipeline-transitions",
  ];
  const missing = expectedSkillIds.filter((id) => !skills.find((s) => s.id === id));
  record(
    "All expected core skills present",
    missing.length === 0,
    missing.length === 0 ? "all 5 baseline skills registered" : `missing: ${missing.join(", ")}`,
  );

  // ── 2. composeSkills is byte-stable for identical ctx + ids ──
  const ctx = {
    mode: "autonomous" as const,
    identity: { name: "Test", language: "en" },
    guardrails: {
      blockedTopics: [],
      escalationKeywords: [],
      refundRequiresApproval: true,
      customRules: [],
    },
    locale: "en",
    pipeline: undefined,
  };
  const composeA = skillsMod.composeSkills(ctx, ["sales", "tool-usage-policy"]);
  const composeB = skillsMod.composeSkills(ctx, ["sales", "tool-usage-policy"]);
  record(
    "Skill composition is byte-stable",
    composeA.fragment === composeB.fragment,
    `composeA.hash=${sha16(composeA.fragment)} composeB.hash=${sha16(composeB.fragment)}`,
  );
  record(
    "Order matters (different order → different output)",
    composeA.fragment !== skillsMod.composeSkills(ctx, ["tool-usage-policy", "sales"]).fragment,
    "verified",
  );

  // ── 3. buildAgentPrompt is byte-stable across two builds ────
  const promptMod = await import("../services/ai/src/services/prompt-builder.service");
  const behaviorMod = await import("../services/ai/src/services/behavior-engine.service");

  const stableBehaviorState = behaviorMod.computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "Hello, I'm interested in your product.", messageCount: 1 },
  });
  const stableOpts = {
    behaviorState: stableBehaviorState,
    agent: {
      name: "Smoke Test Agent",
      role: "sales",
      tone: "professional",
      style: { useEmojis: false, concise: true },
      identity: { role: "Sales rep" },
      persona: { gender: "neutral" },
    },
    toolFunctionNames: ["integration_create_lead", "schedule_followup"],
  };

  const promptA = promptMod.buildAgentPrompt(stableOpts as any);
  const promptB = promptMod.buildAgentPrompt(stableOpts as any);
  record(
    "buildAgentPrompt is byte-stable for identical input",
    promptA === promptB,
    `hashA=${sha16(promptA)} hashB=${sha16(promptB)}`,
  );

  // ── 4. Three-block layout present + ordering correct ───────
  const blocks = promptA.split("\n\n---\n\n");
  record(
    "Prompt has 3 blocks separated by ---",
    blocks.length === 3,
    `block count = ${blocks.length}`,
  );
  if (blocks.length === 3) {
    const [agentBlock, convBlock, turnBlock] = blocks;
    record(
      "Block 1 (per-agent) starts with # Identity",
      agentBlock?.trimStart().startsWith("# Identity") ?? false,
      `first 60 chars: ${agentBlock?.slice(0, 60).replace(/\n/g, "\\n")}`,
    );
    record(
      "Block 3 (per-turn) contains BEL Conversation State",
      turnBlock?.includes("## Conversation State") ?? false,
      "Conversation State must live in per-turn (changes every message)",
    );
    record(
      "Per-agent block has NO BEL toneIntensity (would break cache)",
      !(agentBlock?.includes("Tone intensity (this turn)") ?? false),
      "toneIntensity must be in per-turn block only",
    );
    record(
      "Per-conv block has NO BEL strategy",
      !(convBlock?.includes("Active strategy:") ?? false),
      "strategy must be in per-turn block only",
    );
    record(
      "Per-turn block contains # Tools",
      turnBlock?.includes("# Tools") ?? false,
      "tools policy is BEL-driven, must be per-turn",
    );
  }

  // ── 5. Changing only per-turn input keeps the per-agent prefix stable ──
  const stableOpts2 = {
    ...stableOpts,
    behaviorState: behaviorMod.computeBehaviorState({
      mode: "agent",
      identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
      request: { lastMessage: "What's your pricing?", messageCount: 5 },
    }),
  };
  const promptC = promptMod.buildAgentPrompt(stableOpts2 as any);
  const agentBlockA = promptA.split("\n\n---\n\n")[0];
  const agentBlockC = promptC.split("\n\n---\n\n")[0];
  record(
    "Per-agent block byte-stable when only per-turn changes",
    agentBlockA === agentBlockC,
    `agentBlockA.hash=${sha16(agentBlockA ?? "")} agentBlockC.hash=${sha16(agentBlockC ?? "")}`,
  );

  // ── 6. Stage context renders Pipeline Stage block ──────────
  const stageOpts = {
    ...stableOpts,
    stageContext: {
      id: "qualified",
      label: "Qualified Lead",
      nextLabel: "Demo Scheduled",
      copilot: {
        goal: "Confirm budget and decision-maker.",
        requiredQuestions: [{ id: "q1", text: "What's your budget?", required: true }],
        requiredDataFields: [{ field: "budget", label: "Budget", required: true }],
        exitCriteria: { mustHaveFields: ["budget"], positiveSignals: ["send me a proposal"] },
      },
    },
  };
  const promptD = promptMod.buildAgentPrompt(stageOpts as any);
  record(
    "stageContext renders Pipeline Stage block",
    promptD.includes("# Pipeline Stage (this turn)") &&
      promptD.includes("Qualified Lead") &&
      promptD.includes("Confirm budget"),
    "block present with label + goal",
  );
  record(
    "Stage block lives in per-turn (block 3) — not per-agent",
    !((promptD.split("\n\n---\n\n")[0] ?? "").includes("Pipeline Stage")),
    "must be per-turn so stage transitions don't break cache prefix",
  );

  // ── Summary ──────────────────────────────────────────────────
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  // eslint-disable-next-line no-console
  console.log(
    `\n── Summary: \x1b[32m${pass} PASS\x1b[0m / \x1b[31m${fail} FAIL\x1b[0m ─────────────\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[smoke] uncaught:", err);
  process.exit(1);
});
