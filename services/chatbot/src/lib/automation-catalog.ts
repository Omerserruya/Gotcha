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
import { ORDER_STATUSES } from "@chatcenter/shared";

export type Channel = "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "VOICE" | "WEBCHAT" | "SHOPIFY_LIVE_CHAT";
export const CHANNELS: Channel[] = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "VOICE", "WEBCHAT", "SHOPIFY_LIVE_CHAT"];
const MESSAGING: Channel[] = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "WEBCHAT", "SHOPIFY_LIVE_CHAT"];

export type Reason =
  | "first_step_only" | "channel_not_supported" | "no_customer_on_path" | "needs_24h_window"
  | "no_event_source" | "not_connected" | "coming_later"
  // A comment automation: before the customer replies only the comment
  // walker's steps run; a public comment reply exists only there.
  | "after_customer_replies" | "comment_automation_only";

export type Group = "trigger" | "logic" | "send" | "do";

// ── Triggers ───────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  "message_received", "new_customer", "message_from_ad", "button_tapped", "comment_received", "tag_added", "schedule", "webhook",
  "call_missed", "call_answered",
  "order_event", "cart_abandoned", "form_submitted", "story_mention",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Triggers whose events reach the dispatcher today. */
// call_missed / call_answered: the shared call-state transition queues them
// (inbound calls only); the reply goes to the caller on WhatsApp.
const LIVE_TRIGGERS = new Set<TriggerType>(["message_received", "new_customer", "message_from_ad", "button_tapped", "comment_received", "tag_added", "cart_abandoned", "order_event", "story_mention", "call_missed", "call_answered", "schedule", "webhook"]);
/**
 * Triggers that fire when the customer has not written to us: on WhatsApp the
 * 24 h service window is closed, so only an approved template can be sent.
 */
const OUTSIDE_WINDOW_TRIGGERS = new Set<TriggerType>(["tag_added", "cart_abandoned", "order_event", "call_missed", "call_answered"]);
/** Of those, the ones that NEVER follow a customer message: the validator refuses a free-form WhatsApp send. */
const WINDOW_CLOSED_TRIGGERS = new Set<TriggerType>(["cart_abandoned", "order_event", "call_missed", "call_answered"]);
/** Triggers that carry no customer: their path cannot send a message. */
const CUSTOMERLESS_TRIGGERS = new Set<TriggerType>(["schedule", "webhook"]);
const VOICE_TRIGGERS = new Set<TriggerType>(["call_missed", "call_answered"]);

