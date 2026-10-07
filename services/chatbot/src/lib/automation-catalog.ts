/**
 * The automation catalogue: every trigger and node Studio can offer, where it
 * works, and the rules an automation must pass to go live.
 *
 * ONE source for the 09e "Add a step" sheet (catalogFor), the 09c row chips
 * (pathOf) and the go-live gate (validateAutomation). The walker that runs
 * these nodes is services/incoming-worker/src/services/flow-executor.service.ts;
 * a node listed `available` here must be one the walker executes.
 *
 * Pure: no I/O. Callers pass what they know (connected voice line, the path's
 * channel) and get availability with a reason a person can act on.
 */
import { validateGraph, type GraphIssue } from "./graph-validator";

export type Channel = "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "VOICE" | "WEBCHAT" | "SHOPIFY_LIVE_CHAT";
export const CHANNELS: Channel[] = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "VOICE", "WEBCHAT", "SHOPIFY_LIVE_CHAT"];
const MESSAGING: Channel[] = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "WEBCHAT", "SHOPIFY_LIVE_CHAT"];

export type Reason =
  | "first_step_only" | "channel_not_supported" | "no_customer_on_path" | "needs_24h_window"
  | "no_event_source" | "not_connected" | "coming_later";

export type Group = "trigger" | "logic" | "send" | "do";

// ── Triggers ───────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  "message_received", "new_customer", "message_from_ad", "button_tapped", "tag_added", "schedule", "webhook",
  "call_missed", "call_answered",
  "order_event", "cart_abandoned", "form_submitted", "story_mention",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Triggers whose events reach the dispatcher today. */
// call_missed / call_answered are NOT live: nothing feeds voice events to the
// automation dispatcher yet (only the old voice_trigger nodes hear them).
// Offering them made an automation that could never run.
const LIVE_TRIGGERS = new Set<TriggerType>(["message_received", "new_customer", "message_from_ad", "button_tapped", "tag_added", "schedule", "webhook"]);
/** Triggers that carry no customer: their path cannot send a message. */
const CUSTOMERLESS_TRIGGERS = new Set<TriggerType>(["schedule", "webhook"]);
const VOICE_TRIGGERS = new Set<TriggerType>(["call_missed", "call_answered"]);

interface TriggerDef { type: TriggerType; label: string; description: string; channels: Channel[]; synonyms: string[] }
const TRIGGERS: TriggerDef[] = [
  { type: "message_received", label: "Message received", description: "Any channel, or a keyword", channels: ["WHATSAPP", "INSTAGRAM", "EMAIL", "WEBCHAT"], synonyms: ["message", "keyword", "inbound", "text"] },
  { type: "call_missed", label: "Call missed", description: "On any of your lines", channels: ["VOICE"], synonyms: ["call", "phone", "missed"] },
  { type: "call_answered", label: "Call answered", description: "When it ends, with the recording", channels: ["VOICE"], synonyms: ["call", "phone", "recording"] },
  { type: "new_customer", label: "New customer", description: "First message ever", channels: ["WHATSAPP", "INSTAGRAM", "EMAIL", "WEBCHAT"], synonyms: ["new", "first", "welcome"] },
  { type: "message_from_ad", label: "Message from an ad", description: "Click-to-WhatsApp and other ads, any ad or chosen ones", channels: ["WHATSAPP", "MESSENGER", "INSTAGRAM"], synonyms: ["ad", "campaign", "click to whatsapp", "ctwa", "referral", "facebook ad"] },
  { type: "button_tapped", label: "Button tapped", description: "A button in a template or campaign, outside a flow", channels: ["WHATSAPP", "MESSENGER", "INSTAGRAM"], synonyms: ["button", "tap", "quick reply", "template button", "postback"] },
  { type: "order_event", label: "Order event", description: "Created, paid, shipped, delivered", channels: [], synonyms: ["order", "paid", "shipped", "delivered", "store"] },
  { type: "cart_abandoned", label: "Cart left behind", description: "After a delay you set", channels: [], synonyms: ["cart", "abandoned"] },
  { type: "form_submitted", label: "Form submitted", description: "Website or Instagram lead form", channels: ["WEBCHAT", "INSTAGRAM"], synonyms: ["form", "lead"] },
  { type: "story_mention", label: "Story mention", description: "Someone tags you", channels: ["INSTAGRAM"], synonyms: ["story", "mention", "instagram"] },
  { type: "tag_added", label: "Tag added", description: "On a customer or conversation", channels: [], synonyms: ["tag", "label"] },
  { type: "schedule", label: "On a schedule", description: "Daily, weekly, a date", channels: [], synonyms: ["schedule", "daily", "weekly", "time", "cron"] },
  { type: "webhook", label: "Webhook received", description: "From any system", channels: [], synonyms: ["webhook", "api", "http"] },
];

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export class AutomationInputError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

