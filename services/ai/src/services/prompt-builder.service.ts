/**
 * Unified system-prompt builder for every AI mode in GOTCHA.
 *
 * Sits BELOW the Behavior Engine Layer. The BEL emits a frozen
 * `BehaviorState`; this builder consumes it and renders the system prompt.
 *
 * Section order is fixed (the platform's contract — authors do not choose):
 *
 *     [ Identity ]
 *     [ Goals ]
 *     [ Context ]
 *     [ Decision Layer ]
 *     [ Playbooks ]                  — strategy contract + selected conversation playbooks + author flow
 *     [ Knowledge ]
 *     [ Guardrails ]
 *     [ Execution Contract ]         — MANDATORY action enforcement (above Tools)
 *     [ Tools ]                      — allowed & required action categories from BehaviorState
 *
 * The builder NEVER decides behavior. It reads `behaviorState` and renders.
 * No prompt section can override the BEL.
 */

import fs from "fs";
import path from "path";
import {
  type BehaviorState,
  type AgentMode,
  type OutputContract,
} from "./behavior-engine.service";
import {
  STRATEGY_CONTRACTS,
  type StrategyContract,
  type StrategyName,
  type ActionCategory,
} from "./behavior-strategies";
import {
  CONVERSATION_PLAYBOOKS,
  type PlaybookId,
} from "./conversation-playbooks";

const PROMPTS_DIR = path.resolve(__dirname, "../prompts");
const GUARDRAILS = readPrompt("guardrails.md");

function readPrompt(filename: string): string {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, filename), "utf-8").trim();
  } catch (err) {
    console.warn(`[prompt-builder] failed to read ${filename}:`, (err as Error).message);
    return "";
  }
}

// ─── Public types ───────────────────────────────────────────

export type { AgentMode, BehaviorState };

export interface AgentRecord {
  name: string;
  role: string;
  description?: string | null;
  tone?: string | null;
  style?: unknown;
  identity?: unknown;
  goals?: unknown;
  toneConfig?: unknown;
  behavioral?: unknown;
  persona?: unknown;
  conversationFlow?: unknown;
  customGuardrails?: unknown;
  escalationRules?: unknown;
  behavioralAnchors?: unknown;
}

export interface ContextSlot {
  customerBlock?: string;
  crmBlock?: string;
  pendingApprovalsBlock?: string;
  locale?: string;
}

export interface KnowledgeSlot {
  block?: string;
}

export interface BuildPromptOpts {
  /** REQUIRED. Builder fails closed if missing. */
  behaviorState: BehaviorState;
  agent: AgentRecord;
  context?: ContextSlot;
  knowledge?: KnowledgeSlot;
  /**
   * Concrete OpenAI tool function names available to the model THIS TURN
   * (after BEL allowedActions filtering). Used to render the capability
   * whitelist inside the Execution Contract — so the model can only
   * promise actions it has a tool for. Pass an empty list when no tools
   * are exposed (the prompt will print a "no capabilities" notice).
   */
  toolFunctionNames?: string[];
}

// ─── ESCALATION TOOL ────────────────────────────────────────

export const ESCALATION_TOOL = {
  type: "function" as const,
  function: {
    name: "escalate_to_human",
    description:
      "Transfer the conversation to a human agent. Use this when the customer explicitly asks for a human, when you cannot resolve their issue, when the customer is very upset, or when escalation rules are triggered.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief reason for escalation" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        summary: { type: "string", description: "Brief summary for the human agent" },
      },
      required: ["reason"],
    },
  },
};

// ─── Public entry point ─────────────────────────────────────

export function buildAgentPrompt(opts: BuildPromptOpts): string {
  if (!opts.behaviorState) {
    throw new Error(
      "[prompt-builder] BehaviorState is required. The Behavior Engine must run before the Prompt Builder.",
    );
  }
  const strategy = STRATEGY_CONTRACTS[opts.behaviorState.strategy];
  if (!strategy) {
    throw new Error(`[prompt-builder] Unknown strategy in BehaviorState: ${opts.behaviorState.strategy}`);
  }

  const sections: string[] = [];

  push(sections, buildIdentity(opts, strategy));
  push(sections, buildGoals(opts, strategy));
  push(sections, buildContext(opts));
  push(sections, buildDecisionLayer(opts, strategy));
  push(sections, buildPlaybooks(opts, strategy));
  push(sections, buildKnowledge(opts));
  push(sections, buildGuardrails(opts, strategy));
  push(sections, buildExecutionContract(opts, strategy));
  push(sections, buildToolsPolicy(opts));

  return sections.join("\n\n---\n\n");
}

function push(sections: string[], part: string | null): void {
  if (part && part.trim()) sections.push(part.trim());
}

// ─── Output contract instruction (formerly getModeInstruction) ──

