/**
 * Flow templates.
 *
 * Each template is a ready-to-edit graph - nodes and edges positioned so the
 * user can immediately grasp the shape, then tweak text / targets to taste.
 * Same format as what the save path persists, so "apply template" is just
 * setNodes(template.nodes) / setEdges(template.edges).
 *
 * IDs are stable strings per template so authors can re-apply without churn,
 * but the `data` blobs are copies (so editing one instance doesn't mutate
 * the template).
 */

// ─── Per-template form schema ────────────────────────────────
// Manychat-style: instead of clicking into nodes, the user fills a single
// form when picking a template, and `applyForm` pours those values onto the
// right node `data` fields before instantiation.

export type FormFieldDef =
  | { id: string; type: "text"; label: string; placeholder?: string; default?: string; helper?: string; required?: boolean }
  | { id: string; type: "textarea"; label: string; placeholder?: string; default?: string; helper?: string; rows?: number; required?: boolean }
  | { id: string; type: "keywords"; label: string; placeholder?: string; default?: string; helper?: string }
  | { id: string; type: "number"; label: string; min?: number; max?: number; default?: number; helper?: string; required?: boolean }
  | { id: string; type: "select"; label: string; options: Array<{ value: string; label: string }>; default?: string; helper?: string };

export type FormValues = Record<string, string | number | string[]>;

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  category: "Welcome" | "Support" | "Sales" | "FAQ" | "Lead Magnet" | "Booking" | "AI";
  tagline: string; // shown on the card
  // ReactFlow-compatible
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: any }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }>;
  // Form fields rendered after the user picks this template. Empty / omitted
  // means "no form, instantiate as-is" (Blank template).
  formFields?: FormFieldDef[];
  // Pour form values onto the node data. Receives a deep-cloned `nodes` array
  // it's allowed to mutate. Return value isn't used.
  applyForm?: (values: FormValues, nodes: FlowTemplate["nodes"]) => void;
}

// Helpers used inside applyForm functions.
function findData(nodes: FlowTemplate["nodes"], id: string): any | null {
  return nodes.find((n) => n.id === id)?.data ?? null;
}
function setIf(values: FormValues, key: string, target: any, field: string): void {
  const v = values[key];
  if (v != null && v !== "") target[field] = v;
}

// Layout helpers - keep templates tidy without pulling in a layout engine.
const COL = { a: 80, b: 440, c: 800, d: 1160 };
const ROW = (n: number) => 80 + n * 180;

// Edge factory with the styling the editor reapplies on load.
const edge = (
  source: string,
  target: string,
  sourceHandle?: string | null,
): FlowTemplate["edges"][number] => ({
  id: `e_${source}_${target}_${sourceHandle ?? ""}`,
  source,
  target,
  sourceHandle: sourceHandle ?? null,
});