/** A trigger as stored: known type, config with only the fields that type reads. */
export function normalizeTrigger(input: any): { type: TriggerType; config: Record<string, unknown> } {
  const type = input?.type;
  if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new AutomationInputError("trigger.type", `trigger.type must be one of ${TRIGGER_TYPES.join(", ")}`);
  }
  const c = input?.config && typeof input.config === "object" ? input.config : {};
  const channels = (v: unknown): Channel[] | undefined => {
    if (v == null) return undefined;
    if (!Array.isArray(v) || v.some((x) => !CHANNELS.includes(x))) throw new AutomationInputError("trigger.config.channels", `channels must be from ${CHANNELS.join(", ")}`);
    return [...new Set(v as Channel[])];
  };
  const strings = (v: unknown, field: string, max = 20): string[] | undefined => {
    if (v == null) return undefined;
    if (!Array.isArray(v)) throw new AutomationInputError(field, `${field} must be a list`);
    const out = [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, max);
    return out;
  };
  const config: Record<string, unknown> = {};
  switch (type as TriggerType) {
    case "message_received": {
      const ch = channels(c.channels); if (ch?.length) config.channels = ch;
      const kw = strings(c.keywords, "trigger.config.keywords"); if (kw?.length) config.keywords = kw.map((k) => k.slice(0, 100));
      const match = c.match ?? "contains";
      if (!["contains", "exact", "any_word"].includes(match)) throw new AutomationInputError("trigger.config.match", "match must be contains, exact or any_word");
      if (config.keywords) config.match = match;
      break;
    }
    case "new_customer": { const ch = channels(c.channels); if (ch?.length) config.channels = ch; break; }
    case "message_from_ad": {
      const ch = channels(c.channels); if (ch?.length) config.channels = ch;
      const ads = strings(c.adIds, "trigger.config.adIds", 50); if (ads?.length) config.adIds = ads.map((a) => a.slice(0, 64));
      break;
    }
    case "button_tapped": {
      const ch = channels(c.channels); if (ch?.length) config.channels = ch;
      const p = strings(c.payloads, "trigger.config.payloads", 50); if (p?.length) config.payloads = p.map((x) => x.slice(0, 256));
      break;
    }
    case "tag_added": {
      const tags = strings(c.tags, "trigger.config.tags");
      if (!tags?.length) throw new AutomationInputError("trigger.config.tags", "pick at least one tag");
      config.tags = tags.map((t) => t.slice(0, 60));
      break;
    }
    case "schedule": {
      const at = String(c.at ?? "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new AutomationInputError("trigger.config.at", "at must be a time like 09:00");
      config.at = at;
      if (c.days != null) {
        if (!Array.isArray(c.days) || c.days.some((d: any) => !(DAY_KEYS as readonly string[]).includes(d))) throw new AutomationInputError("trigger.config.days", `days must be from ${DAY_KEYS.join(", ")}`);
        if (c.days.length) config.days = [...new Set(c.days)];
      }
      if (c.timezone != null) {
        try { new Intl.DateTimeFormat("en", { timeZone: String(c.timezone) }); } catch { throw new AutomationInputError("trigger.config.timezone", "unknown timezone"); }
        config.timezone = String(c.timezone);
      }
      break;
    }
    case "call_missed":
    case "call_answered": { const lines = strings(c.lines, "trigger.config.lines"); if (lines?.length) config.lines = lines; break; }
    default: break; // webhook: url is added by the server; unavailable types keep no config
  }
  return { type, config };
}

// ── Nodes ──────────────────────────────────────────────────────────────────

