/**
 * Skill composer invariants.
 *
 * The load-bearing property: `composeSkills(ctx, ids)` is BYTE-STABLE
 * for the same input. This is what makes the OpenAI prefix cache hit
 * across turns in a session. If this test ever breaks, the cache
 * contract is broken.
 */

import { describe, it, expect, beforeAll } from "vitest";
import "../skills"; // side-effect: register system skills
import { composeSkills } from "../skills/registry";
import type { SkillRenderContext } from "../types";

const baseCtx: SkillRenderContext = {
  mode: "autonomous",
  identity: { name: "Test Worker", persona: "friendly", language: "en" },
  guardrails: {
    blockedTopics: [],
    escalationKeywords: [],
    refundRequiresApproval: true,
    customRules: [],
  },
  locale: "en",
  pipeline: {
    funnelId: "funnel_1",
    currentStageId: "discovery",
    currentStageLabel: "Discovery",
    nextStageId: "demo",
    nextStageLabel: "Demo",
  },
};

describe("composeSkills", () => {
  it("is byte-stable for the same input", () => {
    const a = composeSkills(baseCtx, ["sales", "tool_usage_policy", "pipeline_transitions"]);
    const b = composeSkills(baseCtx, ["sales", "tool_usage_policy", "pipeline_transitions"]);
    expect(a.text).toBe(b.text);
    expect(a.text.length).toBeGreaterThan(0);
  });

  it("changes byte-for-byte when skill order changes", () => {
    const a = composeSkills(baseCtx, ["sales", "tool_usage_policy"]);
    const b = composeSkills(baseCtx, ["tool_usage_policy", "sales"]);
    expect(a.text).not.toBe(b.text);
  });

  it("drops empty fragments cleanly (no header for unused skills)", () => {
    // hebrew_natural_speech returns "" when locale != "he"
    const englishCtx: SkillRenderContext = { ...baseCtx, locale: "en" };
    const result = composeSkills(englishCtx, ["sales", "hebrew_natural_speech", "tool_usage_policy"]);
    expect(result.text).not.toContain("עברית");
    expect(result.skillIds).toEqual(["sales", "tool_usage_policy"]);
  });

  it("renders hebrew skill when locale is 'he'", () => {
    const heCtx: SkillRenderContext = { ...baseCtx, locale: "he" };
    const result = composeSkills(heCtx, ["sales", "hebrew_natural_speech"]);
    expect(result.text).toContain("עברית");
  });

  it("reports missing skill ids without dropping them silently", () => {
    const result = composeSkills(baseCtx, ["sales", "does_not_exist", "tool_usage_policy"]);
    expect(result.missing).toEqual(["does_not_exist"]);
    expect(result.skillIds).toEqual(["sales", "tool_usage_policy"]);
  });

  it("collects toolsAdded from all rendered skills (deduped, order-preserving)", () => {
    const result = composeSkills(baseCtx, ["sales", "support"]);
    // sales contributes: update_crm, create_task, schedule_followup
    // support contributes: get_contact, list_recent_messages, create_ticket, tag_contact
    expect(result.toolsAdded).toEqual([
      "update_crm",
      "create_task",
      "schedule_followup",
      "get_contact",
      "list_recent_messages",
      "create_ticket",
      "tag_contact",
    ]);
  });

  it("mode shift changes rendered content (autonomous vs copilot vs callpilot)", () => {
    const auto = composeSkills({ ...baseCtx, mode: "autonomous" }, ["sales"]);
    const copilot = composeSkills({ ...baseCtx, mode: "copilot" }, ["sales"]);
    const callpilot = composeSkills({ ...baseCtx, mode: "callpilot" }, ["sales"]);
    expect(auto.text).not.toBe(copilot.text);
    expect(copilot.text).not.toBe(callpilot.text);
    expect(auto.text).not.toBe(callpilot.text);
  });

  it("pipeline_transitions drops silently when no funnel is attached", () => {
    const noFunnelCtx: SkillRenderContext = { ...baseCtx, pipeline: undefined };
    const result = composeSkills(noFunnelCtx, ["pipeline_transitions"]);
    expect(result.text).toBe("");
    expect(result.skillIds).toEqual([]);
  });
});