export function renderOutputContractInstruction(contract: OutputContract): string {
  if (contract === "CONTEXT_ONLY") {
    return `You are reading a live conversation between a customer and a human agent and producing context cards for the agent.

Use every block above:
- Customer & Conversation Info — for status, channel, assignment, timing
- Conversation Transcript — for what was actually said and the latest customer message
- Knowledge Base (if present) — for facts; do NOT invent any not present here

Produce 2–4 short insights covering, in order: original reason for contact, what they need NOW (latest message), sentiment, recommended next step. Each insight is one sentence. Do NOT draft replies.

Call the \`submit_suggestions\` tool to deliver them.`;
  }
  if (contract === "CHAT") {
    return `You are talking to the HUMAN AGENT, not the customer. The agent is handling the conversation shown in the blocks above.

What the agent can ask you for:
- Answer questions about the customer, conversation, or policy
- Draft a message they can send to the customer (write it as the customer should receive it, in the customer's language)
- Suggest the next action — including proposing a tool call when a write/HITL action is the right next step
- Summarize sentiment, intent, or risk

Respond in plain text — no JSON. Be concise and actionable. Reply in the same language the agent uses to talk to you.`;
  }
  if (contract === "STRUCTURED_CONFIG") {
    return `Respond with a structured configuration delta. No prose. No conversational framing. Output only what the platform schema expects.`;
  }
  if (contract === "READY_MESSAGE") {
    return `You are drafting reply options the agent could send next to the customer.

Use every block above:
- Customer & Conversation Info — for tone, status, and assignment
- Conversation Transcript — for what was already said and the customer's latest message
- Knowledge Base (if present) — for facts; never fabricate beyond it

Produce 2–3 short reply options that address the customer's CURRENT need (their latest message), informed by their original reason for contacting. Each reply is 1–3 sentences, ready to send as-is, written in the customer's language and in the tone of the existing transcript.

Call the \`submit_suggestions\` tool to deliver them.`;
  }
  // REPLY (agent-mode default)
  return `Produce ONE conversational reply that advances the active strategy by exactly one move. One idea per message. Match the customer's language. Run any required tool silently before replying — never narrate tool use.`;
}

// ─── Section: Identity ──────────────────────────────────────