interface TriggerDef { type: TriggerType; label: string; description: string; channels: Channel[]; synonyms: string[] }
const TRIGGERS: TriggerDef[] = [
  { type: "message_received", label: "Message received", description: "Any channel, or a keyword", channels: ["WHATSAPP", "INSTAGRAM", "EMAIL", "WEBCHAT"], synonyms: ["message", "keyword", "inbound", "text"] },
  { type: "call_missed", label: "Call missed", description: "An incoming call nobody answered, on any of your lines or chosen ones. Writes to the caller on WhatsApp, with a template", channels: ["VOICE"], synonyms: ["call", "phone", "missed"] },
  { type: "call_answered", label: "Call answered", description: "When an answered incoming call ends. Writes to the caller on WhatsApp, with a template", channels: ["VOICE"], synonyms: ["call", "phone", "recording"] },
  { type: "new_customer", label: "New customer", description: "First message ever", channels: ["WHATSAPP", "INSTAGRAM", "EMAIL", "WEBCHAT"], synonyms: ["new", "first", "welcome"] },
  { type: "message_from_ad", label: "Message from an ad", description: "Click-to-WhatsApp and other ads, any ad or chosen ones", channels: ["WHATSAPP", "MESSENGER", "INSTAGRAM"], synonyms: ["ad", "campaign", "click to whatsapp", "ctwa", "referral", "facebook ad"] },
  { type: "comment_received", label: "Comment on a post", description: "Instagram or Facebook, any post or chosen ones, optional keywords", channels: ["INSTAGRAM", "MESSENGER"], synonyms: ["comment", "post", "instagram", "facebook", "dm", "comment to dm"] },
  { type: "button_tapped", label: "Button tapped", description: "A button in a template or campaign, outside a flow", channels: ["WHATSAPP", "MESSENGER", "INSTAGRAM"], synonyms: ["button", "tap", "quick reply", "template button", "postback"] },
  { type: "order_event", label: "Order event", description: "A Shopify or WooCommerce order is created, paid, shipped or cancelled", channels: [], synonyms: ["order", "paid", "shipped", "delivered", "store"] },
  // No channels: the first send step decides how the customer is reached (2026-10-14).
  { type: "cart_abandoned", label: "Cart left behind", description: "After a delay you set. Sends only to customers who agreed to marketing", channels: [], synonyms: ["cart", "abandoned", "checkout", "recover", "reminder"] },
  { type: "form_submitted", label: "Form submitted", description: "Website or Instagram lead form", channels: ["WEBCHAT", "INSTAGRAM"], synonyms: ["form", "lead"] },
  { type: "story_mention", label: "Story mention", description: "Someone mentions you in their Instagram story", channels: ["INSTAGRAM"], synonyms: ["story", "mention", "instagram"] },
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
    case "comment_received": {
      const ch = channels(c.channels);
      if (ch?.some((x) => x !== "INSTAGRAM" && x !== "MESSENGER")) throw new AutomationInputError("trigger.config.channels", "comments come from INSTAGRAM or MESSENGER");
      if (ch?.length) config.channels = ch;
      // The page or account the posts belong to (a ChannelAccount id). The
      // runtime matches only comments that came in on it.
      if (c.channelAccountId != null && c.channelAccountId !== "") {
        if (typeof c.channelAccountId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(c.channelAccountId)) throw new AutomationInputError("trigger.config.channelAccountId", "channelAccountId must be a connected page or account id");
        config.channelAccountId = c.channelAccountId;
      }
      const posts = strings(c.postIds, "trigger.config.postIds", 50); if (posts?.length) config.postIds = posts.map((x) => x.slice(0, 64));
      const kw = strings(c.keywords, "trigger.config.keywords"); if (kw?.length) config.keywords = kw.map((k) => k.slice(0, 100));
      const match = c.match ?? "contains";
      if (!["contains", "exact", "any_word"].includes(match)) throw new AutomationInputError("trigger.config.match", "match must be contains, exact or any_word");
      if (config.keywords) config.match = match;
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
    case "cart_abandoned": {
      // A stored or sent `channels` is dropped: the first send step's `via` decides.
      if (c.delayMinutes != null) {
        const n = Number(c.delayMinutes);
        if (!Number.isFinite(n) || n < 15 || n > 2880) throw new AutomationInputError("trigger.config.delayMinutes", "the delay is 15 minutes to 2 days");
        config.delayMinutes = Math.round(n);
      }
      break;
    }
    case "order_event": {
      const ch = channels(c.channels); if (ch?.length) config.channels = ch;
      const st = strings(c.statuses, "trigger.config.statuses");
      if (st?.some((x) => !(ORDER_STATUSES as readonly string[]).includes(x))) throw new AutomationInputError("trigger.config.statuses", `statuses must be from ${ORDER_STATUSES.join(", ")}`);
      if (st?.length) config.statuses = st;
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
  { type: "send_comment_reply", group: "send", label: "Reply to the comment", description: "A public reply under the post, as text or by AI", channels: ["INSTAGRAM", "MESSENGER"], outputs: ["next"], synonyms: ["reply", "comment", "public", "post"], sends: true },
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
  /** A comment automation's step that comes before any Wait for reply (runs on the comment). */
  onComment?: boolean;
  /** Connected channels a cart run could reach the customer on. */
  reach?: { whatsapp: boolean; email: boolean };
  /** A cart automation's reach plan: its first send step and that step's unreachable branch. */
  cart?: { firstSendStepId: string | null; via: Via | null; fallbackStepId: string | null; fallbackVia: Via | null } | null;
}

export interface CatalogItem {
  type: string; label: string; description: string; channels: Channel[];
  outputs: string[] | "dynamic"; limits?: Record<string, number>; synonyms: string[];
  available: boolean; reason: Reason | null;
  /** Sends to the customer on the conversation's channel (needs a customer and a channel). */
  sends: boolean;
  /** May run on the comment itself, before the first wait, in a comment automation. */
  commentSafe: boolean;
  /** Cart automations: the channels this step can reach the customer on (`data.via`). */
  viaOptions?: Via[];
}

export function triggerAvailability(type: TriggerType, ctx: Pick<CatalogContext, "voiceConnected">): { available: boolean; reason: Reason | null } {
  if (!LIVE_TRIGGERS.has(type)) return { available: false, reason: "no_event_source" };
  if (VOICE_TRIGGERS.has(type) && !ctx.voiceConnected) return { available: false, reason: "not_connected" };
  return { available: true, reason: null };
}

function nodeAvailability(def: NodeDef, ctx: CatalogContext): { available: boolean; reason: Reason | null } {
  if (def.coming) return { available: false, reason: "coming_later" };
  if (ctx.onComment && !COMMENT_WALK_TYPES.has(def.type)) return { available: false, reason: "after_customer_replies" };
  if (def.type === "send_comment_reply" && !ctx.onComment) return { available: false, reason: "comment_automation_only" };
  if (def.sends && ctx.triggerType && CUSTOMERLESS_TRIGGERS.has(ctx.triggerType)) return { available: false, reason: "no_customer_on_path" };
  if (ctx.channel && def.channels.length && !def.channels.includes(ctx.channel)) return { available: false, reason: "channel_not_supported" };
  // A schedule or a tag can fire long after the customer last wrote: on
  // WhatsApp only an approved template is sure to arrive.
  if (def.needsWindow && ctx.channel === "WHATSAPP" && ctx.triggerType && OUTSIDE_WINDOW_TRIGGERS.has(ctx.triggerType)) return { available: false, reason: "needs_24h_window" };
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
      sends: false, commentSafe: true,
    };
  });
  const group = (g: Exclude<Group, "trigger">, label: string) => ({
    key: g, label,
    items: NODES.filter((n) => n.group === g).map((n): CatalogItem => {
      const a = ctx.firstStep ? { available: false, reason: "first_step_only" as Reason } : nodeAvailability(n, ctx);
      return {
        type: n.type, label: n.label, description: n.description, channels: n.channels, outputs: n.outputs,
        ...(n.limits ? { limits: n.limits } : {}), synonyms: n.synonyms, ...a,
        // Facts for the builder (2026-10-14), so it does not hardcode them:
        // which steps send, and which may run on the comment itself.
        sends: !!n.sends, commentSafe: COMMENT_WALK_TYPES.has(n.type),
        ...(ctx.triggerType === "cart_abandoned" && (VIA_TYPES.has(n.type) || n.type === "send_message_template")
          ? { viaOptions: (n.type === "send_message_template" ? ["whatsapp"] : ["whatsapp", "email"]).filter((v) => !ctx.reach || ctx.reach[v as Via]) as Via[] }
          : {}),
      };
    }),
  });
  const hasCustomer = !(ctx.triggerType && CUSTOMERLESS_TRIGGERS.has(ctx.triggerType));
  return {
    context: {
      channel: ctx.channel, firstStep: ctx.firstStep, hasCustomer, afterNodeType: ctx.afterNodeType,
      ...(ctx.reach ? { reach: ctx.reach } : {}),
      ...(ctx.cart ? { cart: ctx.cart } : {}),
    },
    groups: [
      { key: "trigger", label: "Triggers", note: "first step only", items: trig },
      group("logic", "Logic"),
      group("send", "Send"),
      group("do", "Do"),
    ],
    variables: variablesFor(ctx, hasCustomer),
  };
}

