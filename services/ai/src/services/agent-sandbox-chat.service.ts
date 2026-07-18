/**
 * Sandbox employee chat - the "Test AI Employee" experience.
 *
 * The owner talks to their AI employee EXACTLY as a customer would, and the
 * employee answers in its production voice: its real identity, goal, house
 * rules, conversation flow and knowledge. This intentionally replaces the old
 * copilot-flavored test path (chatWithAgent in copilot CHAT mode), which read
 * like an assistant suggesting replies rather than the employee itself.
 *
 * Sandbox contract: tools are NEVER executed here. The employee knows its
 * tools exist and narrates what it WOULD do ("I'll book that for you"), but
 * must never claim a real action already happened.
 *
 * New LLM call → lives in services/ai (per CLAUDE.md).
 */

import { prisma } from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "./ai.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";

export interface SandboxChatInput {
  tenantId: string;
  agentId: string;
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function systemPrompt(agent: any, toolNames: string[], kbBlock: string | null): string {
  const identity = (agent.identity as any) || {};
  const persona = (agent.persona as any) || {};
  const company = str(identity.companyOverview);
  const guardrails: string[] = Array.isArray(agent.customGuardrails)
    ? (agent.customGuardrails as unknown[]).map((g) => str(g)).filter((g): g is string => !!g)
    : [];
  const flow: string[] = Array.isArray(agent.conversationFlow)
    ? (agent.conversationFlow as unknown[]).map((s: any) => str(typeof s === "string" ? s : s?.step || s?.label)).filter((s): s is string => !!s)
    : [];
  const success: string[] = Array.isArray(agent.successCriteria)
    ? (agent.successCriteria as unknown[]).map((s) => str(s)).filter((s): s is string => !!s)
    : [];
  const name = str(agent.name) || "the AI employee";
  const role = String(agent.role || "customer_support").replace(/_/g, " ");

  return [
    `You ARE ${name}, the ${role} AI employee${company ? ` at this business: ${company}` : ""}.`,
    "This is a live SANDBOX conversation: the person writing to you is playing a REAL CUSTOMER. Reply exactly as you would in production on chat (WhatsApp-style) - warm, human, concise, and ALWAYS in the language the customer writes in.",
    str(agent.goal) ? `\n# Your job\n${agent.goal}` : "",
    success.length ? `# Doing the job well means\n${success.map((s) => `- ${s}`).join("\n")}` : "",
    persona.brand_archetype ? `# Voice\nSpeak in the "${String(persona.brand_archetype).replace(/_/g, " ")}" register.` : "",
    guardrails.length ? `# House rules (NEVER break)\n${guardrails.map((g) => `- ${g}`).join("\n")}` : "",
    flow.length ? `# Your working routine\n${flow.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
    "\n# Honesty",
    "- Answer ONLY from the knowledge below and the business facts above. If you genuinely don't know, say so and offer to check or bring in a teammate - never invent policies, prices or availability.",
    toolNames.length
      ? `- SANDBOX: your tools (${toolNames.slice(0, 12).join(", ")}) are disconnected here. When you would normally act (book, look up an order, update a record), say naturally what you'll do next - but NEVER claim an action already completed.`
      : "- SANDBOX: no live tools are connected here. If an action would be needed, say what you'd arrange - never claim it already happened.",
    "\n# Style",
    "- Chat-length replies: 1-4 short sentences. At most ONE question per reply.",
    "- No long dashes (-, –) anywhere; use commas or periods.",
    kbBlock ? `\n## Knowledge\n${kbBlock}` : "",
  ].filter(Boolean).join("\n");
}

/** Returns the employee's reply, or null when the agent doesn't exist. */
export async function sandboxEmployeeChat(input: SandboxChatInput): Promise<string | null> {
  const agent = await prisma.aIAgent.findFirst({
    where: { id: input.agentId, tenantId: input.tenantId },
  });
  if (!agent) return null;

  const [tools, kbChunks] = await Promise.all([
    prisma.agentToolPermission.findMany({
      where: { tenantId: input.tenantId, aiAgentId: agent.id, isAllowed: true },
      select: { tenantTool: { select: { catalogTool: { select: { name: true } } } } },
      take: 30,
    }).catch(() => [] as any[]),
    retrieveRelevantChunks(input.tenantId, input.message, 5).catch(() => []),
  ]);
  const toolNames = (tools as any[])
    .map((t) => t?.tenantTool?.catalogTool?.name)
    .filter((n): n is string => typeof n === "string" && !!n);
  const kbBlock = kbChunks.length ? buildKnowledgeContext(kbChunks as any) || null : null;

  const history = (input.history || []).slice(-12).map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: String(m.content || "").slice(0, 2000),
  }));

  const resp = await generateResponse({
    tenantId: input.tenantId,
    model: getDefaultModel(),
    temperature: 0.6,
    maxTokens: 450,
    metadata: { type: "agent_sandbox_chat" },
    messages: [
      { role: "system", content: systemPrompt(agent, toolNames, kbBlock) },
      ...history,
      { role: "user", content: input.message },
    ],
  });
  const reply = resp.content?.trim() || null;
  if (!reply) return null;
  // Same wide-dash scrub the production reply path applies (humanizeReply):
  // the "-" tell must never reach a customer, sandbox included.
  return reply.replace(/\s*[-–―]\s*/g, ", ").replace(/,\s*([.!?,\n])/g, "$1");
}
