import type { ToolDescriptor, RuntimeMode } from "./types";

/**
 * Tool descriptor lookup for the policy engine.
 *
 * Phase 4 ships a hardcoded allowlist for known tools and a SAFE-BY-DEFAULT
 * fallback for unknown tools (mutating + requiresApproval). The fallback
 * is the load-bearing safety property: an unregistered tool can never
 * auto-execute on any mode.
 *
 * A future polish pass can promote this to a per-tenant config table
 * (MissingFieldDefinition-style), letting operators tune what auto-runs
 * in chat vs propose-only. Phase 4 doesn't block on that.
 */

const ALL_MODES: RuntimeMode[] = ["chat", "live", "post-call"];

const KNOWN_TOOLS: Record<string, Omit<ToolDescriptor, "name">> = {
  // ── Read-only (auto-execute everywhere) ──
  searchKnowledge: {
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },
  knowledge_search: {
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },
  lookupCustomer: {
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },
  lookup_contact: {
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },
  link_customer_identifier: {
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },
  submit_suggestions: {
    // Internal LLM-loop terminator - always safe.
    mutating: false,
    requiresApproval: false,
    autoExecuteAllowlist: [...ALL_MODES],
  },

  // ── Mutating, low-friction in chat (auto in chat; never live; propose post-call) ──
  add_note: {
    mutating: true,
    requiresApproval: false,
    autoExecuteAllowlist: ["chat"],
  },
  tag_contact: {
    mutating: true,
    requiresApproval: false,
    autoExecuteAllowlist: ["chat"],
  },
  update_contact_field: {
    mutating: true,
    requiresApproval: false,
    autoExecuteAllowlist: ["chat"],
  },

  // ── Mutating, always require approval ──
  apply_discount: {
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  },
  issue_refund: {
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  },
  send_message: {
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  },
  schedule_meeting: {
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  },
  escalate_to_human: {
    // Escalation is critical and infrequent; require explicit operator nod.
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  },
};

export function getToolDescriptor(name: string): ToolDescriptor {
  const known = KNOWN_TOOLS[name];
  if (known) return { name, ...known };
  // Unknown tools default to mutating + requiresApproval. This is the
  // load-bearing default - anything not registered cannot slip through
  // as auto-execute on any mode.
  return {
    name,
    mutating: true,
    requiresApproval: true,
    autoExecuteAllowlist: [],
  };
}
