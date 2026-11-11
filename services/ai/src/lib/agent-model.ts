import { getDefaultModel } from "../services/ai.service";

/**
 * The model an AI employee's calls run on: ALWAYS the platform model
 * (OPENAI_DEFAULT_MODEL), whatever ai_agents.model holds (Omer, 2026-11-11:
 * no per-employee model). Every employee row carried a frozen snapshot of the
 * default ("gpt-5-mini" on all prod and dev rows), so an env swap to
 * gpt-6-luna never reached the reply, regen, rewrite, cards, escalation or
 * recovery passes. The column is kept and simply no longer read: new
 * employees are written as "default", and the API no longer accepts a model.
 *
 * The ONE place an employee's model is decided; the argument is accepted only
 * so call sites read naturally and nothing can route around this.
 */
export function resolveAgentModel(_stored?: string | null): string {
  return getDefaultModel();
}