/**
 * What a step can write, by where it sits. On a comment (before the customer
 * replies) only the comment is known: the commenter's username is not a
 * first name, so {{first_name}} is not offered there.
 */
const COMMENT_VARIABLES = ["comment.text", "comment.from.username", "comment.postId", "comment.postPermalink"];
function variablesFor(ctx: CatalogContext, hasCustomer: boolean): string[] {
  if (ctx.triggerType === "webhook") return ["body.<field>"];
  if (!hasCustomer) return ["business_name"];
  if (ctx.onComment) return [...COMMENT_VARIABLES, "business_name"];
  const base = ["first_name", "business_name", "opening_hours"];
  if (ctx.triggerType === "comment_received") return [...base, ...COMMENT_VARIABLES];
  if (ctx.triggerType === "cart_abandoned") return [...base, "cart_url", "cart_total", "cart_items"];
  if (ctx.triggerType === "story_mention") return [...base, "story_url"];
  if (ctx.triggerType === "order_event") return [...base, "order_number", "order_total", "order_status", "order_items", "order_url"];
  if (ctx.triggerType && VOICE_TRIGGERS.has(ctx.triggerType)) return [...base, "caller_number", "line_name", "call_duration", "call_recording_url"];
  return base;
}

// ── Graph helpers ──────────────────────────────────────────────────────────