export const FLOW_TEMPLATES: FlowTemplate[] = [
  // ─── 1. Welcome + name capture ───────────────────────────────
  {
    id: "welcome",
    name: "Welcome new contact",
    description:
      "Greet every new message, ask for their name, and use it in the reply. A friendly first-touch.",
    category: "Welcome",
    tagline: "Greet and capture a name",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      { id: "greet", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Hi there - welcome! 👋" } },
      { id: "ask_name", type: "collect_input", position: { x: COL.b, y: ROW(1) }, data: { prompt: "What's your name?", variable: "customer_name", validation: "any" } },
      { id: "reply", type: "send_message_text", position: { x: COL.b, y: ROW(2) }, data: { text: "Great to meet you, {{customer_name}}! How can we help today?" } },
      { id: "end", type: "end", position: { x: COL.b, y: ROW(3) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("ch", "greet"),
      edge("greet", "ask_name"),
      edge("ask_name", "reply"),
      edge("reply", "end"),
    ],
    formFields: [
      { id: "greeting",     type: "textarea", label: "Greeting message",   default: "Hi there - welcome! 👋", rows: 2 },
      { id: "name_prompt",  type: "text",     label: "Name question",       default: "What's your name?" },
      { id: "reply_after",  type: "textarea", label: "Reply after capture", default: "Great to meet you, {{customer_name}}! How can we help today?", helper: "Use {{customer_name}} to insert the captured name.", rows: 2 },
    ],
    applyForm: (v, nodes) => {
      const greet = findData(nodes, "greet");
      const askName = findData(nodes, "ask_name");
      const reply = findData(nodes, "reply");
      if (greet) setIf(v, "greeting", greet, "text");
      if (askName) setIf(v, "name_prompt", askName, "prompt");
      if (reply) setIf(v, "reply_after", reply, "text");
    },
  },

  // ─── 3. FAQ menu with quick replies ──────────────────────────
  {
    id: "faq_menu",
    name: "FAQ menu",
    description:
      "Show the 3 most common questions as tappable buttons. Each option sends its canned answer, then waits for the next message.",
    category: "FAQ",
    tagline: "Menu-driven self-serve",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      {
        id: "menu",
        type: "send_message_quick_reply",
        position: { x: COL.b, y: ROW(0) },
        data: {
          text: "How can we help?",
          replies: [
            { id: "r_hours",  label: "Opening hours", payload: "hours" },
            { id: "r_price",  label: "Pricing",       payload: "price" },
            { id: "r_human",  label: "Talk to human", payload: "human" },
          ],
        },
      },
      { id: "ans_hours", type: "send_message_text", position: { x: COL.c, y: ROW(0) }, data: { text: "We're open Mon–Fri, 9am–6pm." } },
      { id: "ans_price", type: "send_message_text", position: { x: COL.c, y: ROW(1) }, data: { text: "Plans start at $29/mo. Full pricing at example.com/pricing." } },
      { id: "route_human", type: "route_target", position: { x: COL.c, y: ROW(2) }, data: { routeType: "human", targetId: "" } },
      { id: "end_hours", type: "end", position: { x: COL.d, y: ROW(0) }, data: { kind: "wait_for_reply" } },
      { id: "end_price", type: "end", position: { x: COL.d, y: ROW(1) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("ch", "menu"),
      edge("menu", "ans_hours", "hours"),
      edge("menu", "ans_price", "price"),
      edge("menu", "route_human", "human"),
      edge("ans_hours", "end_hours"),
      edge("ans_price", "end_price"),
    ],
    formFields: [
      { id: "menu_prompt",   type: "text",     label: "Menu prompt",          default: "How can we help?" },
      { id: "option1_label", type: "text",     label: "Option 1 - button",    default: "Opening hours" },
      { id: "option1_answer",type: "textarea", label: "Option 1 - answer",    default: "We're open Mon–Fri, 9am–6pm.", rows: 2 },
      { id: "option2_label", type: "text",     label: "Option 2 - button",    default: "Pricing" },
      { id: "option2_answer",type: "textarea", label: "Option 2 - answer",    default: "Plans start at $29/mo. Full pricing at example.com/pricing.", rows: 2 },
      { id: "option3_label", type: "text",     label: "Option 3 - button (routes to human)", default: "Talk to human" },
    ],
    applyForm: (v, nodes) => {
      const menu = findData(nodes, "menu");
      const ansHours = findData(nodes, "ans_hours");
      const ansPrice = findData(nodes, "ans_price");
      if (menu) {
        setIf(v, "menu_prompt", menu, "text");
        const replies = Array.isArray(menu.replies) ? menu.replies : [];
        if (replies[0] && v.option1_label) replies[0].label = v.option1_label;
        if (replies[1] && v.option2_label) replies[1].label = v.option2_label;
        if (replies[2] && v.option3_label) replies[2].label = v.option3_label;
      }
      if (ansHours) setIf(v, "option1_answer", ansHours, "text");
      if (ansPrice) setIf(v, "option2_answer", ansPrice, "text");
    },
  },

  // ─── 4. Keyword → human handoff ──────────────────────────────
  {
    id: "human_handoff",
    name: "Talk to human (keyword)",
    description:
      "When someone types “agent”, “human”, or “help”, send a calming message and route to a live teammate.",
    category: "Support",
    tagline: "Bypass the bot when asked",
    nodes: [
      { id: "kw", type: "keyword_trigger", position: { x: COL.a, y: ROW(0) }, data: { keywords: ["agent", "human", "help"], matchType: "any", caseSensitive: false } },
      { id: "reassure", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Of course - connecting you to a teammate now. One moment." } },
      { id: "route_human", type: "route_target", position: { x: COL.c, y: ROW(0) }, data: { routeType: "human", targetId: "" } },
    ],
    edges: [
      edge("kw", "reassure"),
      edge("reassure", "route_human"),
    ],
    formFields: [
      { id: "keywords", type: "keywords", label: "Trigger keywords", default: "agent, human, help", helper: "Comma-separated. The flow fires when the user's message matches any of these." },
      { id: "reassure", type: "textarea", label: "Reassurance message", default: "Of course - connecting you to a teammate now. One moment.", rows: 2 },
    ],
    applyForm: (v, nodes) => {
      const kw = findData(nodes, "kw");
      const reassure = findData(nodes, "reassure");
      if (kw && Array.isArray(v.keywords)) kw.keywords = v.keywords;
      if (reassure) setIf(v, "reassure", reassure, "text");
    },
  },

  // ─── 5. Lead qualification ───────────────────────────────────
  {
    id: "lead_qualification",
    name: "Lead qualification",
    description:
      "Capture email + company, tag the contact as a lead, then hand off to a sales agent with the context.",
    category: "Sales",
    tagline: "Capture → tag → hand off",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      { id: "ask_email", type: "collect_input", position: { x: COL.b, y: ROW(0) }, data: { prompt: "Great - what's the best email to reach you?", variable: "customer_email", validation: "email" } },
      { id: "ask_company", type: "collect_input", position: { x: COL.b, y: ROW(1) }, data: { prompt: "And which company are you with?", variable: "customer_company", validation: "any" } },
      { id: "tag_lead", type: "update_customer", position: { x: COL.b, y: ROW(2) }, data: { action: "add_tag", key: "lead", value: "" } },
      { id: "set_email", type: "update_customer", position: { x: COL.c, y: ROW(0) }, data: { action: "set_attribute", key: "email", value: "{{customer_email}}" } },
      { id: "set_company", type: "update_customer", position: { x: COL.c, y: ROW(1) }, data: { action: "set_attribute", key: "company", value: "{{customer_company}}" } },
      { id: "confirm", type: "send_message_text", position: { x: COL.c, y: ROW(2) }, data: { text: "Thanks! A teammate from sales will follow up shortly." } },
      { id: "route_sales", type: "route_target", position: { x: COL.d, y: ROW(2) }, data: { routeType: "agent", targetId: "" } },
    ],
    edges: [
      edge("ch", "ask_email"),
      edge("ask_email", "ask_company"),
      edge("ask_company", "tag_lead"),
      edge("tag_lead", "set_email"),
      edge("set_email", "set_company"),
      edge("set_company", "confirm"),
      edge("confirm", "route_sales"),
    ],
    formFields: [
      { id: "email_prompt",   type: "text",     label: "Email question",   default: "Great - what's the best email to reach you?" },
      { id: "company_prompt", type: "text",     label: "Company question", default: "And which company are you with?" },
      { id: "confirmation",   type: "textarea", label: "Confirmation message", default: "Thanks! A teammate from sales will follow up shortly.", rows: 2 },
    ],
    applyForm: (v, nodes) => {
      const askEmail = findData(nodes, "ask_email");
      const askCompany = findData(nodes, "ask_company");
      const confirm = findData(nodes, "confirm");
      if (askEmail) setIf(v, "email_prompt", askEmail, "prompt");
      if (askCompany) setIf(v, "company_prompt", askCompany, "prompt");
      if (confirm) setIf(v, "confirmation", confirm, "text");
    },
  },

  // ─── 6. Drip / delayed follow-up ─────────────────────────────
  {
    id: "drip_followup",
    name: "Delayed follow-up",
    description:
      "Answer now, then follow up 30 minutes later with a link - handy for pricing nudges and quote reminders.",
    category: "Sales",
    tagline: "Reply now + nudge later",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      { id: "ack", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Got it - we'll send over the details shortly." } },
      { id: "wait", type: "wait", position: { x: COL.b, y: ROW(1) }, data: { amount: 30, unit: "minutes" } },
      { id: "nudge", type: "send_message_interactive", position: { x: COL.b, y: ROW(2) }, data: { text: "Here's the info you asked about:", buttonLabel: "View pricing", buttonUrl: "https://example.com/pricing" } },
      { id: "end", type: "end", position: { x: COL.b, y: ROW(3) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("ch", "ack"),
      edge("ack", "wait"),
      edge("wait", "nudge"),
      edge("nudge", "end"),
    ],
    formFields: [
      { id: "ack",         type: "textarea", label: "Immediate reply",  default: "Got it - we'll send over the details shortly.", rows: 2 },
      { id: "wait_amount", type: "number",   label: "Wait amount",      default: 30, min: 1 },
      { id: "wait_unit",   type: "select",   label: "Wait unit",        default: "minutes", options: [
        { value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" },
      ] },
      { id: "nudge_text",   type: "textarea", label: "Follow-up message", default: "Here's the info you asked about:", rows: 2 },
      { id: "nudge_label",  type: "text",     label: "Button label",      default: "View pricing" },
      { id: "nudge_url",    type: "text",     label: "Button URL",        default: "https://example.com/pricing" },
    ],
    applyForm: (v, nodes) => {
      const ack = findData(nodes, "ack");
      const wait = findData(nodes, "wait");
      const nudge = findData(nodes, "nudge");
      if (ack) setIf(v, "ack", ack, "text");
      if (wait) {
        if (typeof v.wait_amount === "number") wait.amount = v.wait_amount;
        if (typeof v.wait_unit === "string") wait.unit = v.wait_unit;
      }
      if (nudge) {
        setIf(v, "nudge_text", nudge, "text");
        setIf(v, "nudge_label", nudge, "buttonLabel");
        setIf(v, "nudge_url", nudge, "buttonUrl");
      }
    },
  },

  // ─── 7. Comment-to-DM lead magnet ────────────────────────────
  // Manychat's flagship pattern: someone comments a keyword on an IG/FB post,
  // the bot publicly replies + DMs them the resource (link / file URL) and
  // captures their email for the marketing list.
  {
    id: "comment_to_dm_lead_magnet",
    name: "Comment → DM lead magnet",
    description:
      "Drop a keyword on an IG / FB post → public reply + DM the resource link + capture email. The Manychat-style growth loop.",
    category: "Lead Magnet",
    tagline: "Comment trigger → resource + email",
    nodes: [
      { id: "trig",         type: "comment_trigger",     position: { x: COL.a, y: ROW(0) }, data: { channelId: "", postId: "", keywords: ["FREEBIE"], matchType: "any", caseSensitive: false } },
      { id: "public_reply", type: "send_comment_reply",  position: { x: COL.b, y: ROW(0) }, data: { text: "Sent! Check your DMs 📬" } },
      { id: "dm_intro",     type: "send_message_text",   position: { x: COL.b, y: ROW(1) }, data: { text: "Hey! Here's the resource you asked for 👇" } },
      { id: "dm_resource",  type: "send_message_interactive", position: { x: COL.b, y: ROW(2) }, data: { text: "Tap below to grab it.", buttonLabel: "Get it", buttonUrl: "https://example.com/freebie" } },
      { id: "ask_email",    type: "collect_input",       position: { x: COL.b, y: ROW(3) }, data: { prompt: "What's the best email to send updates to?", variable: "customer_email", validation: "email" } },
      { id: "save_email",   type: "update_customer",     position: { x: COL.b, y: ROW(4) }, data: { action: "set_attribute", key: "email", value: "{{customer_email}}" } },
      { id: "confirm",      type: "send_message_text",   position: { x: COL.b, y: ROW(5) }, data: { text: "Thanks! You're on the list - we'll only send the good stuff." } },
      { id: "end",          type: "end",                 position: { x: COL.b, y: ROW(6) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("trig", "public_reply"),
      edge("public_reply", "dm_intro"),
      edge("dm_intro", "dm_resource"),
      edge("dm_resource", "ask_email"),
      edge("ask_email", "save_email"),
      edge("save_email", "confirm"),
      edge("confirm", "end"),
    ],
    formFields: [
      { id: "keyword",      type: "keywords", label: "Trigger keyword",   default: "FREEBIE",                                   helper: "What people comment to trigger this. Comma-separated for synonyms." },
      { id: "post_id",      type: "text",     label: "Post ID (optional)", default: "",                                          helper: "Leave blank to fire on any post on the connected account." },
      { id: "public_reply", type: "text",     label: "Public reply on the comment", default: "Sent! Check your DMs 📬" },
      { id: "dm_intro",     type: "textarea", label: "DM opener",           default: "Hey! Here's the resource you asked for 👇", rows: 2 },
      { id: "resource_label", type: "text",   label: "Resource button label", default: "Get it" },
      { id: "resource_url",   type: "text",   label: "Resource URL",         default: "https://example.com/freebie", helper: "Link to the lead magnet (PDF, page, video - anything URL-addressable)." },
      { id: "email_prompt", type: "text",     label: "Email question",      default: "What's the best email to send updates to?" },
      { id: "confirmation", type: "textarea", label: "Confirmation message", default: "Thanks! You're on the list - we'll only send the good stuff.", rows: 2 },
    ],
    applyForm: (v, nodes) => {
      const trig = findData(nodes, "trig");
      const publicReply = findData(nodes, "public_reply");
      const dmIntro = findData(nodes, "dm_intro");
      const dmRes = findData(nodes, "dm_resource");
      const askEmail = findData(nodes, "ask_email");
      const confirm = findData(nodes, "confirm");
      if (trig) {
        if (Array.isArray(v.keyword)) trig.keywords = v.keyword;
        if (typeof v.post_id === "string") trig.postId = v.post_id;
      }
      if (publicReply) setIf(v, "public_reply", publicReply, "text");
      if (dmIntro) setIf(v, "dm_intro", dmIntro, "text");
      if (dmRes) {
        setIf(v, "resource_label", dmRes, "buttonLabel");
        setIf(v, "resource_url", dmRes, "buttonUrl");
      }
      if (askEmail) setIf(v, "email_prompt", askEmail, "prompt");
      if (confirm) setIf(v, "confirmation", confirm, "text");
    },
  },

  // ─── 8. Giveaway / contest entry ─────────────────────────────
  {
    id: "giveaway_entry",
    name: "Giveaway entry capture",
    description:
      "Comment ENTER on a post → DM confirmation + email capture + tagged for the giveaway. Drives shares and grows the list at once.",
    category: "Lead Magnet",
    tagline: "Contest comment → email + tag",
    nodes: [
      { id: "trig",         type: "comment_trigger",    position: { x: COL.a, y: ROW(0) }, data: { channelId: "", postId: "", keywords: ["ENTER"], matchType: "any", caseSensitive: false } },
      { id: "public_reply", type: "send_comment_reply", position: { x: COL.b, y: ROW(0) }, data: { text: "You're in! Check your DMs 🎉" } },
      { id: "dm_intro",     type: "send_message_text",  position: { x: COL.b, y: ROW(1) }, data: { text: "Thanks for entering! One last thing -" } },
      { id: "ask_email",    type: "collect_input",      position: { x: COL.b, y: ROW(2) }, data: { prompt: "Drop your email so we can reach you if you win 🏆", variable: "customer_email", validation: "email" } },
      { id: "save_email",   type: "update_customer",    position: { x: COL.b, y: ROW(3) }, data: { action: "set_attribute", key: "email", value: "{{customer_email}}" } },
      { id: "tag_entry",    type: "update_customer",    position: { x: COL.b, y: ROW(4) }, data: { action: "add_tag", key: "giveaway_entry", value: "" } },
      { id: "confirm",      type: "send_message_text",  position: { x: COL.b, y: ROW(5) }, data: { text: "You're entered! We'll DM you if you win. Good luck 🍀" } },
      { id: "end",          type: "end",                position: { x: COL.b, y: ROW(6) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("trig", "public_reply"),
      edge("public_reply", "dm_intro"),
      edge("dm_intro", "ask_email"),
      edge("ask_email", "save_email"),
      edge("save_email", "tag_entry"),
      edge("tag_entry", "confirm"),
      edge("confirm", "end"),
    ],
    formFields: [
      { id: "post_id",       type: "text",     label: "Giveaway post ID", default: "",                                                helper: "The specific post for this giveaway. Required to scope the trigger." },
      { id: "keyword",       type: "keywords", label: "Entry keyword",    default: "ENTER" },
      { id: "public_reply",  type: "text",     label: "Public reply on the comment", default: "You're in! Check your DMs 🎉" },
      { id: "dm_intro",      type: "textarea", label: "DM opener",        default: "Thanks for entering! One last thing -", rows: 2 },
      { id: "email_prompt",  type: "text",     label: "Email question",   default: "Drop your email so we can reach you if you win 🏆" },
      { id: "tag_label",     type: "text",     label: "Entry tag",        default: "giveaway_entry", helper: "Tag added to the contact so you can pick winners or follow up later." },
      { id: "confirmation",  type: "textarea", label: "Confirmation message", default: "You're entered! We'll DM you if you win. Good luck 🍀", rows: 2 },
    ],
    applyForm: (v, nodes) => {
      const trig = findData(nodes, "trig");
      const publicReply = findData(nodes, "public_reply");
      const dmIntro = findData(nodes, "dm_intro");
      const askEmail = findData(nodes, "ask_email");
      const tagEntry = findData(nodes, "tag_entry");
      const confirm = findData(nodes, "confirm");
      if (trig) {
        if (typeof v.post_id === "string") trig.postId = v.post_id;
        if (Array.isArray(v.keyword)) trig.keywords = v.keyword;
      }
      if (publicReply) setIf(v, "public_reply", publicReply, "text");
      if (dmIntro) setIf(v, "dm_intro", dmIntro, "text");
      if (askEmail) setIf(v, "email_prompt", askEmail, "prompt");
      if (tagEntry && typeof v.tag_label === "string") tagEntry.key = v.tag_label;
      if (confirm) setIf(v, "confirmation", confirm, "text");
    },
  },

  // ─── 9. Appointment booking via quick replies ────────────────
  {
    id: "appointment_booking",
    name: "Appointment booking",
    description:
      "User asks to book → pick a time slot → capture name + phone → tag and route to a teammate to confirm.",
    category: "Booking",
    tagline: "Quick-reply slot → handoff",
    nodes: [
      { id: "kw",        type: "keyword_trigger",         position: { x: COL.a, y: ROW(0) }, data: { keywords: ["book", "appointment", "schedule"], matchType: "any", caseSensitive: false } },
      { id: "slots",     type: "send_message_quick_reply",position: { x: COL.b, y: ROW(0) }, data: {
          text: "Happy to set you up. When works best?",
          replies: [
            { id: "s_morning",   label: "Morning",   payload: "morning" },
            { id: "s_afternoon", label: "Afternoon", payload: "afternoon" },
            { id: "s_evening",   label: "Evening",   payload: "evening" },
          ],
        } },
      { id: "ask_name",  type: "collect_input",   position: { x: COL.c, y: ROW(0) }, data: { prompt: "Got it. What name should I put it under?", variable: "customer_name", validation: "any" } },
      { id: "ask_phone", type: "collect_input",   position: { x: COL.c, y: ROW(1) }, data: { prompt: "And the best phone number?", variable: "customer_phone", validation: "any" } },
      { id: "tag",       type: "update_customer", position: { x: COL.c, y: ROW(2) }, data: { action: "add_tag", key: "appointment_pending", value: "" } },
      { id: "confirm",   type: "send_message_text", position: { x: COL.c, y: ROW(3) }, data: { text: "Thanks {{customer_name}} - a teammate will confirm shortly." } },
      { id: "route",     type: "route_target",     position: { x: COL.d, y: ROW(3) }, data: { routeType: "human", targetId: "" } },
    ],
    edges: [
      edge("kw", "slots"),
      edge("slots", "ask_name", "morning"),
      edge("slots", "ask_name", "afternoon"),
      edge("slots", "ask_name", "evening"),
      edge("ask_name", "ask_phone"),
      edge("ask_phone", "tag"),
      edge("tag", "confirm"),
      edge("confirm", "route"),
    ],
    formFields: [
      { id: "keywords",    type: "keywords", label: "Trigger keywords",  default: "book, appointment, schedule" },
      { id: "prompt",      type: "text",     label: "Slot question",     default: "Happy to set you up. When works best?" },
      { id: "slot1",       type: "text",     label: "Slot 1 label",      default: "Morning" },
      { id: "slot2",       type: "text",     label: "Slot 2 label",      default: "Afternoon" },
      { id: "slot3",       type: "text",     label: "Slot 3 label",      default: "Evening" },
      { id: "name_prompt", type: "text",     label: "Name question",     default: "Got it. What name should I put it under?" },
      { id: "phone_prompt",type: "text",     label: "Phone question",    default: "And the best phone number?" },
      { id: "confirmation",type: "textarea", label: "Confirmation",      default: "Thanks {{customer_name}} - a teammate will confirm shortly.", rows: 2, helper: "Use {{customer_name}} to insert the captured name." },
    ],
    applyForm: (v, nodes) => {
      const kw = findData(nodes, "kw");
      const slots = findData(nodes, "slots");
      const askName = findData(nodes, "ask_name");
      const askPhone = findData(nodes, "ask_phone");
      const confirm = findData(nodes, "confirm");
      if (kw && Array.isArray(v.keywords)) kw.keywords = v.keywords;
      if (slots) {
        setIf(v, "prompt", slots, "text");
        const replies = Array.isArray(slots.replies) ? slots.replies : [];
        if (replies[0] && typeof v.slot1 === "string") replies[0].label = v.slot1;
        if (replies[1] && typeof v.slot2 === "string") replies[1].label = v.slot2;
        if (replies[2] && typeof v.slot3 === "string") replies[2].label = v.slot3;
      }
      if (askName) setIf(v, "name_prompt", askName, "prompt");
      if (askPhone) setIf(v, "phone_prompt", askPhone, "prompt");
      if (confirm) setIf(v, "confirmation", confirm, "text");
    },
  },

  // ─── 10. Customer support triage ─────────────────────────────
  {
    id: "support_triage",
    name: "Support triage",
    description:
      "User asks for help → pick a category → routed to the right team. Cuts the time agents spend sorting incoming requests.",
    category: "Support",
    tagline: "Category quick-reply → route",
    nodes: [
      { id: "kw",        type: "keyword_trigger",          position: { x: COL.a, y: ROW(0) }, data: { keywords: ["help", "support", "issue"], matchType: "any", caseSensitive: false } },
      { id: "cats",      type: "send_message_quick_reply", position: { x: COL.b, y: ROW(0) }, data: {
          text: "Sorry to hear that - what's it about?",
          replies: [
            { id: "c_order", label: "Order issue", payload: "order"   },
            { id: "c_tech",  label: "Tech issue",  payload: "tech"    },
            { id: "c_other", label: "Something else", payload: "other" },
          ],
        } },
      { id: "route_order", type: "route_target", position: { x: COL.c, y: ROW(0) }, data: { routeType: "human", targetId: "" } },
      { id: "route_tech",  type: "route_target", position: { x: COL.c, y: ROW(1) }, data: { routeType: "human", targetId: "" } },
      { id: "route_other", type: "route_target", position: { x: COL.c, y: ROW(2) }, data: { routeType: "human", targetId: "" } },
    ],
    edges: [
      edge("kw", "cats"),
      edge("cats", "route_order", "order"),
      edge("cats", "route_tech",  "tech"),
      edge("cats", "route_other", "other"),
    ],
    formFields: [
      { id: "keywords", type: "keywords", label: "Trigger keywords", default: "help, support, issue" },
      { id: "prompt",   type: "text",     label: "Triage prompt",    default: "Sorry to hear that - what's it about?" },
      { id: "cat1",     type: "text",     label: "Category 1 label", default: "Order issue" },
      { id: "cat2",     type: "text",     label: "Category 2 label", default: "Tech issue" },
      { id: "cat3",     type: "text",     label: "Category 3 label", default: "Something else" },
    ],
    applyForm: (v, nodes) => {
      const kw = findData(nodes, "kw");
      const cats = findData(nodes, "cats");
      if (kw && Array.isArray(v.keywords)) kw.keywords = v.keywords;
      if (cats) {
        setIf(v, "prompt", cats, "text");
        const replies = Array.isArray(cats.replies) ? cats.replies : [];
        if (replies[0] && typeof v.cat1 === "string") replies[0].label = v.cat1;
        if (replies[1] && typeof v.cat2 === "string") replies[1].label = v.cat2;
        if (replies[2] && typeof v.cat3 === "string") replies[2].label = v.cat3;
      }
    },
  },

  // ─── 11. AI-powered first response ───────────────────────────
  {
    id: "ai_first_response",
    name: "AI auto-reply",
    description:
      "Hand the first reply to your AI agent - it answers from your knowledge base; falls through to a human if it can't.",
    category: "AI",
    tagline: "Channel entry → AI agent",
    nodes: [
      { id: "ch",   type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "", label: "Any channel", connected: true } },
      { id: "ai",   type: "ai_generate",   position: { x: COL.b, y: ROW(0) }, data: { systemPrompt: "You are a friendly support assistant. Keep replies under 3 sentences. Defer to a human if the customer asks for one or you're not confident.", outputVariable: "ai_reply" } },
      { id: "send", type: "send_message_text", position: { x: COL.b, y: ROW(1) }, data: { text: "{{ai_reply}}" } },
      { id: "end",  type: "end",            position: { x: COL.b, y: ROW(2) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("ch", "ai"),
      edge("ai", "send"),
      edge("send", "end"),
    ],
    formFields: [
      { id: "system_prompt", type: "textarea", label: "AI persona / instructions", default: "You are a friendly support assistant. Keep replies under 3 sentences. Defer to a human if the customer asks for one or you're not confident.", rows: 4, helper: "How the AI should sound and what it should and shouldn't do." },
    ],
    applyForm: (v, nodes) => {
      const ai = findData(nodes, "ai");
      if (ai) setIf(v, "system_prompt", ai, "systemPrompt");
    },
  },

  // ─── 12. Order status lookup ─────────────────────────────────
  {
    id: "order_status_lookup",
    name: "Order status lookup",
    description:
      "Customer asks about an order → bot collects the order ID → fetches status from your API → replies. Drops support volume.",
    category: "Support",
    tagline: "Order ID → API → reply",
    nodes: [
      { id: "kw",     type: "keyword_trigger", position: { x: COL.a, y: ROW(0) }, data: { keywords: ["order", "status", "tracking", "where"], matchType: "any", caseSensitive: false } },
      { id: "ask",    type: "collect_input",   position: { x: COL.b, y: ROW(0) }, data: { prompt: "Sure - what's your order number?", variable: "order_id", validation: "any" } },
      { id: "fetch",  type: "http_request",    position: { x: COL.b, y: ROW(1) }, data: { method: "GET", url: "https://api.example.com/orders/{{order_id}}", headers: {}, outputVariable: "order" } },
      { id: "reply",  type: "send_message_text", position: { x: COL.b, y: ROW(2) }, data: { text: "Order {{order_id}} is currently: {{order.status}}. ETA: {{order.eta}}." } },
      { id: "end",    type: "end",             position: { x: COL.b, y: ROW(3) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [
      edge("kw", "ask"),
      edge("ask", "fetch"),
      edge("fetch", "reply"),
      edge("reply", "end"),
    ],
    formFields: [
      { id: "keywords",  type: "keywords", label: "Trigger keywords", default: "order, status, tracking, where" },
      { id: "ask_text",  type: "text",     label: "Order ID question", default: "Sure - what's your order number?" },
      { id: "api_url",   type: "text",     label: "API URL",          default: "https://api.example.com/orders/{{order_id}}", helper: "Use {{order_id}} where the captured ID should be substituted." },
      { id: "reply_text",type: "textarea", label: "Reply template",    default: "Order {{order_id}} is currently: {{order.status}}. ETA: {{order.eta}}.", rows: 2, helper: "Reference fields from the API response with {{order.fieldName}}." },
    ],
    applyForm: (v, nodes) => {
      const ask = findData(nodes, "ask");
      const fetch = findData(nodes, "fetch");
      const reply = findData(nodes, "reply");
      if (ask) setIf(v, "ask_text", ask, "prompt");
      if (fetch) setIf(v, "api_url", fetch, "url");
      if (reply) setIf(v, "reply_text", reply, "text");
    },
  },
];

/**
 * Deep-clone a template so edits on the canvas don't mutate the shared
 * template object. IDs are suffixed with a per-apply nonce so re-applying
 * the same template twice doesn't collide with existing node IDs.
 */
export function instantiateTemplate(
  t: FlowTemplate,
  formValues?: FormValues,
): {
  nodes: FlowTemplate["nodes"];
  edges: FlowTemplate["edges"];
} {
  // Deep-clone first so applyForm can mutate freely without touching the
  // shared template object.
  const cloned: FlowTemplate["nodes"] = t.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { ...n.position },
    data: JSON.parse(JSON.stringify(n.data)),
  }));
  if (formValues && t.applyForm) t.applyForm(formValues, cloned);

  const nonce = Date.now().toString(36);
  const idMap = new Map<string, string>();
  const nodes = cloned.map((n) => {
    const newId = `${n.id}__${nonce}`;
    idMap.set(n.id, newId);
    return { id: newId, type: n.type, position: n.position, data: n.data };
  });
  const edges = t.edges.map((e) => ({
    id: `${e.id}__${nonce}`,
    source: idMap.get(e.source) || e.source,
    target: idMap.get(e.target) || e.target,
    sourceHandle: e.sourceHandle ?? null,
  }));
  return { nodes, edges };
}
