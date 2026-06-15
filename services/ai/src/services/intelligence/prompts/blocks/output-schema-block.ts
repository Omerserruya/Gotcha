/**
 * Inlined ConversationStateFrame schema description for the LLM.
 *
 * Phase 3 ships a single MAIN-TURN call producing the full frame as a JSON
 * object. The LLM's `response_format` is `{ type: "json_object" }` (existing
 * support in ai.service.ts). The schema is described here so the model can
 * emit a frame that the runner subsequently validates with Zod
 * (ConversationStateFrameSchema in @chatcenter/shared) before fan-out.
 *
 * A future polish pass can upgrade to `response_format: json_schema` strict
 * mode without changing this prompt block.
 */
export function outputSchemaBlock(): string {
  return `OUTPUT SCHEMA - emit a SINGLE JSON object with these fields, exactly:

{
  "intent": {
    "primary": "short noun-phrase, e.g. 'asking_pricing', 'objecting_timing', 'agreeing_demo'",
    "secondary": ["zero or more sub-intents"],
    "confidence": 0.0
  } | null,

  "stage": {
    "id": "stage id from the active playbook, or 'unknown'",
    "name": "human-readable stage name",
    "enteredAt": "ISO 8601 timestamp"
  } | null,

  "summary": null,

  "sentiment": {
    "customer": -1.0_to_1.0,
    "escalationRisk": 0.0_to_1.0
  } | null,

  "missingFields": [
    {"field": "customer.budget", "required": true, "suggestedQuestion": "Could you share your budget range?"}
  ],

  "suggestedActions": [
    {"text": "Push for budget now", "rationale": "customer hesitating on price", "urgency": "now"}
  ],

  "proposedTools": [
    {"tool": "create_followup_task", "args": {...}, "rationale": "customer asked for callback", "requiresApproval": true}
  ],

  "risks": [
    {"kind": "competitor_mention", "severity": "medium", "evidenceUtteranceIds": ["..."]}
  ],

  "urgency": "low" | "medium" | "high",
  "confidence": 0.0_to_1.0
}

Rules:
- "summary" is ALWAYS null in this turn - the rolling summary is owned by a
  separate side-summarizer; you must not write to it.
- Empty arrays are valid: missingFields, suggestedActions, proposedTools, risks.
- Use the latest utterance to bias intent; smooth confidence with the window.
- Mutating tools (anything that writes to CRM, sends messages, applies
  discounts) MUST set requiresApproval: true.
- suggestedActions are SHORT coach prompts ("Confirm decision-maker", "Push
  for budget"), not multi-line replies.`;
}