export interface ANode { id: string; type: string; data?: any; position?: any }
export interface AEdge { id?: string; source: string; target: string; sourceHandle?: string | null }

/** The channel a single-channel trigger pins its path to (null = several or any). */
// ── Cart reach (2026-10-14) ────────────────────────────────────────────────
// A cart run has no conversation to start from: its FIRST send step decides
// how the customer is reached (a template is WhatsApp; other sends say so in
// data.via), and that step's optional "unreachable" exit leads to the steps
// tried on the other channel. Mirrors incoming-worker cart.service.

export type Via = "whatsapp" | "email";
export const UNREACHABLE_HANDLE = "unreachable";
const CART_SEND_TYPES = new Set(["send_message_text", "send_message_file", "send_message_image", "send_buttons", "send_list", "send_message_template", "send_message_quick_reply", "send_message_interactive", "collect_input", "ai_generate"]);
/** Send steps that take a `via` (a template is always WhatsApp). */
export const VIA_TYPES = new Set(["send_message_text", "send_message_file", "send_buttons"]);

export function viaOf(node: ANode | null | undefined): Via | null {
  if (!node) return null;
  if (node.type === "send_message_template") return "whatsapp";
  const v = String(node.data?.via ?? "").toLowerCase();
  return v === "whatsapp" || v === "email" ? v : null;
}

export function viaChannel(via: Via | null): Channel | null {
  return via === "whatsapp" ? "WHATSAPP" : via === "email" ? "EMAIL" : null;
}

function reachableFrom(startId: string | null, edges: AEdge[], skipUnreachable: boolean): Set<string> {
  const out = new Set<string>();
  const stack = startId ? [startId] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const e of edges) if (e.source === id && !(skipUnreachable && e.sourceHandle === UNREACHABLE_HANDLE)) stack.push(e.target);
  }
  return out;
}

/** The first send step, its via, the step its "unreachable" exit leads to, and which steps each channel's path holds. */
export function cartPlanOf(nodes: ANode[], edges: AEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === TRIGGER_NODE_TYPE);
  let first: ANode | null = null;
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length && !first) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n && CART_SEND_TYPES.has(n.type)) { first = n; break; }
    for (const e of edges) if (e.source === id && e.sourceHandle !== UNREACHABLE_HANDLE) queue.push(e.target);
  }
  const fallbackId = first ? edges.find((e) => e.source === first!.id && e.sourceHandle === UNREACHABLE_HANDLE)?.target ?? null : null;
  const fallback = fallbackId ? byId.get(fallbackId) ?? null : null;
  return {
    first, via: viaOf(first), fallback, fallbackVia: viaOf(fallback),
    mainPath: reachableFrom(start?.id ?? null, edges, true),
    fallbackPath: reachableFrom(fallback?.id ?? null, edges, true),
  };
}