function buildIdentity(opts: BuildPromptOpts, _strategy: StrategyContract): string | null {
  const mode = opts.behaviorState.mode;
  if (mode === "generator") return GENERATOR_IDENTITY;

  const a = opts.agent;
  const lines: string[] = ["# Identity"];

  const name = (a.name || "").trim();
  const role = humanizeRole(a.role);
  const headline = name && role
    ? `You are **${name}**, a ${role}.`
    : name
    ? `You are **${name}**.`
    : role
    ? `You are a ${role}.`
    : "You are an AI employee.";
  lines.push(headline);

  if (a.description?.trim()) lines.push(a.description.trim());

  if (mode === "agent") {
    lines.push("");
    lines.push("## Language — STRICT");
    lines.push(
      "Reply in the SAME language the customer is using right now. Detect from their most recent message. If they wrote Hebrew (עברית) — reply in Hebrew. If English — English. If Arabic — Arabic. **Never default to English unless the customer is using it.** Match their script and direction.",
    );
    lines.push("");
    lines.push("## Addressing the customer");
    lines.push(
      "When the customer's first name is available in the **Context** block, address them by it naturally — early in the conversation (e.g. \"היי עומר\" / \"Hi Omer\"). Use the name once or twice; do not over-use it. Never use placeholders like \"customer\" or \"sir/ma'am\".",
    );
    lines.push("");
    lines.push(
      "**Mirror their greeting**: if the customer says \"היי\" reply \"היי עומר!\" — not \"תודה עומר\". \"Thanks\" is for after they did something. Match their register (formal/casual).",
    );
  }

  // Identity block (free-form override from agent config).
  const identityObj = asRecord(a.identity);
  if (identityObj) {
    if (typeof identityObj.role === "string" && identityObj.role.trim()) {
      lines.push(`Role: ${identityObj.role.trim()}`);
    }
    if (typeof identityObj.responsibility === "string" && identityObj.responsibility.trim()) {
      lines.push(`Responsibility: ${identityObj.responsibility.trim()}`);
    }
    const guidelines = asStringArray((identityObj as Record<string, unknown>).representationGuidelines);
    if (guidelines.length) {
      lines.push("Representation guidelines:");
      for (const g of guidelines) lines.push(`- ${g}`);
    }
  }

  const tones = (a.tone || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (tones.length) lines.push(`Voice: ${tones.join(", ")}.`);

  const toneCfg = asRecord(a.toneConfig);
  if (toneCfg) {
    const toneLines: string[] = [];
    if (toneCfg.formalityLevel) toneLines.push(`formality=${toneCfg.formalityLevel}`);
    if (toneCfg.empathyLevel) toneLines.push(`empathy=${toneCfg.empathyLevel}`);
    if (toneCfg.assertiveness) toneLines.push(`assertiveness=${toneCfg.assertiveness}`);
    if (toneCfg.brandAlignment) toneLines.push(`brand=${toneCfg.brandAlignment}`);
    if (toneLines.length) lines.push(`Tone: ${toneLines.join(", ")}.`);
  }

  lines.push(`Tone intensity (this turn): **${opts.behaviorState.toneIntensity}** — ${describeToneIntensity(opts.behaviorState.toneIntensity)}`);

  const persona = asRecord(a.persona);
  if (persona) {
    const personaLines: string[] = [];
    if (persona.gender && typeof persona.gender === "string") {
      personaLines.push(`- Gender: ${describeGender(persona.gender)}.`);
    }
    const traits = asRecord(persona.traits);
    if (traits) {
      if (traits.warmth) personaLines.push(`- Warmth: ${traits.warmth}.`);
      if (traits.humor) personaLines.push(`- Humor: ${traits.humor}.`);
    }
    const custom = asRecord(persona.customAttributes);
    if (custom) {
      for (const [k, v] of Object.entries(custom)) {
        if (typeof v === "string" && v.trim()) personaLines.push(`- ${k}: ${v.trim()}`);
      }
    }
    if (personaLines.length) {
      lines.push("Persona:");
      lines.push(...personaLines);
    }
  }

  const styleBullets = renderStyleBullets(a.style);
  if (styleBullets.length) {
    lines.push("Style:");
    lines.push(...styleBullets);
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

function describeToneIntensity(t: BehaviorState["toneIntensity"]): string {
  if (t === "soft") return "lower the assertiveness, lead with empathy and slow pacing.";
  if (t === "assertive") return "be direct and action-oriented; propose one clear next step.";
  return "balanced — neither pushy nor hesitant.";
}

// ─── Section: Goals ─────────────────────────────────────────

function buildGoals(opts: BuildPromptOpts, strategy: StrategyContract): string | null {
  if (opts.behaviorState.mode === "generator") return GENERATOR_GOALS;

  const lines: string[] = ["# Goals"];
  lines.push(`**This turn (${strategy.name}):** ${strategy.primaryGoal}`);

  if (opts.behaviorState.urgency === "high") {
    lines.push("**Urgent:** Resolve quickly or escalate. Do not introduce new topics.");
  }

  if (opts.behaviorState.escalationPressure === "escalate_now") {
    lines.push("**Escalation:** A gate has fired. Acknowledge the customer, then call `escalate_to_human`. Do not attempt further resolution.");
  }

  return lines.join("\n");
}

// ─── Section: Context ───────────────────────────────────────

function buildContext(opts: BuildPromptOpts): string | null {
  const ctx = opts.context;
  const blocks: string[] = [];

  blocks.push(renderBehaviorStateBlock(opts.behaviorState));

  if (ctx?.customerBlock?.trim()) blocks.push(ctx.customerBlock.trim());
  if (ctx?.crmBlock?.trim()) blocks.push(ctx.crmBlock.trim());
  if (ctx?.pendingApprovalsBlock?.trim()) blocks.push(ctx.pendingApprovalsBlock.trim());

  return ["# Context", ...blocks].join("\n\n");
}

function renderBehaviorStateBlock(s: BehaviorState): string {
  const lines = [
    "## Conversation State",
    `- User: ${s.userType.replace(/_/g, " ")}`,
    `- Stage: ${s.conversationStage}`,
    `- Intent: ${s.intent}`,
    `- Urgency: ${s.urgency}`,
    `- Engagement: ${s.engagementLevel}`,
    `- Decision intent: **${s.decisionIntent}**`,
  ];
  return lines.join("\n");
}

// ─── Section: Decision Layer ────────────────────────────────

function buildDecisionLayer(opts: BuildPromptOpts, strategy: StrategyContract): string {
  const mode = opts.behaviorState.mode;
  const langLine = languageDirective(mode, opts.context?.locale);
  const autonomyLine = renderAutonomyLine(opts.behaviorState.autonomy, mode);

  const head =
    mode === "generator"
      ? GENERATOR_DECISION_LAYER
      : mode === "copilot"
      ? COPILOT_DECISION_LAYER
      : AGENT_DECISION_LAYER;

  const strategyHeader = mode === "generator"
    ? ""
    : `## Active strategy: ${strategy.name}\n` +
      `- **Goal:** ${strategy.primaryGoal}\n` +
      `- **Posture:** ${strategy.posture}\n` +
      `- **Autonomy:** ${autonomyLine}`;

  return [head, strategyHeader, langLine].filter(Boolean).join("\n\n");
}

function renderAutonomyLine(autonomy: BehaviorState["autonomy"], mode: AgentMode): string {
  if (mode === "copilot") return "**advisory** — propose only; the human decides what to send.";
  if (autonomy === "full") return "**full** — execute writes within the strategy's allowed actions.";
  if (autonomy === "gated") return "**gated** — answer freely, but route any external write through approval (HITL).";
  return "**advisory** — do not execute writes; surface the next step for human judgment.";
}

const AGENT_DECISION_LAYER = `# Decision Layer

You are talking directly to the customer on behalf of the business. Each turn:
1. Read the **Conversation State** + **Context** above. They are the only source of truth about who the customer is and what is pending.
2. Read the customer's most recent message.
3. Apply the **Active strategy** below — its allowed actions, posture, and exit conditions.
4. If a tool can resolve the request, use it (silently, in the background). Never narrate tool use to the customer.
5. Produce ONE conversational reply that advances the strategy by exactly one move (acknowledge / ask / offer / confirm / close). One idea per message.
6. Never invent context. If a fact is not in the Context or Knowledge sections, you do not know it.`;

const COPILOT_DECISION_LAYER = `# Decision Layer

You are advising a HUMAN AGENT who is reading your output. The customer never sees your text directly — the human reviews and sends. Each turn:
1. Read the **Conversation State** + **Context** above and the live transcript.
2. Identify the customer's CURRENT need (their latest message), informed by their original reason for contact.
3. Apply the **Active strategy** (always SUPPORT_AGENT in this mode) — your suggestions must follow that strategy's allowed actions.
4. Use **read-only** tools when they would replace a guess with a fact. Do not perform write actions on your own — propose them as quick-actions for the human to approve.
5. Produce output in the shape requested by the active mode (reply suggestions / context insights / chat to the agent). Match the customer's language for any draft replies; match the human agent's language when chatting with them.

## Voice rules for reply suggestions — READ CAREFULLY

- A live human agent is reading your suggestions and will send them **as themselves**. Draft replies in **first person**, in the human's voice — warm, human, knowledgeable.
- **NEVER suggest** "I'll connect you with an agent / human / sales rep / specialist." The human IS the rep. Telling the customer they'll be handed off again is wrong and breaks the flow. Close the loop directly.
- **NEVER speak about the agent in third person** ("a rep will reach out", "our team will contact you", "someone will help you"). The agent is already there — they ARE the team.
- **NEVER reveal** you are an AI, a bot, or a system. The suggestion is sent AS the human.
- **NEVER apologize** for being an AI or for limitations. The agent is a real person with real authority — write like one.
- Do NOT include tool-call narration, internal actions, or escalation language inside the customer-facing reply text. Surface those as separate insights, not in the reply.
- Match the customer's language. Match the existing transcript's tone (formal/casual, warm/direct).`;

const GENERATOR_DECISION_LAYER = `# Decision Layer

You are the **Generator** — you help platform users build new AI agents. You are NOT a chatbot, NOT a customer-facing voice, and NOT a copilot. Each turn:
1. Read the partial agent configuration in the **Context** block.
2. Identify the next missing or ambiguous required field (Identity → Goals → Tone → Playbooks → Constraints, in that order).
3. Ask ONE structured question — preferably with enumerated choices. Avoid open-ended free-text prompts.
4. Normalize the user's answer into the configuration schema before saving.
5. When the configuration is complete and consistent, output a final structured-config delta and stop.

You never freelance. You do not invent goals, playbooks, or guardrails the user did not select.`;

function languageDirective(mode: AgentMode, locale?: string): string {
  if (mode === "agent") {
    return [
      "## Language",
      "Detect the language of the customer's MOST RECENT message and reply in THAT same language. " +
        "If the customer wrote in Hebrew, reply in Hebrew. If they wrote in English, reply in English. " +
        "Never default to English unless the customer is using it. Maintain the chosen language unless the customer switches.",
    ].join("\n");
  }
  if (mode === "copilot") {
    const named = LOCALE_LANGUAGE[locale || ""];
    if (named && named !== "English") {
      return [
        "## Language",
        `Respond to the human agent in ${named}. Draft customer-facing replies in the language the customer is using.`,
      ].join("\n");
    }
    return [
      "## Language",
      "Respond to the human agent in the language they are talking to you in. Draft customer-facing replies in the language the customer is using.",
    ].join("\n");
  }
  return "";
}

const LOCALE_LANGUAGE: Record<string, string> = {
  he: "Hebrew", ar: "Arabic", en: "English", es: "Spanish",
  fr: "French", de: "German", pt: "Portuguese", ru: "Russian",
  zh: "Chinese", ja: "Japanese",
};

// ─── Section: Playbooks ─────────────────────────────────────

function buildPlaybooks(opts: BuildPromptOpts, strategy: StrategyContract): string | null {
  if (opts.behaviorState.mode === "generator") return GENERATOR_PLAYBOOKS;

  const blocks: string[] = [];

  blocks.push(renderStrategyContract(strategy));

  // Selected conversation playbooks (BEL-chosen, platform-defined).
  for (const pid of opts.behaviorState.playbookIds) {
    const pb = CONVERSATION_PLAYBOOKS[pid];
    if (pb) blocks.push(renderConversationPlaybook(pb));
  }

  // Author-defined conversation flow (the agent's tactical sequence).
  const flow = coerceArray(opts.agent.conversationFlow);
  if (flow && flow.length) {
    blocks.push(renderFlow(flow));
  } else if (strategy.name !== "SUPPORT_AGENT" && opts.behaviorState.playbookIds.length === 0) {
    blocks.push(DEFAULT_TACTICAL_SEQUENCE);
  }

  // Behavioral anchors.
  const anchors = coerceArray(opts.agent.behavioralAnchors);
  if (anchors && anchors.length) blocks.push(renderAnchors(anchors));

  // Escalation rules.
  const escalation = coerceArray(opts.agent.escalationRules);
  if (escalation && escalation.length) blocks.push(renderEscalationRules(escalation));

  if (blocks.length === 0) return null;
  return ["# Playbooks", blocks.join("\n\n")].join("\n\n");
}

function renderStrategyContract(s: StrategyContract): string {
  const lines = [
    `## Active strategy contract — ${s.name}`,
    `- **Goal:** ${s.primaryGoal}`,
    `- **Posture:** ${s.posture}`,
  ];
  if (s.exitConditions.length) {
    lines.push("- **Exit conditions** (the strategy releases control when):");
    for (const e of s.exitConditions) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

function renderConversationPlaybook(pb: typeof CONVERSATION_PLAYBOOKS[PlaybookId]): string {
  const lines = [
    `## Active conversation playbook — ${pb.name}`,
    "",
    "Move sequence (each step closes with the noted action category):",
  ];
  pb.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.description}  *(action: \`${step.actionImplied}\`)*`);
  });
  if (pb.hardRules.length) {
    lines.push("");
    lines.push("**Hard rules:**");
    for (const r of pb.hardRules) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push("> The FINAL step of this playbook MUST advance the conversation. Do not finish on the prior steps.");
  return lines.join("\n");
}

const DEFAULT_TACTICAL_SEQUENCE = `## Default tactical sequence

When no other playbook applies:

1. **Open warmly.** On the first inbound, greet and briefly introduce yourself by name and role — one short line in the customer's language.
2. **Identify the need.** If the customer already stated it, skip to step 3. Otherwise ask one focused question.
3. **Look up context silently.** Use background tools (CRM lookups, prior orders, profile) to inform your answer. The customer never sees these calls.
4. **Act.** Apply the active strategy. Run create/update/note operations silently.
5. **Confirm and close.** Make sure the customer is satisfied before wrapping up.

One conversational move per message. Acknowledge slow tool calls with a short "give me a sec" in the customer's language before any external write.`;

function renderFlow(flow: any[]): string {
  const steps = flow
    .map((step, i) => {
      const title =
        step?.action || step?.title || step?.name || step?.step || step?.label || `Step ${i + 1}`;
      const details = step?.details || step?.description || step?.detail || step?.body;
      const lines = [`${i + 1}. **${String(title).trim()}**`];
      if (details) lines.push(`   ${String(details).trim()}`);
      return lines.join("\n");
    })
    .join("\n");

  return `## Author-defined conversation flow

This is the agent's custom tactical sequence. Walk it in order; adapt wording, never the sequence.

${steps}`;
}

function renderAnchors(anchors: any[]): string {
  const items = anchors
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      const condition = (a as any).condition || (a as any).when || "";
      const guidance = (a as any).guidance || (a as any).then || (a as any).do || "";
      if (!condition && !guidance) return null;
      return `- **When ${String(condition).trim()}** → ${String(guidance).trim()}`;
    })
    .filter(Boolean);
  if (!items.length) return "";
  return ["## Behavioral anchors", ...items].join("\n");
}

function renderEscalationRules(rules: any[]): string {
  const enabled = rules.filter((r: any) => r && r.enabled !== false);
  if (!enabled.length) return "";
  const items = enabled.map((r: any) => {
    let desc = `- ${r.label || r.type || "rule"}`;
    if (r.value !== undefined && r.value !== "") desc += ` (value: ${r.value})`;
    return desc;
  });
  return [
    "## Escalation gates",
    "Call `escalate_to_human` immediately when any of these conditions are met:",
    items.join("\n"),
  ].join("\n");
}

// ─── Section: Knowledge ─────────────────────────────────────

function buildKnowledge(opts: BuildPromptOpts): string | null {
  const block = opts.knowledge?.block?.trim();
  if (!block) return null;
  return ["# Knowledge", block].join("\n\n");
}

// ─── Section: Guardrails ────────────────────────────────────

function buildGuardrails(opts: BuildPromptOpts, strategy: StrategyContract): string {
  const blocks: string[] = ["# Guardrails"];

  if (GUARDRAILS) blocks.push(GUARDRAILS);

  const custom = asStringArray(opts.agent.customGuardrails);
  if (custom.length) {
    blocks.push(["## Additional Business Rules", ...custom.map((c) => `- ${c}`)].join("\n"));
  }

  if (strategy.forbiddenBehaviors.length) {
    blocks.push(
      [
        `## Forbidden in this turn (${strategy.name})`,
        ...strategy.forbiddenBehaviors.map((f) => `- ${f}`),
      ].join("\n"),
    );
  }

  blocks.push(TRUTHFULNESS_FOOTER);

  return blocks.join("\n\n");
}

const TRUTHFULNESS_FOOTER = `## Truthfulness
- Never fabricate facts not present in the **Context** or **Knowledge** sections.
- If the answer is not knowable from those sections, say so plainly. Do not bluff.
- Accuracy beats helpfulness — never invent prices, order numbers, dates, policies, names, or identifiers.

### Placeholder tokens — STRICTLY FORBIDDEN

Never write any of: \`$X\`, \`$Y\`, \`<price>\`, \`<amount>\`, \`[insert]\`, \`[TBD]\`, \`{price}\`, \`X NIS\`, \`X ש"ח\`, \`____\`, or any other unfilled placeholder. If a value would be a placeholder, restructure the sentence so it isn't needed.

### Prices — when you don't have an exact number

If the **Knowledge** section does not contain a specific price for the customer's situation, do NOT guess a number. Frame the answer around packaging shape and offer a tailored quote. Examples:

- ✓ "יש לנו מספר מסלולים שמותאמים לגודל הצוות ולערוצים שבהם אתם משתמשים. אשמח לשלוח לך הצעה ספציפית — בוא נתאם 15 דק' לראות מה מתאים."
- ✓ "Pricing depends on team size and the integrations you need — let me send you a tailored quote after a quick 15-min call."
- ✗ "התוכנית מתחילה ב-$X לחודש"  ← placeholder
- ✗ "סביב $50–$200"               ← invented number

### Don't fabricate your own actions

Don't claim you "found" a time, "scheduled" a meeting, "sent" a link, or "created" a record unless a tool actually returned a successful result for that action. If the customer offered the time, ACKNOWLEDGE their proposal — don't pretend you discovered it.`;

// ─── Section: Execution Contract (NEW — above Tools) ───────

function buildExecutionContract(opts: BuildPromptOpts, _strategy: StrategyContract): string | null {
  const mode = opts.behaviorState.mode;
  if (mode === "generator") return null; // Generator's contract is its decision layer.

  const required = opts.behaviorState.requiredActions;
  const intent = opts.behaviorState.decisionIntent;

  const lines: string[] = ["# Execution Contract (MANDATORY)"];

  if (intent === "ESCALATE") {
    lines.push("**Decision intent: ESCALATE.** Do not attempt resolution. Acknowledge the customer briefly, then call `escalate_to_human`. Anything else this turn is a failure.");
    return lines.join("\n");
  }

  if (intent === "HOLD") {
    lines.push("**Decision intent: HOLD.** A previous action is awaiting human approval. You may reply conversationally to keep the customer engaged but you MUST NOT call any write tool this turn. Do not narrate the pending approval to the customer.");
    return lines.join("\n");
  }

  // PROGRESS
  lines.push(
    "- You are not allowed to only respond conversationally. You MUST take an action that advances the conversation.",
    "- Tool-calling order: log/update CRM FIRST, then write the customer-facing reply.",
    "- Do NOT promise to send a link, schedule a meeting, send a calendar invite, or follow up later if no tool in the **Tools** section can fulfill that promise. If you cannot deliver it, do not promise it. Frame as \"אשמח לתאם — אשלח לך הצעה מותאמת\" / \"happy to coordinate — I'll send you a tailored proposal\" instead of fabricating a link.",
    "- Do NOT fabricate facts about your own actions. Don't say \"מצאתי זמן\" / \"I found a time\" — the customer chose the time. Acknowledge their proposal and confirm.",
    "- A polite close like \"if you need anything else, I'm here\" / \"אם יש שאלות נוספות אני כאן\" is allowed AFTER you have advanced (asked, proposed, executed) — never instead of advancing.",
  );

  if (required.length > 0) {
    lines.push("");
    lines.push("**Required this turn — explicit mapping:**");
    lines.push("");
    for (const r of required) {
      const matchedTools = (opts.toolFunctionNames ?? []).filter((fn) => toolMatchesAction(fn, r));
      if (matchedTools.length > 0) {
        lines.push(`- \`${r}\` → call **\`${matchedTools[0]}\`**${matchedTools.length > 1 ? ` (or any of: ${matchedTools.slice(1).map((t) => `\`${t}\``).join(", ")})` : ""}.`);
      } else {
        lines.push(`- \`${r}\` → **no tool available in your surface for this action**. State inline (one sentence, customer's language) what you would do if a tool existed — e.g. "אעביר את הפרטים לצוות שילווה אותך". Then advance with another move.`);
      }
    }
    lines.push("");
    lines.push("**ENFORCEMENT — read carefully:**");
    lines.push("- If a required action has a tool listed above, you MUST call that tool. Skipping it = your response will be rejected and regenerated.");
    lines.push("- There is no valid scenario where you skip a required action silently when a tool is listed for it.");
    lines.push("- For required actions with NO tool listed, you must still acknowledge the gap inline as instructed above.");
  }

  // ── Capability boundary — what the model is actually able to do. ──
  // Renders the actual tool function names (post-allowedActions filter)
  // and the canonical list of common-but-missing capabilities so the
  // model cannot promise an action it has no tool for.
  const toolFns = opts.toolFunctionNames ?? [];
  const capabilityWhitelist = toolFns.filter((n) => n && n !== "submit_suggestions");
  lines.push("");
  lines.push("## Capability boundary — DO NOT lie about what you can do");
  if (capabilityWhitelist.length > 0) {
    lines.push("**Tools you can ACTUALLY call this turn:**");
    for (const fn of capabilityWhitelist) lines.push(`- \`${fn}\``);
  } else {
    lines.push("**No tools are exposed this turn.** Do not promise any tool-driven action.");
  }
  lines.push("");
  lines.push("**Reality check before you send your reply:**");
  lines.push("Read your draft. Every promise must correspond to a tool above OR a tool you JUST called successfully this turn. If your draft contains any of these without a backing tool, DELETE the sentence:");
  lines.push("- A meeting being \"scheduled\" / \"booked\" / \"confirmed\" (\"מתואם\", \"נקבע\", \"booked\", \"scheduled\") — only true if you called a real booking tool that returned success.");
  lines.push("- A calendar invite, a meeting link, a Zoom link, a Calendly link, a calendar event.");
  lines.push("- A reminder before the meeting.");
  lines.push("- A proposal / quote being sent (\"אשלח לך הצעה\", \"I'll send a proposal\") — only when a tool was called to do it.");
  lines.push("- A follow-up phone call from a teammate.");
  lines.push("- A document, PDF, or attachment being sent.");
  lines.push("");
  lines.push("If a customer asks for any of the above and no tool can deliver it, say plainly: \"אשמח לתאם את זה — אבל אני אעבירה את הפרטים לצוות שילווה אותך\" / \"happy to coordinate that — I'll pass the details to the team to handle\". Do not invent a capability.");

  // Output contract reminder.
  lines.push("");
  lines.push(`**Output contract this turn:** \`${opts.behaviorState.outputContract}\` — see the per-mode instruction passed alongside this prompt.`);

  return lines.join("\n");
}

// ─── Section: Tools ────────────────────────────────────────

function buildToolsPolicy(opts: BuildPromptOpts): string {
  const mode = opts.behaviorState.mode;
  const autonomy = opts.behaviorState.autonomy;
  const allowed = opts.behaviorState.allowedActions;
  const required = opts.behaviorState.requiredActions;

  const policyHeader = renderToolPolicyHeader(mode, autonomy);

  const allowedLine =
    allowed.length > 0
      ? `**Allowed action categories this turn:** ${allowed.map((a) => `\`${a}\``).join(", ")}.`
      : "**No write actions are permitted this turn.** Read-only flows + escalation only.";

  const requiredLine =
    required.length > 0
      ? `**Required action categories this turn:** ${required.map((a) => `\`${a}\``).join(", ")}.`
      : "";

  return ["# Tools", policyHeader, allowedLine, requiredLine].filter(Boolean).join("\n\n");
}

function renderToolPolicyHeader(mode: AgentMode, autonomy: BehaviorState["autonomy"]): string {
  if (mode === "generator") return GENERATOR_TOOLS_POLICY;

  if (mode === "copilot") return COPILOT_TOOLS_POLICY;

  if (autonomy === "advisory") {
    return AGENT_TOOLS_POLICY_BASE +
      "\n- **Autonomy: advisory** — do NOT call write tools this turn. The platform has flagged this turn for human review.";
  }
  if (autonomy === "gated") {
    return AGENT_TOOLS_POLICY_BASE +
      "\n- **Autonomy: gated** — read tools are fine. Any external write may return `awaiting_approval`; if it does, acknowledge the customer naturally and stop calling that tool.";
  }
  return AGENT_TOOLS_POLICY_BASE +
    "\n- **Autonomy: full** — execute write actions within the allowed list when they are the right next step.";
}

const AGENT_TOOLS_POLICY_BASE = `Tools are listed separately as function schemas — call them by name. Policy:

- Prefer a tool over a guess. If a tool can resolve the customer's question, use it — but only if the action is in the allowed list above.
- Run tools SILENTLY. Never name tools, integrations, vendors, dashboards, or backend systems to the customer.
- Before any external write (CRM create/update, ticket open, etc.), send one short "give me a sec" line in the customer's language. Skip this for instant tools (tagging, identity linking, reads).
- If a tool returns \`awaiting_approval\`, the action is held for human review. Acknowledge the customer naturally and DO NOT call the same tool again this turn.
- If a tool fails, recover gracefully — try an alternative or escalate. Never blame the customer.
- Use \`escalate_to_human\` when an Escalation gate fires or the customer asks for a human.`;

const COPILOT_TOOLS_POLICY = `You may have read-only tools available (function schemas listed separately). Policy:

- Use read-only lookups freely when they would replace a guess with a fact.
- Do NOT execute write actions yourself. If a write is the right next move, propose it as a quick-action for the human agent to approve.
- Always finish by calling \`submit_suggestions\` with your final output. Call it exactly once.`;

const GENERATOR_TOOLS_POLICY = `You may have read-only configuration tools (function schemas listed separately). Policy:

- Use lookups to validate enumerated choices (department names, available playbooks, integration slugs).
- Never invent options that are not in the platform's catalog.
- Output the final structured config delta when the agent definition is complete.`;

