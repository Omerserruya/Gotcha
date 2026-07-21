/**
 * The ONE definition of what an AI employee looks like when it is created.
 *
 * There are two creation paths in the product - the AI Studio builder
 * (`POST /api/ai-agents`, via the wizard) and onboarding
 * (`POST /api/onboarding/complete` → agent-config-generator) - and they used
 * to hard-code their own default blocks. The generator set only
 * model/provider/temperature/maxTokens, so an employee hired during
 * onboarding silently differed from an identical one created in AI Studio on
 * `avatarColor`, `tone`, `languages`, `escalationMessage`,
 * `confidenceThreshold`, and both autonomy caps - fields that change how the
 * employee actually behaves at runtime (when it escalates, how long it may
 * run unattended).
 *
 * Both paths now spread `AI_AGENT_DEFAULTS`, so "created in onboarding" and
 * "created in AI Studio" mean the same thing to the backend. Any new default
 * belongs here and nowhere else.
 */

import { getDefaultModel } from "./ai.service";

/**
 * Field defaults applied at creation time when the caller did not specify a
 * value. Deliberately excludes identity-bearing fields (name, role, goal,
 * persona) - those are decisions the creation flow must make explicitly.
 */
export function aiAgentCreationDefaults() {
  return {
    avatarColor: "#7c5cfc",
    tone: "professional",
    languages: { english: true } as Record<string, boolean>,
    model: getDefaultModel(),
    provider: "openai",
    temperature: 0.7,
    maxTokens: 1024,
    // Autonomy envelope: how far the employee may go before a human is pulled
    // in. Left unset, an onboarding-created employee inherited raw schema
    // defaults and could behave differently from its Studio twin.
    maxAutonomousMessages: 10,
    maxAutonomousMinutes: 15,
    confidenceThreshold: 0.6,
    escalationMessage: "Let me connect you with a team member who can help further.",
  };
}

/** Convenience for call sites that just want to spread the object. */
export const AI_AGENT_DEFAULTS = aiAgentCreationDefaults;