export function pathChannelOf(trigger: { type: string; config?: any } | null, nodes?: ANode[], edges?: AEdge[]): Channel | null {
  if (!trigger) return null;
  if (trigger.type === "cart_abandoned") return nodes && edges ? viaChannel(cartPlanOf(nodes, edges).via) : null;
  if (VOICE_TRIGGERS.has(trigger.type as TriggerType)) return "WHATSAPP"; // the reply goes to the caller on WhatsApp
  if (trigger.type === "story_mention") return "INSTAGRAM";
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
  // Outside the 24 h window on WhatsApp only a template arrives. When the
  // trigger's channels do not rule WhatsApp out, a free-form send is refused.
  if (def?.needsWindow && trigger && WINDOW_CLOSED_TRIGGERS.has(trigger.type as TriggerType)) {
    const chs: string[] = Array.isArray(trigger.config?.channels) ? trigger.config.channels : [];
    // The step's own channel when it is known (a cart step's via), else the trigger's.
    if (channel ? channel === "WHATSAPP" : !chs.length || chs.includes("WHATSAPP")) {
      out.push(err("needs_24h_window", `"${def.label}" cannot reach a WhatsApp customer who has not written in 24 hours. Use a template, or limit this automation to other channels.`));
    }
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
    case "send_comment_reply":
      // The comment walker's own fields: mode "text" (data.text) or "ai" (data.agentId, optional data.fallbackText).
      if (d.mode === "ai" ? empty(d.agentId) : empty(d.text)) out.push(err("missing_config", d.mode === "ai" ? "Pick the AI employee who writes the reply." : "Write the reply."));
      break;
    case "create_task": if (empty(d.title)) out.push(err("missing_config", "The task needs a title.")); break;
    case "notify_team": if (empty(d.message)) out.push(err("missing_config", "Write the notification.")); break;
  }
  return out;
}

/**
 * What the comment walker runs (comment-trigger.service): everything a
 * comment automation does BEFORE the first Wait for reply. After it the
 * customer is in a DM and the normal walker takes over.
 */
const COMMENT_WALK_TYPES = new Set([
  TRIGGER_NODE_TYPE, "condition_group", "set_variable", "send_message_text", "send_message_file", "send_message_image",
  "send_message_interactive", "send_buttons", "wait_for_reply", "send_comment_reply",
]);