interface NodeDef {
  type: string;
  group: Exclude<Group, "trigger">;
  label: string;
  description: string;
  channels: Channel[];      // [] = works anywhere
  outputs: string[] | "dynamic";
  synonyms: string[];
  limits?: Record<string, number>;
  sends?: boolean;          // needs a customer on the path
  terminal?: boolean;       // ends the automation's ownership
  coming?: boolean;         // listed, not runnable yet
  needsWindow?: boolean;    // free-form send: inside the 24 h window on WhatsApp
}

export const LIMITS = { buttons: 3, buttonTitle: 20, listOptions: 10, listTitle: 24, text: 4096 } as const;

const NODES: NodeDef[] = [
  // Logic
  { type: "condition_group", group: "logic", label: "Condition", description: "If, else if, else", channels: [], outputs: ["true", "false"], synonyms: ["if", "condition", "rule", "check"] },
  { type: "opening_hours", group: "logic", label: "Opening hours", description: "Open, closed, holiday", channels: [], outputs: ["open", "closed"], synonyms: ["hours", "open", "closed", "after hours", "holiday"] },
  { type: "wait", group: "logic", label: "Wait", description: "Minutes, hours, until a time", channels: [], outputs: ["next"], synonyms: ["wait", "delay", "pause", "later"] },
  { type: "wait_for_reply", group: "logic", label: "Wait for reply", description: "With a timeout branch", channels: [], outputs: "dynamic", synonyms: ["wait", "reply", "answer", "timeout"] },
  { type: "split_channel", group: "logic", label: "Split by channel", description: "One path per channel", channels: [], outputs: "dynamic", synonyms: ["channel", "split", "whatsapp", "instagram"] },
  { type: "language", group: "logic", label: "Language", description: "Hebrew, English, Arabic…", channels: [], outputs: "dynamic", synonyms: ["language", "hebrew", "english", "arabic"] },
  { type: "segment", group: "logic", label: "Customer segment", description: "VIP, new, returning", channels: [], outputs: ["new", "returning", "vip"], synonyms: ["segment", "vip", "new", "returning"] },
  { type: "ab_split", group: "logic", label: "A/B split", description: "Percent per path", channels: [], outputs: ["a", "b"], synonyms: ["ab", "split", "test", "percent"] },
  // Send
  { type: "send_message_text", group: "send", label: "Message", description: "Text with variables", channels: MESSAGING, outputs: ["next"], synonyms: ["message", "text", "send", "reply"], sends: true, needsWindow: true, limits: { textMax: LIMITS.text } },
  { type: "send_message_file", group: "send", label: "File", description: "PDF, image, video", channels: ["WHATSAPP", "INSTAGRAM", "MESSENGER", "EMAIL", "GMAIL", "OUTLOOK", "SLACK"], outputs: ["next"], synonyms: ["file", "pdf", "image", "video", "catalogue", "document"], sends: true, needsWindow: true },
  { type: "send_buttons", group: "send", label: "Buttons", description: "Up to 3, each a branch", channels: ["WHATSAPP", "INSTAGRAM", "MESSENGER", "WEBCHAT"], outputs: ["next"], synonyms: ["buttons", "quick reply", "options", "menu"], sends: true, needsWindow: true, limits: { maxButtons: LIMITS.buttons, titleMax: LIMITS.buttonTitle } },
  { type: "send_list", group: "send", label: "List", description: "Up to 10 options", channels: ["WHATSAPP"], outputs: ["next"], synonyms: ["list", "menu", "options"], sends: true, needsWindow: true, limits: { maxOptions: LIMITS.listOptions, titleMax: LIMITS.listTitle } },
  { type: "ai_generate", group: "send", label: "AI writes a message", description: "One message in your employee's voice, no hand-over", channels: MESSAGING, outputs: ["next"], synonyms: ["ai", "write", "generate", "personal message", "gpt"], sends: true, needsWindow: true },
  { type: "send_message_template", group: "send", label: "Template", description: "Approved, outside 24 h", channels: ["WHATSAPP"], outputs: ["next"], synonyms: ["template", "approved", "24h", "reminder"], sends: true },
  { type: "send_location", group: "send", label: "Location", description: "A branch on the map", channels: ["WHATSAPP"], outputs: ["next"], synonyms: ["location", "map", "address"], sends: true, coming: true },
  { type: "send_rating", group: "send", label: "Rating request", description: "1 to 5, saved to the card", channels: ["WHATSAPP", "INSTAGRAM", "WEBCHAT"], outputs: ["next"], synonyms: ["rating", "review", "feedback", "stars"], sends: true, coming: true },
  { type: "send_sms", group: "send", label: "SMS", description: "Fallback or reminder", channels: ["VOICE"], outputs: ["next"], synonyms: ["sms", "text message"], sends: true, coming: true },
  // Do
  { type: "assign", group: "do", label: "Assign to team or person", description: "Round robin or last handler", channels: [], outputs: ["next"], synonyms: ["assign", "team", "person", "agent", "route"] },
  { type: "hand_to_ai", group: "do", label: "Hand to AI employee", description: "Continues in the same chat", channels: [], outputs: [], synonyms: ["ai", "employee", "bot", "hand over"], terminal: true },
  { type: "run_skill", group: "do", label: "Run a skill", description: "Exchange, order status…", channels: [], outputs: [], synonyms: ["skill", "ai", "exchange", "order status"], terminal: true },
  { type: "add_tag", group: "do", label: "Add tag", description: "Customer or conversation", channels: [], outputs: ["next"], synonyms: ["tag", "label"] },
  { type: "update_customer", group: "do", label: "Update customer field", description: "Any field on the card", channels: [], outputs: ["next"], synonyms: ["field", "update", "customer", "card"] },
  { type: "create_task", group: "do", label: "Create task", description: "With owner and due time", channels: [], outputs: ["next"], synonyms: ["task", "todo", "call back", "follow up"] },
  { type: "notify_team", group: "do", label: "Notify team", description: "In-app", channels: [], outputs: ["next"], synonyms: ["notify", "alert", "team", "notification"] },
  { type: "close_conversation", group: "do", label: "Close conversation", description: "With or without a message", channels: [], outputs: [], synonyms: ["close", "end", "resolve"], terminal: true },
  { type: "add_sheet_row", group: "do", label: "Add row to Sheets", description: "Google Sheets", channels: [], outputs: ["next"], synonyms: ["sheets", "google", "spreadsheet", "row"], coming: true },
  { type: "http_request", group: "do", label: "HTTP request", description: "Call any API", channels: [], outputs: ["next"], synonyms: ["http", "api", "webhook", "request"] },
];
const NODE_BY_TYPE = new Map(NODES.map((n) => [n.type, n]));

