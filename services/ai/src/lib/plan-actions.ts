/**
 * The actions an approved plan can really carry out (action-executor arms).
 * propose_plan offers exactly these (its schema's enum); a plan with any
 * other step is refused before an approval exists, and again at execution.
 * update_crm, update_contact, create_ticket and create_task exist in the
 * executor but run against a stub that always fails, so they are not here.
 */
export const PLAN_ACTIONS = [
  "send_message",
  "tag_contact",
  "schedule_followup",
  "schedule_meeting",
  "create_broadcast",
  "schedule_broadcast",
  "create_workflow",
  "resolve_identity",
  "merge_contacts",
  "link_customer_identifier",
  // As the approver, through the app's own routes (2026-10-08, Omer):
  "claim_conversation",
  "assign_conversation",
  "close_conversation",
  "return_to_gotcha",
  "add_note",
  "answer_question",
] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];
