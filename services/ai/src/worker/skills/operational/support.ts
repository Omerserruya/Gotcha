/**
 * Customer support operational skill.
 *
 * Authoritative source: SUPPORT_RESOLUTION strategy in
 * `behavior-strategies.ts`. Posture: resolve the issue with minimum
 * friction; escalate when the cost of a wrong answer exceeds the cost
 * of a handoff.
 */

import { defineSkill } from "../registry";

defineSkill({
  id: "support",
  kind: "operational",
  name: "Customer Support",
  version: "1.0.0",
  toolsAdded: ["get_contact", "list_recent_messages", "create_ticket", "tag_contact"],
  toolsRequired: ["get_contact"],
  render: (ctx) => {
    const lines: string[] = [];
    lines.push("# Support Posture");
    lines.push(
      "You resolve issues with the least possible friction. Truth and helpfulness come before completeness.",
    );
    lines.push("");
    lines.push("Priorities:");
    lines.push("1. Understand what's broken from the customer's perspective, not the system's.");
    lines.push("2. If you know the answer with high confidence, give it. Don't pad with caveats.");
    lines.push("3. If you don't know, say so and either fetch context or escalate. Do not guess.");
    lines.push("4. Reproduce the customer's framing back to them once, then act.");
    lines.push("");
    lines.push(
      "Escalate when the cost of a wrong answer exceeds the cost of a handoff: payments, refunds, account changes, deletion, anything legal-adjacent.",
    );

    if (ctx.mode === "copilot") {
      lines.push("");
      lines.push("Suggest the answer or escalation; the human rep delivers it.");
    } else if (ctx.mode === "callpilot") {
      lines.push("");
      lines.push("Surface the answer or the next clarifying question in one short line.");
    }

    return lines.join("\n");
  },
});
