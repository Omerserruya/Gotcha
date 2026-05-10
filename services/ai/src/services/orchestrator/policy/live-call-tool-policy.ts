import type {
  PolicyDecision,
  ProposedAction,
  ToolDescriptor,
} from "../types";

/**
 * Decision rules for the Action Orchestrator.
 *
 * Encodes the safety contract from the architecture doc:
 *   - mutating + live  → ALWAYS propose-and-await-approval. No exceptions.
 *   - !mutating + mode in allowlist → auto-execute.
 *   - mutating + chat + requiresApproval → propose-and-await-approval.
 *   - mutating + chat + !requiresApproval → auto-execute (chat user is in the loop).
 *   - mutating + post-call → propose unless tenant-approved batch action.
 *   - otherwise → deny.
 */
export class LiveCallToolPolicy {
  evaluate(action: ProposedAction, tool: ToolDescriptor): PolicyDecision {
    const mode = action.proposedBy.mode;

    // Live mode never auto-executes mutating tools. Defense in depth: the
    // live LLM call also has an empty `tools` parameter, so the model
    // can't emit tool calls at all — only proposals via structured output.
    if (tool.mutating && mode === "live") {
      return {
        outcome: "propose-and-await-approval",
        reason: "live mode never auto-executes mutating tools",
      };
    }

    // Read-only: allowlist gate.
    if (!tool.mutating) {
      if (tool.autoExecuteAllowlist.includes(mode)) {
        return { outcome: "auto-execute", reason: "read-only tool, mode allowlisted" };
      }
      return {
        outcome: "deny",
        reason: `read-only tool not allowlisted for mode "${mode}"`,
      };
    }

    // Mutating in chat: requiresApproval flag decides.
    if (mode === "chat") {
      if (tool.requiresApproval) {
        return {
          outcome: "propose-and-await-approval",
          reason: "chat tool flagged requiresApproval",
        };
      }
      // The chat user is reviewing each turn before the assistant sends — the
      // existing UX is the implicit approval gate for non-flagged mutating tools.
      return { outcome: "auto-execute", reason: "chat tool, no explicit approval required" };
    }

    // Mutating in post-call: default to propose. Tenant can later configure
    // batch auto-execute for specific tools, but Phase 4 ships safe-by-default.
    if (mode === "post-call") {
      return {
        outcome: "propose-and-await-approval",
        reason: "post-call mutating action — default safe (propose)",
      };
    }

    return { outcome: "deny", reason: "no rule matched" };
  }
}
