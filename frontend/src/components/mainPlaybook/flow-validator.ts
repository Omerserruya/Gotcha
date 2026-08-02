/**
 * Flow validator.
 *
 * Inspects the current canvas graph (nodes + edges) and returns a list of
 * human-readable issues. The UI renders these in a "N issues" pill in the
 * toolbar - clicking expands a panel that lets the author jump to the
 * offending node.
 *
 * The rules here intentionally skew toward *nudging* rather than blocking
 * save. A flow with warnings still saves and runs; the runtime is tolerant
 * enough (missing text = skipped send, missing target = unassigned, etc.)
 * that a work-in-progress flow shouldn't be punished.
 */

export type IssueSeverity = "error" | "warning";

export interface FlowIssue {
  id: string;              // stable id for React keys (node_id + rule)
  severity: IssueSeverity;
  nodeId?: string;         // present when the issue points at a specific node
  title: string;           // short label shown in the pill list
  message: string;         // longer explanation shown when expanded
}

interface Node { id: string; type: string; data?: any; }
interface Edge { id: string; source: string; target: string; sourceHandle?: string | null; }

// Types that terminate a branch and so don't need an outgoing edge.
const TERMINAL_TYPES = new Set([
  "end",
  "route_target",
  "default_fallback",
]);

// Types that are legitimate flow entries (no incoming edge expected).
const ENTRY_TYPES = new Set([
  "channel_entry",
  "start",
  "keyword_trigger",
  "comment_trigger",
  "schedule_trigger",
]);

// Types that define or produce a variable.
const VAR_DEFINING_TYPES = new Set([
  "collect_input",
  "set_variable",
  "http_request",
  "ai_generate",
  "bring_user_data",
]);

// Built-in vars the runtime provides without any node defining them.
const BUILT_IN_VARS = new Set(["message", "channel", "customer_id"]);