export const TRIGGER_NODE_TYPE = "automation_trigger";
/** Node types that end the automation (no outgoing edge). */
export const AUTOMATION_TERMINAL_TYPES = new Set(NODES.filter((n) => n.terminal).map((n) => n.type));
/** Node types whose outgoing edges carry a branch key. */
export const AUTOMATION_BRANCH_TYPES = new Set(["condition_group", "opening_hours", "wait_for_reply", "split_channel", "language", "segment", "ab_split"]);
export const RUNNABLE_NODE_TYPES = new Set([TRIGGER_NODE_TYPE, ...NODES.filter((n) => !n.coming).map((n) => n.type)]);

export function labelOfNode(type: string, triggerType?: string | null): string {
  if (type === TRIGGER_NODE_TYPE) return TRIGGERS.find((t) => t.type === triggerType)?.label ?? "Trigger";
  return NODE_BY_TYPE.get(type)?.label ?? type.replace(/_/g, " ");
}

// ── Catalogue (09e) ────────────────────────────────────────────────────────

export interface CatalogContext {
  channel: Channel | null;    // the path's channel, when known
  firstStep: boolean;         // the sheet opened before any trigger exists
  triggerType: TriggerType | null;
  afterNodeType: string | null;
  voiceConnected: boolean;
}

export interface CatalogItem {
  type: string; label: string; description: string; channels: Channel[];
  outputs: string[] | "dynamic"; limits?: Record<string, number>; synonyms: string[];
  available: boolean; reason: Reason | null;
}

export function triggerAvailability(type: TriggerType, ctx: Pick<CatalogContext, "voiceConnected">): { available: boolean; reason: Reason | null } {
  if (!LIVE_TRIGGERS.has(type)) return { available: false, reason: "no_event_source" };
  if (VOICE_TRIGGERS.has(type) && !ctx.voiceConnected) return { available: false, reason: "not_connected" };
  return { available: true, reason: null };
}

