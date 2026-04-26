/**
 * Flow templates.
 *
 * Each template is a ready-to-edit graph — nodes and edges positioned so the
 * user can immediately grasp the shape, then tweak text / targets to taste.
 * Same format as what the save path persists, so "apply template" is just
 * setNodes(template.nodes) / setEdges(template.edges).
 *
 * IDs are stable strings per template so authors can re-apply without churn,
 * but the `data` blobs are copies (so editing one instance doesn't mutate
 * the template).
 */

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  category: "Welcome" | "Support" | "Sales" | "FAQ" | "Blank";
  tagline: string; // shown on the card
  // ReactFlow-compatible
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: any }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }>;
}

// Layout helpers — keep templates tidy without pulling in a layout engine.
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
  // ─── 1. Blank ────────────────────────────────────────────────
  {
    id: "blank",
    name: "Blank flow",
    description: "Empty canvas. Drag nodes from the palette to build from scratch.",
    category: "Blank",
    tagline: "Start from zero",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Webchat", connected: true } },
      { id: "end", type: "end", position: { x: COL.b, y: ROW(0) }, data: { kind: "wait_for_reply" } },
    ],
    edges: [edge("ch", "end")],
  },

  // ─── 2. Welcome + name capture ───────────────────────────────
  {
    id: "welcome",
    name: "Welcome new contact",
    description:
      "Greet every new message, ask for their name, and use it in the reply. A friendly first-touch.",
    category: "Welcome",
    tagline: "Greet and capture a name",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      { id: "greet", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Hi there — welcome! 👋" } },
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
      { id: "reassure", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Of course — connecting you to a teammate now. One moment." } },
      { id: "route_human", type: "route_target", position: { x: COL.c, y: ROW(0) }, data: { routeType: "human", targetId: "" } },
    ],
    edges: [
      edge("kw", "reassure"),
      edge("reassure", "route_human"),
    ],
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
      { id: "ask_email", type: "collect_input", position: { x: COL.b, y: ROW(0) }, data: { prompt: "Great — what's the best email to reach you?", variable: "customer_email", validation: "email" } },
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
  },

  // ─── 6. Drip / delayed follow-up ─────────────────────────────
  {
    id: "drip_followup",
    name: "Delayed follow-up",
    description:
      "Answer now, then follow up 30 minutes later with a link — handy for pricing nudges and quote reminders.",
    category: "Sales",
    tagline: "Reply now + nudge later",
    nodes: [
      { id: "ch", type: "channel_entry", position: { x: COL.a, y: ROW(0) }, data: { channelType: "webchat", label: "Any channel", connected: true } },
      { id: "ack", type: "send_message_text", position: { x: COL.b, y: ROW(0) }, data: { text: "Got it — we'll send over the details shortly." } },
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
  },
];

/**
 * Deep-clone a template so edits on the canvas don't mutate the shared
 * template object. IDs are suffixed with a per-apply nonce so re-applying
 * the same template twice doesn't collide with existing node IDs.
 */
export function instantiateTemplate(t: FlowTemplate): {
  nodes: FlowTemplate["nodes"];
  edges: FlowTemplate["edges"];
} {
  const nonce = Date.now().toString(36);
  const idMap = new Map<string, string>();
  const nodes = t.nodes.map((n) => {
    const newId = `${n.id}__${nonce}`;
    idMap.set(n.id, newId);
    return {
      id: newId,
      type: n.type,
      position: { ...n.position },
      data: JSON.parse(JSON.stringify(n.data)),
    };
  });
  const edges = t.edges.map((e) => ({
    id: `${e.id}__${nonce}`,
    source: idMap.get(e.source) || e.source,
    target: idMap.get(e.target) || e.target,
    sourceHandle: e.sourceHandle ?? null,
  }));
  return { nodes, edges };
}