export function validateFlow(nodes: Node[], edges: Edge[]): FlowIssue[] {
  const issues: FlowIssue[] = [];

  // ── Rule 1: at least one entry point ──────────────────────────
  const entries = nodes.filter((n) => ENTRY_TYPES.has(n.type));
  if (nodes.length > 0 && entries.length === 0) {
    issues.push({
      id: "no_entry",
      severity: "error",
      title: "No entry point",
      message:
        "Add a Channel Entry, Start, or Keyword Trigger so the flow knows where to begin.",
    });
  }

  // ── Rule 1b: duplicate singleton static nodes (parity with the backend
  //    graph-validator's duplicate_entry). Two starts / default fallbacks are
  //    ambiguous. ────────────────────────────────────────────────
  const SINGLETON_TYPES = new Set(["start", "default_fallback"]);
  const singletonCounts = new Map<string, number>();
  for (const n of nodes) {
    if (SINGLETON_TYPES.has(n.type)) singletonCounts.set(n.type, (singletonCounts.get(n.type) ?? 0) + 1);
  }
  for (const [type, count] of Array.from(singletonCounts.entries())) {
    if (count > 1) {
      issues.push({
        id: `duplicate_${type}`,
        severity: "error",
        title: `More than one ${friendlyType(type)}`,
        message: `A process can only have one ${friendlyType(type)}. Remove the extra one.`,
      });
    }
  }

  // ── Rule 1c: wait/delay validity (parity with backend invalid_delay) ──
  for (const n of nodes) {
    if (n.type !== "wait") continue;
    const dur = (n.data as any)?.durationMs;
    if (dur == null) {
      issues.push({ id: `${n.id}__no_delay`, severity: "warning", nodeId: n.id, title: "Wait has no delay set", message: "Set how long this step should pause, or it will not wait." });
    } else if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= 0) {
      issues.push({ id: `${n.id}__bad_delay`, severity: "error", nodeId: n.id, title: "Wait has an invalid delay", message: "The delay must be a positive amount of time." });
    }
  }

  // ── Rule 2: per-node required fields and outgoing edges ───────
  const defined = collectDefinedVars(nodes);

  for (const n of nodes) {
    const outgoing = edges.filter((e) => e.source === n.id);
    const hasOutgoing = outgoing.length > 0;

    // Required fields per node type
    const missing = missingRequiredFields(n);
    for (const m of missing) {
      issues.push({
        id: `${n.id}__missing_${m.key}`,
        severity: "error",
        nodeId: n.id,
        title: `${friendlyType(n.type)}: "${m.label}" is empty`,
        message: m.hint,
      });
    }

    // Outgoing edge expectations
    if (!TERMINAL_TYPES.has(n.type) && !hasOutgoing) {
      issues.push({
        id: `${n.id}__no_outgoing`,
        severity: "warning",
        nodeId: n.id,
        title: `${friendlyType(n.type)} goes nowhere`,
        message:
          "This node has no next step - the flow will halt here. Connect it to another node or an End node.",
      });
    }

    // Condition needs BOTH "true" and "false" handles wired (or an "else"
    // path will silently drop).
    if (n.type === "condition_group") {
      const handles = new Set(outgoing.map((e) => String(e.sourceHandle || "")));
      if (!handles.has("true")) {
        issues.push({
          id: `${n.id}__no_true_branch`,
          severity: "warning",
          nodeId: n.id,
          title: "Condition has no “Match” branch",
          message: "Connect the green Match handle to whatever should happen when the condition passes.",
        });
      }
      if (!handles.has("false")) {
        issues.push({
          id: `${n.id}__no_false_branch`,
          severity: "warning",
          nodeId: n.id,
          title: "Condition has no “No match” branch",
          message: "Connect the red No match handle so the flow doesn't silently drop when the condition fails.",
        });
      }
    }

    // Quick reply with fewer than 1 valid option
    if (n.type === "send_message_quick_reply") {
      const replies = Array.isArray(n.data?.replies) ? n.data.replies : [];
      const nonEmpty = replies.filter((r: any) => String(r?.label || "").trim());
      if (nonEmpty.length === 0) {
        issues.push({
          id: `${n.id}__empty_replies`,
          severity: "error",
          nodeId: n.id,
          title: "Quick Reply has no options",
          message: "Add at least one option users can tap.",
        });
      }
    }

    // ── Rule 3: variable references point to something real ─────
    for (const usage of collectVarUsages(n)) {
      if (defined.has(usage) || BUILT_IN_VARS.has(usage)) continue;
      issues.push({
        id: `${n.id}__undef_var_${usage}`,
        severity: "warning",
        nodeId: n.id,
        title: `Unknown variable {{${usage}}}`,
        message: `No node defines "${usage}" yet - this will render as empty text at runtime. Add a Collect Input / Set Variable / HTTP Request node that sets it, or pick from the {x} menu.`,
      });
    }
  }

  // ── Rule 4: dangling non-entry nodes (no incoming edges) ──────
  const hasIncoming = new Set<string>();
  for (const e of edges) hasIncoming.add(e.target);
  for (const n of nodes) {
    if (ENTRY_TYPES.has(n.type)) continue;
    if (hasIncoming.has(n.id)) continue;
    issues.push({
      id: `${n.id}__orphan`,
      severity: "warning",
      nodeId: n.id,
      title: `${friendlyType(n.type)} is not reachable`,
      message: "No other node connects to it, so the flow will never run this step.",
    });
  }

  return issues;
}

// ─── Helpers ─────────────────────────────────────────────────

function friendlyType(t: string): string {
  const map: Record<string, string> = {
    channel_entry: "Channel Entry",
    condition_group: "Condition",
    route_target: "Route To",
    default_fallback: "Default Fallback",
    start: "Start",
    end: "End",
    send_message_text: "Send Text",
    send_message_interactive: "Send Interactive",
    send_message_quick_reply: "Quick Reply",
    send_message_image: "Send Image",
    send_message_file: "Send File",
    send_comment_reply: "Reply to Comment",
    wait: "Wait",
    collect_input: "Collect Input",
    set_variable: "Set Variable",
    http_request: "HTTP Request",
    ai_generate: "AI Generate",
    update_customer: "Update Customer",
    bring_user_data: "Bring User Data",
    comment_trigger: "Comment Trigger",
    keyword_trigger: "Keyword Trigger",
    schedule_trigger: "Schedule Trigger",
  };
  return map[t] || t;
}

interface RequiredCheck { key: string; label: string; hint: string; }