function nodeAvailability(def: NodeDef, ctx: CatalogContext): { available: boolean; reason: Reason | null } {
  if (def.coming) return { available: false, reason: "coming_later" };
  if (def.sends && ctx.triggerType && CUSTOMERLESS_TRIGGERS.has(ctx.triggerType)) return { available: false, reason: "no_customer_on_path" };
  if (ctx.channel && def.channels.length && !def.channels.includes(ctx.channel)) return { available: false, reason: "channel_not_supported" };
  // A schedule or a tag can fire long after the customer last wrote: on
  // WhatsApp only an approved template is sure to arrive.
  if (def.needsWindow && ctx.channel === "WHATSAPP" && ctx.triggerType === "tag_added") return { available: false, reason: "needs_24h_window" };
  return { available: true, reason: null };
}

export function catalogFor(ctx: CatalogContext) {
  const trig: CatalogItem[] = TRIGGERS.map((t) => {
    const a = triggerAvailability(t.type, ctx);
    const firstOnly = !ctx.firstStep;
    return {
      type: `trigger:${t.type}`, label: t.label, description: t.description, channels: t.channels,
      outputs: ["next"], synonyms: t.synonyms,
      available: !firstOnly && a.available, reason: firstOnly ? "first_step_only" : a.reason,
    };
  });
  const group = (g: Exclude<Group, "trigger">, label: string) => ({
    key: g, label,
    items: NODES.filter((n) => n.group === g).map((n): CatalogItem => {
      const a = ctx.firstStep ? { available: false, reason: "first_step_only" as Reason } : nodeAvailability(n, ctx);
      return {
        type: n.type, label: n.label, description: n.description, channels: n.channels, outputs: n.outputs,
        ...(n.limits ? { limits: n.limits } : {}), synonyms: n.synonyms, ...a,
      };
    }),
  });
  const hasCustomer = !(ctx.triggerType && CUSTOMERLESS_TRIGGERS.has(ctx.triggerType));
  return {
    context: { channel: ctx.channel, firstStep: ctx.firstStep, hasCustomer, afterNodeType: ctx.afterNodeType },
    groups: [
      { key: "trigger", label: "Triggers", note: "first step only", items: trig },
      group("logic", "Logic"),
      group("send", "Send"),
      group("do", "Do"),
    ],
    variables: ctx.triggerType === "webhook"
      ? ["body.<field>"]
      : hasCustomer ? ["first_name", "business_name", "opening_hours"] : ["business_name"],
  };
}

// ── Graph helpers ──────────────────────────────────────────────────────────

export interface ANode { id: string; type: string; data?: any; position?: any }
export interface AEdge { id?: string; source: string; target: string; sourceHandle?: string | null }

/** The channel a single-channel trigger pins its path to (null = several or any). */
export function pathChannelOf(trigger: { type: string; config?: any } | null): Channel | null {
  if (!trigger) return null;
  if (VOICE_TRIGGERS.has(trigger.type as TriggerType)) return null; // the reply goes out on the customer's messaging channel
  const ch = Array.isArray(trigger.config?.channels) ? trigger.config.channels : [];
  return ch.length === 1 ? ch[0] : null;
}

/** 09c row chips: from the trigger along the first outgoing edge, up to `max`. */
export function pathOf(nodes: ANode[], edges: AEdge[], triggerType: string | null, max = 6): Array<{ nodeId: string; type: string; label: string }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === TRIGGER_NODE_TYPE);
  const out: Array<{ nodeId: string; type: string; label: string }> = [];
  const seen = new Set<string>();
  let cur = start;
  while (cur && out.length < max && !seen.has(cur.id)) {
    seen.add(cur.id);
    const custom = typeof cur.data?.label === "string" && cur.data.label.trim() ? cur.data.label.trim() : null;
    out.push({ nodeId: cur.id, type: cur.type, label: custom ?? labelOfNode(cur.type, triggerType) });
    const next = edges.find((e) => e.source === cur!.id);
    cur = next ? byId.get(next.target) : undefined;
  }
  return out;
}

/** The node right before `nodeId` (its first incoming edge's source). */
function previousOf(nodeId: string, nodes: ANode[], edges: AEdge[]): ANode | null {
  const e = edges.find((x) => x.target === nodeId);
  return e ? nodes.find((n) => n.id === e.source) ?? null : null;
}