// ─── Generator's built-in identity / goals / playbooks ─────

const GENERATOR_IDENTITY = `# Identity
You are the **GOTCHA Agent Generator** — a platform tool that helps users build a new AI agent through a guided, structured flow. You are not a customer-facing voice and not a copilot. You produce structured configuration, not prose conversations.`;

const GENERATOR_GOALS = `# Goals
Primary objective: convert the user's free-form intent into a complete, valid AI-agent configuration (Identity, Goals, Tone, Playbooks, Constraints).
Quality expectations:
- Completeness: every required field is filled before the agent is saved.
- Consistency: chosen goals, playbooks, and tone do not contradict each other.
- Normalization: free-text answers are mapped to enumerated values where the platform offers them.`;

const GENERATOR_PLAYBOOKS = `# Playbooks

## Builder flow — REQUIRED
Walk users through the configuration in this order. One field at a time.

1. **Identity** — name, role, who they represent.
2. **Goals** — primary objective + 0–2 secondary goals.
3. **Tone** — formality, empathy, assertiveness, brand alignment.
4. **Playbooks** — pick from the catalog (new-lead, qualification, support, etc.); never write playbooks freehand.
5. **Knowledge** — attach one or more knowledge bases.
6. **Constraints** — pick from common forbidden-action templates; add brand-specific items.
7. **Review** — show the assembled structured config and confirm.

### Question style
- Prefer enumerated multiple-choice. Fall back to short text only when no enumeration fits.
- Ask one question per turn. Confirm normalization after each answer.
- If the user's answer contradicts a previous selection, surface the conflict and ask them to resolve it.`;

