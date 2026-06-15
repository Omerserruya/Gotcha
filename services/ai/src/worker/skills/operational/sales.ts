/**
 * Sales operational skill.
 *
 * Authoritative source: distilled from the strategy contracts in
 * `services/ai/src/services/behavior-strategies.ts` (SALES_FOLLOWUP,
 * LEAD_QUALIFICATION). Phase 5 cutover will swap the legacy strategy
 * contract rendering for this skill's output.
 *
 * Behavior posture: drive conversion, qualify intent, surface
 * objections early, propose next-best action.
 */

import { defineSkill } from "../registry";

defineSkill({
  id: "sales",
  kind: "operational",
  name: "Sales",
  version: "1.0.0",
  toolsAdded: ["update_crm", "create_task", "schedule_followup"],
  toolsRequired: [],
  render: (ctx) => {
    const lines: string[] = [];
    lines.push("# Sales Posture");
    lines.push(
      "You drive conversions. Every turn either advances the deal or surfaces what's blocking it.",
    );
    lines.push("");
    lines.push("Priorities, in order:");
    lines.push("1. Understand the customer's actual need - not what they say first, but what they want.");
    lines.push("2. Qualify fit: budget, authority, need, timeline (BANT). Don't pitch what won't land.");
    lines.push("3. Surface objections early. Unresolved objections kill conversions late.");
    lines.push("4. Propose the next concrete step - a call, a demo, a doc, a discount - never end open-ended.");
    lines.push("");
    lines.push(
      "When the customer hedges, ask exactly one focused question to disambiguate. Do not interrogate.",
    );

    // Mode-aware autonomy hint - autonomous bot may also commit on its
    // own; copilot must defer to the human; callpilot suggests live.
    if (ctx.mode === "autonomous") {
      lines.push("");
      lines.push(
        "You may commit to scheduling, sending follow-ups, and updating the CRM without approval - subject to guardrails.",
      );
    } else if (ctx.mode === "copilot") {
      lines.push("");
      lines.push(
        "Propose actions for the human rep to approve. Never execute closure or schedule_followup yourself.",
      );
    } else if (ctx.mode === "callpilot") {
      lines.push("");
      lines.push(
        "Real-time call. Output ONLY the next sentence the rep should say or the next action to trigger. No analysis.",
      );
    }

    return lines.join("\n");
  },
});
