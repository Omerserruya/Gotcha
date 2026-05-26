/**
 * Tool policy invariants.
 *
 * Locks the saved-memory rules:
 *   - copilot must NOT surface close_conversation / schedule_followup
 *   - callpilot must NOT surface ANY mutating tool during the live call
 *   - autonomous gets the full surface (subject to tenant overrides)
 */

import { describe, it, expect } from "vitest";
import {
  decideToolPolicy,
  COPILOT_FORBIDDEN_TOOLS,
  MUTATING_TOOLS,
} from "../tools/policy";

const fullSkillToolset = [
  // read
  "get_contact",
  "list_recent_messages",
  // safe mutations
  "update_crm",
  "send_message",
  // bot-surface actions
  "close_conversation",
  "schedule_followup",
  "schedule_followup_template",
  "create_task",
  "escalate_to_human",
];

describe("decideToolPolicy", () => {
  it("autonomous mode surfaces every skill-granted tool", () => {
    const decision = decideToolPolicy({
      mode: "autonomous",
      skillToolsAdded: fullSkillToolset,
    });
    expect(decision.allowed).toEqual(fullSkillToolset);
    expect(Object.keys(decision.rejections)).toEqual([]);
  });

  it("copilot mode strips close_conversation, schedule_followup, create_task, schedule_meeting", () => {
    const decision = decideToolPolicy({
      mode: "copilot",
      skillToolsAdded: fullSkillToolset,
    });
    expect(decision.allowed).not.toContain("close_conversation");
    expect(decision.allowed).not.toContain("schedule_followup");
    expect(decision.allowed).not.toContain("schedule_followup_template");
    expect(decision.allowed).not.toContain("create_task");
    expect(decision.rejections["close_conversation"]).toBe("copilot-forbidden");
    // copilot still keeps read tools + send_message + update_crm
    expect(decision.allowed).toContain("get_contact");
    expect(decision.allowed).toContain("send_message");
    expect(decision.allowed).toContain("update_crm");
  });

  it("callpilot mode strips ALL mutating tools (zero-tool live posture)", () => {
    const decision = decideToolPolicy({
      mode: "callpilot",
      skillToolsAdded: fullSkillToolset,
    });
    for (const t of decision.allowed) {
      expect(MUTATING_TOOLS.has(t)).toBe(false);
    }
    // Read-only tools still pass
    expect(decision.allowed).toContain("get_contact");
    expect(decision.allowed).toContain("list_recent_messages");
  });

  it("tenant denylist overrides every other rule (autonomous)", () => {
    const decision = decideToolPolicy({
      mode: "autonomous",
      skillToolsAdded: ["send_message", "update_crm"],
      tenantDenylist: ["send_message"],
    });
    expect(decision.allowed).toEqual(["update_crm"]);
    expect(decision.rejections["send_message"]).toBe("tenant-deny");
  });

  it("tenant allowlist intersects (only listed tools survive)", () => {
    const decision = decideToolPolicy({
      mode: "autonomous",
      skillToolsAdded: ["send_message", "update_crm", "get_contact"],
      tenantAllowlist: ["update_crm"],
    });
    expect(decision.allowed).toEqual(["update_crm"]);
    expect(decision.rejections["send_message"]).toBe("not-in-tenant-allowlist");
    expect(decision.rejections["get_contact"]).toBe("not-in-tenant-allowlist");
  });

  it("empty tenant allowlist is treated as 'no allowlist' (everything passes)", () => {
    const decision = decideToolPolicy({
      mode: "autonomous",
      skillToolsAdded: ["send_message", "update_crm"],
      tenantAllowlist: [],
    });
    expect(decision.allowed).toEqual(["send_message", "update_crm"]);
  });

  it("dedups skill-added tools while preserving order", () => {
    const decision = decideToolPolicy({
      mode: "autonomous",
      skillToolsAdded: ["update_crm", "send_message", "update_crm", "get_contact"],
    });
    expect(decision.allowed).toEqual(["update_crm", "send_message", "get_contact"]);
  });

  it("summary line includes mode + allowed/total counts", () => {
    const decision = decideToolPolicy({
      mode: "copilot",
      skillToolsAdded: ["update_crm", "close_conversation"],
    });
    expect(decision.summary).toContain("mode=copilot");
    expect(decision.summary).toContain("allowed=1/2");
    expect(decision.summary).toContain("close_conversation:copilot-forbidden");
  });

  it("COPILOT_FORBIDDEN_TOOLS contains the saved-memory invariant set", () => {
    // Re-asserting the constant so anyone who removes a tool from the
    // forbidden list trips this test and has to acknowledge the
    // memory rule before merging.
    expect(COPILOT_FORBIDDEN_TOOLS.has("close_conversation")).toBe(true);
    expect(COPILOT_FORBIDDEN_TOOLS.has("schedule_followup")).toBe(true);
  });
});