/**
 * The platform-built Generator "agent" — used by routes/ai-agents.ts:/generate
 * so the Generator path goes through BEL → PB instead of an inline prompt.
 */
export const GENERATOR_BUILTIN_AGENT: AgentRecord = Object.freeze({
  name: "GOTCHA Agent Generator",
  role: "custom",
  description: "Helps tenant admins assemble a structured AI-agent configuration.",
  tone: "professional",
});

// ─── Helpers ────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return null;
}

function coerceArray(v: unknown): any[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  const arr = coerceArray(v);
  if (!arr) return [];
  return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
}

function renderStyleBullets(style: unknown): string[] {
  const obj = asRecord(style);
  if (!obj) return [];
  const out: string[] = [];
  if (obj.useEmojis === true) out.push("- Use emojis to keep conversations warm and friendly.");
  if (obj.useEmojis === false) out.push("- Avoid emojis.");
  if (obj.concise === true) out.push("- Keep responses concise.");
  if (obj.concise === false) out.push("- Provide detailed, thorough responses.");
  if (obj.useFirstName === true) out.push("- Address the customer by first name when known.");
  if (obj.proactive === true) out.push("- Be proactive — anticipate follow-ups and offer related help.");
  return out;
}

function describeGender(gender: string): string {
  switch (gender.toLowerCase()) {
    case "male": return "use masculine grammatical forms in gendered languages (Hebrew, Arabic)";
    case "female": return "use feminine grammatical forms in gendered languages (Hebrew, Arabic)";
    case "neutral": return "use gender-neutral forms in gendered languages (Hebrew, Arabic)";
    default: return gender;
  }
}