/** Node ids reachable from the trigger without passing a Wait for reply. */
export function beforeFirstWait(nodes: ANode[], edges: AEdge[]): Set<string> {
  const start = nodes.find((n) => n.type === TRIGGER_NODE_TYPE);
  const out = new Set<string>();
  const stack = start ? [start.id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const n = nodes.find((x) => x.id === id);
    // A message that waits for the reply is a wait too (2026-10-14).
    if (n?.type === "wait_for_reply" || (n?.type === "send_message_text" && (n as any).data?.waitForReply)) continue;
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return out;
}

/** Older walker node types an automation may still contain (validated by validateGraph's own rules). */
const LEGACY_RUNNABLE = new Set(["set_variable", "collect_input", "send_message_image", "send_message_quick_reply", "send_message_interactive", "bring_user_data", "end"]);

function cartIssues(cart: ReturnType<typeof cartPlanOf>, nodes: ANode[], edges: AEdge[], reach?: { whatsapp: boolean; email: boolean }): GraphIssue[] {
  const out: GraphIssue[] = [];
  const err = (code: string, nodeId: string | undefined, message: string) => out.push({ severity: "error", code, ...(nodeId ? { nodeId } : {}), message });
  if (cart.first && !cart.via) err("via_required", cart.first.id, "Choose how this first message reaches the customer: WhatsApp or email.");
  for (const [via, node] of [[cart.via, cart.first], [cart.fallbackVia, cart.fallback]] as const) {
    if (via && node && reach && !reach[via]) err("via_not_connected", node.id, via === "email" ? "Connect an email account to send by email." : "Connect a WhatsApp number to send on WhatsApp.");
  }
  if (cart.fallback) {
    if (!cart.fallbackVia) err("via_required", cart.fallback.id, "Choose how this message reaches the customer: WhatsApp or email.");
    else if (cart.fallbackVia === cart.via) err("unreachable_same_channel", cart.fallback.id, "\"If they can't be reached\" has to try the other channel.");
  }
  for (const e of edges) {
    if (e.sourceHandle === UNREACHABLE_HANDLE && e.source !== cart.first?.id) err("unreachable_only_on_first_send", e.source, "\"If they can't be reached\" exists only on the first message.");
  }
  // One channel per run: a later step that names the other channel cannot send there.
  for (const n of nodes) {
    const v = viaOf(n);
    if (!v || n.type === "send_message_template") continue;
    const onMain = cart.mainPath.has(n.id), onFallback = cart.fallbackPath.has(n.id) && !onMain;
    const expected = onFallback ? cart.fallbackVia : onMain ? cart.via : null;
    if (expected && v !== expected) err("via_mismatch", n.id, "Every message in a run goes out on the channel the customer was reached on.");
  }
  return out;
}

/**
 * Can this automation go live? `errors` block; `warnings` do not. The shared
 * graph rules (validateGraph) plus the automation's own: one trigger, a known
 * trigger, every node runnable here, per-node settings, branches that exist.
 */
export function validateAutomation(
  trigger: { type: string; config?: any } | null,
  nodes: ANode[],
  edges: AEdge[],
  ctx: { voiceConnected: boolean; reach?: { whatsapp: boolean; email: boolean } } = { voiceConnected: true },
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
  const channel = pathChannelOf(trigger, nodes ?? [], edges ?? []);
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  const cart = trigger?.type === "cart_abandoned" ? cartPlanOf(nodes ?? [], edges ?? []) : null;
  // A cart automation's unreachable branch runs on the other channel.
  const channelOfNode = (id: string) => (cart && cart.fallbackPath.has(id) && !cart.mainPath.has(id) ? viaChannel(cart.fallbackVia) : channel);
  for (const n of nodes ?? []) errors.push(...nodeIssues(n, trigger, channelOfNode(n.id)));
  if (cart) errors.push(...cartIssues(cart, nodes ?? [], edges ?? [], ctx.reach));
  else for (const e of edges ?? []) {
    if (e.sourceHandle === UNREACHABLE_HANDLE) errors.push({ severity: "error", code: "unreachable_only_on_first_send", nodeId: e.source, message: "\"If they can't be reached\" exists only on the first message of a cart automation." });
  }
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
  // A comment automation: the steps before the first Wait for reply run in
  // the comment walker; a public comment reply exists only there.
  const pre = trigger?.type === "comment_received" ? beforeFirstWait(nodes ?? [], edges ?? []) : null;
  for (const n of nodes ?? []) {
    if (pre && pre.has(n.id) && !COMMENT_WALK_TYPES.has(n.type)) {
      errors.push({ severity: "error", code: "comment_step_unsupported", nodeId: n.id, message: `"${labelOfNode(n.type)}" cannot run on a comment before the customer replies. Put it after a Wait for reply.` });
    }
    if (n.type === "send_comment_reply" && !(pre && pre.has(n.id))) {
      errors.push({ severity: "error", code: "comment_reply_misplaced", nodeId: n.id, message: "A reply to the comment only works in a Comment on a post automation, before any Wait for reply." });
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