/** The branch keys a node offers (for wait_for_reply: the buttons/options of the send before it). */
export function outputsOf(node: ANode, nodes: ANode[], edges: AEdge[]): string[] {
  const def = NODE_BY_TYPE.get(node.type);
  if (node.type === TRIGGER_NODE_TYPE) return ["next"];
  if (node.type === "wait_for_reply") {
    const prev = previousOf(node.id, nodes, edges);
    const opts = prev?.type === "send_buttons" ? prev.data?.buttons : prev?.type === "send_list" ? prev.data?.options : null;
    return [...(Array.isArray(opts) ? opts.map((o: any) => `btn:${o?.id}`) : []), "reply", "timeout"];
  }
  if (node.type === "split_channel") {
    const ch = Array.isArray(node.data?.channels) && node.data.channels.length ? node.data.channels : MESSAGING;
    return [...ch, "other"];
  }
  if (node.type === "language") {
    const langs = Array.isArray(node.data?.languages) ? node.data.languages : [];
    return [...langs, "other"];
  }
  if (!def) return ["next"];
  return def.outputs === "dynamic" ? [] : def.outputs;
}

// ── Validation (the go-live gate) ──────────────────────────────────────────

const empty = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

/** Per-node settings an automation needs before it can go live. */
function nodeIssues(n: ANode, trigger: { type: string; config?: any } | null, channel: Channel | null): GraphIssue[] {
  const d = n.data ?? {};
  const err = (code: string, message: string): GraphIssue => ({ severity: "error", code, nodeId: n.id, message });
  const out: GraphIssue[] = [];
  const def = NODE_BY_TYPE.get(n.type);
  if (n.type !== TRIGGER_NODE_TYPE && !def && !LEGACY_RUNNABLE.has(n.type)) out.push(err("unknown_node", `"${n.type}" is not a step automations can run.`));
  if (def?.coming) out.push(err("node_unavailable", `"${def.label}" is not available yet.`));
  if (def?.sends && trigger && CUSTOMERLESS_TRIGGERS.has(trigger.type as TriggerType)) {
    out.push(err("no_customer_on_path", `"${def.label}" needs a customer, and this trigger has none.`));
  }
  if (def && channel && def.channels.length && !def.channels.includes(channel)) {
    out.push(err("channel_not_supported", `"${def.label}" does not work on ${channel}.`));
  }
  switch (n.type) {
    case "send_buttons": {
      const b = Array.isArray(d.buttons) ? d.buttons : [];
      if (empty(d.text)) out.push(err("missing_config", "Buttons need a message."));
      if (!b.length) out.push(err("missing_config", "Add at least one button."));
      if (b.length > LIMITS.buttons) out.push(err("too_many_buttons", `At most ${LIMITS.buttons} buttons.`));
      if (b.some((x: any) => empty(x?.id) || empty(x?.title))) out.push(err("missing_config", "Every button needs a title."));
      if (b.some((x: any) => String(x?.title ?? "").length > LIMITS.buttonTitle)) out.push(err("title_too_long", `A button title is at most ${LIMITS.buttonTitle} characters.`));
      if (new Set(b.map((x: any) => x?.id)).size !== b.length) out.push(err("duplicate_button", "Two buttons share an id."));
      break;
    }
    case "send_list": {
      const o = Array.isArray(d.options) ? d.options : [];
      if (empty(d.text) || empty(d.buttonText)) out.push(err("missing_config", "A list needs a message and a button text."));
      if (!o.length) out.push(err("missing_config", "Add at least one option."));
      if (o.length > LIMITS.listOptions) out.push(err("too_many_options", `At most ${LIMITS.listOptions} options.`));
      if (o.some((x: any) => empty(x?.id) || empty(x?.title))) out.push(err("missing_config", "Every option needs a title."));
      if (o.some((x: any) => String(x?.title ?? "").length > LIMITS.listTitle)) out.push(err("title_too_long", `An option title is at most ${LIMITS.listTitle} characters.`));
      break;
    }
    case "wait_for_reply":
      if (!(typeof d.timeoutMs === "number" && d.timeoutMs > 0)) out.push(err("invalid_delay", "Wait for reply needs a timeout."));
      break;
    case "ab_split":
      if (!(typeof d.percentA === "number" && d.percentA > 0 && d.percentA < 100)) out.push(err("missing_config", "Set the percent for path A (1 to 99)."));
      break;
    case "language":
      if (!Array.isArray(d.languages) || !d.languages.length) out.push(err("missing_config", "Pick at least one language."));
      break;
    case "assign":
      if (d.to === "person" && empty(d.userId)) out.push(err("missing_config", "Pick the person."));
      if (d.to !== "person" && d.to !== "team") out.push(err("missing_config", "Assign to a team or a person."));
      break;
    case "hand_to_ai": if (empty(d.aiAgentId)) out.push(err("missing_config", "Pick the AI employee.")); break;
    case "run_skill":
      if (empty(d.skillId)) out.push(err("missing_config", "Pick the skill."));
      if (empty(d.aiAgentId)) out.push(err("missing_config", "Pick the AI employee who runs it."));
      break;
    case "add_tag": if (empty(d.tag)) out.push(err("missing_config", "Write the tag.")); break;
    case "ai_generate":
      if (empty(d.aiAgentId)) out.push(err("missing_config", "Pick the AI employee who writes it."));
      break;
    case "create_task": if (empty(d.title)) out.push(err("missing_config", "The task needs a title.")); break;
    case "notify_team": if (empty(d.message)) out.push(err("missing_config", "Write the notification.")); break;
  }
  return out;
}