function missingRequiredFields(n: Node): RequiredCheck[] {
  const d = n.data || {};
  const r: RequiredCheck[] = [];
  const empty = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

  switch (n.type) {
    case "send_message_text":
      if (empty(d.text)) r.push({ key: "text", label: "Message text", hint: "Type what to send." });
      break;
    case "send_message_interactive":
      if (empty(d.text)) r.push({ key: "text", label: "Body text", hint: "Add the message body." });
      if (empty(d.buttonUrl)) r.push({ key: "buttonUrl", label: "Button URL", hint: "Paste the link the button should open." });
      break;
    case "send_message_image":
    case "send_message_file":
      if (empty(d.url)) r.push({ key: "url", label: "File URL", hint: "Paste a public https:// URL to the media." });
      break;
    case "send_comment_reply":
      // Two modes: "text" needs `data.text`; "ai" needs `data.agentId`.
      if (d.mode === "ai") {
        if (empty(d.agentId)) r.push({ key: "agentId", label: "AI Agent", hint: "Pick which agent should draft the public reply." });
      } else {
        if (empty(d.text)) r.push({ key: "text", label: "Reply text", hint: "Type the public reply." });
      }
      break;
    case "route_target":
      if (empty(d.targetId)) r.push({ key: "targetId", label: "Target", hint: "Pick an AI agent, sub-flow, or department from the dropdown." });
      break;
    case "collect_input":
      if (empty(d.prompt))   r.push({ key: "prompt",   label: "Prompt",   hint: "Write the question to ask the user." });
      if (empty(d.variable)) r.push({ key: "variable", label: "Variable", hint: "Give this answer a name so later nodes can reference it." });
      break;
    case "set_variable":
      if (empty(d.variable)) r.push({ key: "variable", label: "Variable name", hint: "Give the variable a name (letters, numbers, underscore)." });
      break;
    case "http_request":
      if (empty(d.url)) r.push({ key: "url", label: "URL", hint: "Paste the API endpoint to call." });
      break;
    case "ai_generate":
      if (empty(d.prompt)) r.push({ key: "prompt", label: "Prompt", hint: "Write what the AI should produce." });
      break;
    case "update_customer":
      if (empty(d.key)) r.push({ key: "key", label: "Key", hint: "Enter the tag name or attribute key." });
      if (n.data?.action === "set_attribute" && empty(d.value))
        r.push({ key: "value", label: "Value", hint: "Provide the attribute value." });
      break;
    case "keyword_trigger": {
      const list = Array.isArray(d.keywords) ? d.keywords : [];
      if (list.filter((k: string) => String(k || "").trim()).length === 0)
        r.push({ key: "keywords", label: "Keywords", hint: "Add at least one keyword that should trigger this flow." });
      break;
    }
  }
  return r;
}

function collectDefinedVars(nodes: Node[]): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (!VAR_DEFINING_TYPES.has(n.type)) continue;
    const d = n.data || {};
    if (n.type === "collect_input" || n.type === "set_variable") {
      const v = String(d.variable || "").trim();
      if (v) out.add(v);
    } else if (n.type === "http_request" || n.type === "ai_generate") {
      const v = String(d.responseVariable || "").trim();
      if (v) out.add(v);
    } else if (n.type === "bring_user_data") {
      const prefix = String(d.prefix || "customer").replace(/[^a-z0-9_]/gi, "");
      const fields: string[] = Array.isArray(d.fields) ? d.fields : [];
      for (const f of fields) out.add(`${prefix}_${f}`);
    }
  }
  return out;
}

function collectVarUsages(n: Node): string[] {
  const hits: string[] = [];
  const d = n.data || {};
  const scan = (v: unknown) => {
    if (typeof v !== "string") return;
    const re = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      // Take only the root identifier for the defined-vars check; dotted
      // lookups resolve at runtime via getByPath.
      const root = m[1].split(".")[0].split("[")[0];
      if (root) hits.push(root);
    }
  };

  // Per-node field scans - intentionally conservative to avoid false positives
  // on fields that happen to contain curly braces.
  switch (n.type) {
    case "send_message_text":
      scan(d.text); break;
    case "send_message_interactive":
      scan(d.text); scan(d.buttonLabel); scan(d.buttonUrl); break;
    case "send_message_quick_reply":
      scan(d.text);
      if (Array.isArray(d.replies)) for (const r of d.replies) scan(r?.label);
      break;
    case "send_message_image":
      scan(d.url); scan(d.caption); break;
    case "send_message_file":
      scan(d.url); scan(d.filename); scan(d.caption); break;
    case "send_comment_reply":
      scan(d.text); scan(d.fallbackText); break;
    case "set_variable":
      scan(d.value); break;
    case "http_request":
      scan(d.url); scan(d.body);
      if (Array.isArray(d.headers)) for (const h of d.headers) scan(h?.value);
      break;
    case "ai_generate":
      scan(d.prompt); break;
    case "update_customer":
      scan(d.key); scan(d.value); break;
  }

  return Array.from(new Set(hits));
}
