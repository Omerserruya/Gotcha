/** Where a turn's time goes (2026-10-25): stage milestones on the ai.bot_turn audit. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");

describe("★ stageMs on ai.bot_turn", () => {
  it("each milestone is marked once, in turn order", () => {
    const order = ["history", "knowledge", "prompt_ready", "model_done", "checker_done"].map((k) => src.indexOf(`markStage("${k}")`));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("the audit carries them with the time the reply was ready", () => {
    expect(src).toContain("stageMs: { ...stageMs, reply_ready: Date.now() - turnStartedAt },");
  });
});