/** Older walker node types an automation may still contain (validated by validateGraph's own rules). */
const LEGACY_RUNNABLE = new Set(["set_variable", "collect_input", "send_message_image", "send_message_quick_reply", "send_message_interactive", "bring_user_data", "end"]);

/**
 * Can this automation go live? `errors` block; `warnings` do not. The shared
 * graph rules (validateGraph) plus the automation's own: one trigger, a known
 * trigger, every node runnable here, per-node settings, branches that exist.
 */
export function validateAutomation(
  trigger: { type: string; config?: any } | null,
  nodes: ANode[],
  edges: AEdge[],
  ctx: { voiceConnected: boolean } = { voiceConnected: true },
): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const { errors, warnings } = validateGraph(nodes as any, edges as any);
  if (!trigger || !(TRIGGER_TYPES as readonly string[]).includes(trigger.type)) {
    errors.push({ severity: "error", code: "no_trigger", message: "Choose what starts this automation." });
  } else {
    const a = triggerAvailability(trigger.type as TriggerType, ctx);
    if (!a.available) errors.push({ severity: "error", code: `trigger_${a.reason}`, message: a.reason === "not_connected" ? "Connect a phone line to use call triggers." : "This trigger has no event source yet." });
  }
  const triggers = (nodes ?? []).filter((n) => n.type === TRIGGER_NODE_TYPE);
  if (triggers.length !== 1) errors.push({ severity: "error", code: "trigger_node", message: "An automation has exactly one trigger step." });
  else if (!(edges ?? []).some((e) => e.source === triggers[0].id)) {
    errors.push({ severity: "error", code: "no_steps", nodeId: triggers[0].id, message: "Add a step after the trigger." });
  }
  const channel = pathChannelOf(trigger);
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  for (const n of nodes ?? []) errors.push(...nodeIssues(n, trigger, channel));
  for (const e of edges ?? []) {
    const s = byId.get(e.source);
    if (!s) continue;
    if (AUTOMATION_BRANCH_TYPES.has(s.type)) {
      const outs = outputsOf(s, nodes, edges);
      if (!e.sourceHandle || !outs.includes(e.sourceHandle)) {
        errors.push({ severity: "error", code: "unknown_branch", nodeId: s.id, message: `A connection leaves "${labelOfNode(s.type)}" from a branch it does not have.` });
      }
    }
  }
  // wait_for_reply must follow the message it waits on
  for (const n of nodes ?? []) {
    if (n.type !== "wait_for_reply") continue;
    const prev = previousOf(n.id, nodes, edges);
    if (!prev || !NODE_BY_TYPE.get(prev.type)?.sends) warnings.push({ severity: "warning", code: "wait_without_message", nodeId: n.id, message: "Wait for reply usually comes right after a message." });
  }
  return { errors, warnings };
}