const ROLE_HUMAN_NAMES: Record<string, string> = {
  customer_support: "customer support agent",
  sales: "sales representative",
  booking: "booking agent",
  billing: "billing specialist",
  custom: "AI employee",
};

function humanizeRole(role: string | null | undefined): string {
  if (!role) return "AI employee";
  return ROLE_HUMAN_NAMES[role] || role.replace(/_/g, " ");
}

/**
 * Reverse-mapping: does this concrete tool function name implement the
 * given action category? Mirrors the rules in
 * `ai-bot.service.ts:filterToolsByAllowedActions` so the prompt renders
 * the same mapping the runtime filter applies.
 */
function toolMatchesAction(toolName: string, action: ActionCategory): boolean {
  if (!toolName) return false;
  if (toolName === "escalate_to_human") return action === "escalate_to_human";
  if (toolName === "link_customer_identifier") return action === "identity_link";
  if (toolName.startsWith("submit_")) return false; // terminator, not action

  if (/(_search|_get|_lookup|_read)$/.test(toolName)) {
    return action === "crm_read" || action === "kb_lookup";
  }
  if (/^integration_create_lead/.test(toolName)) return action === "create_lead";
  if (/^integration_create_contact/.test(toolName)) return action === "create_contact";
  if (/(_note$|add_note)/.test(toolName)) return action === "add_note";
  if (/(tag_|_tag$)/.test(toolName)) return action === "tag";
  if (/(schedule_followup|set_followup)/.test(toolName)) return action === "schedule_followup";
  if (/(book_|schedule_meeting|schedule_demo)/.test(toolName)) return action === "schedule_booking";
  if (/(send_proposal|send_quote|create_proposal)/.test(toolName)) return action === "send_proposal";
  if (/(update_|patch_)/.test(toolName)) return action === "update_record";
  return false;
}

export { STRATEGY_CONTRACTS };
export type { StrategyContract, StrategyName, ActionCategory };
