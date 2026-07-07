/**
 * CRM capability — operation contracts, as DATA (business-only language; no vendor,
 * tool, or endpoint appears here). Same shape as the frozen CALENDAR contracts, but
 * co-located with the driver so adding CRM touches nothing in the kernel or shared.
 *
 * Operations: SEARCH_CUSTOMER (READ), UPSERT_CUSTOMER (WRITE — identity foundation).
 * CREATE_LEAD / ADD_NOTE (WRITEs) follow.
 */

import type { OperationContract } from "@chatcenter/shared";

const SEARCH_CUSTOMER: OperationContract = {
  id: "SEARCH_CUSTOMER",
  capability: "CRM",
  effect: "read",
  meaning: "is this person already in the CRM, and who are they?",
  params: [
    { key: "email", meaning: "an email address to look the customer up by", required: false },
    { key: "phone", meaning: "a phone number to look the customer up by", required: false },
  ],
  outcome: "the matching CRM contacts for the given identifiers (possibly none)",
  success: {
    id: "customer_search_established",
    statement: "a set of matching contacts (possibly empty) has been established from the CRM",
  },
  invariants: [
    {
      id: "search_key_known",
      statement: "at least one identifier to search by (email, phone, or the customer's external id) is known",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_identifier" },
    },
  ],
  failureModes: ["no_crm_configured", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: true, escalate: "never" },
  approval: "none",
};

const UPSERT_CUSTOMER: OperationContract = {
  id: "UPSERT_CUSTOMER",
  capability: "CRM",
  effect: "write",
  meaning: "ensure this customer exists in the CRM as a single record — resolve if known, create if new, reconcile duplicates",
  params: [
    { key: "email", meaning: "the customer's email address", required: false },
    { key: "phone", meaning: "the customer's phone number", required: false },
    { key: "name", meaning: "the customer's name (used only when creating a new record)", required: false },
  ],
  outcome: "a single canonical CRM contact for this customer (created or reconciled)",
  success: {
    id: "customer_record_resolved",
    statement: "exactly one canonical CRM contact represents this customer",
  },
  invariants: [
    {
      id: "identity_known",
      statement: "at least one strong identifier (email or phone) to resolve or create the customer is known",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_identifier" },
    },
  ],
  // Ambiguous 2+ matches are reconciled to an operator by the wrapped identity flow
  // (it returns needs_approval instead of auto-merging — CLAUDE.md rule #9); surfaced
  // as a recoverable stop so the loop escalates rather than guessing an identity.
  failureModes: ["no_crm_configured", "ambiguous_identity_needs_operator", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: true, escalate: "last_resort" },
  // Tenant HITL policy decides (floor "never"; overridable) — enforced by the
  // runtime's approvalGate, mapped to the governed semantic-create policy.
  approval: "configurable",
  dedupKey: ["customer"],
};

const ADD_NOTE: OperationContract = {
  id: "ADD_NOTE",
  capability: "CRM",
  effect: "write",
  meaning: "record a note about this customer on their CRM timeline",
  params: [
    { key: "contact_id", meaning: "the CRM contact the note belongs to (from resolving the customer first)", required: true },
    { key: "note", meaning: "the note text to record", required: true },
  ],
  outcome: "a note recorded on the customer's CRM timeline",
  success: { id: "note_recorded", statement: "the note now exists on the customer's CRM timeline" },
  invariants: [
    {
      id: "contact_known",
      statement: "the CRM contact to attach the note to is known (the customer was resolved first)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      // No satisferOperation: resolving identity is a WRITE (UPSERT_CUSTOMER); the
      // runtime must never auto-run a write to satisfy a precondition. The Reasoner
      // sequences UPSERT_CUSTOMER before ADD_NOTE; absent a contact, we ask.
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_id" },
    },
    {
      id: "note_body_present",
      statement: "there is note text to record",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "note" },
    },
  ],
  failureModes: ["no_crm_configured", "contact_not_found", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: false, escalate: "last_resort" },
  // Tenant HITL policy decides (floor "never"; overridable via TenantToolPermission).
  approval: "configurable",
};

const GET_CUSTOMER_CONTEXT: OperationContract = {
  id: "GET_CUSTOMER_CONTEXT",
  capability: "CRM",
  effect: "read",
  meaning: "pull up everything the CRM knows about this customer — recent activity, open deals, open tickets",
  params: [
    { key: "contact_id", meaning: "the CRM contact to hydrate (from resolving the customer first)", required: true },
  ],
  outcome: "the customer's CRM context: profile, recent activity, open deals, open tickets",
  success: { id: "customer_context_established", statement: "the customer's CRM context has been read" },
  invariants: [
    {
      id: "contact_known",
      statement: "the CRM contact to read is known (the customer was resolved first)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_id" },
    },
  ],
  failureModes: ["no_crm_configured", "contact_not_found", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: false, escalate: "never" },
  approval: "none",
};

const UPDATE_RECORD: OperationContract = {
  id: "UPDATE_RECORD",
  capability: "CRM",
  effect: "write",
  meaning: "update specific fields on this customer's CRM record — write ONLY what changed, never wipe fields that weren't discussed",
  params: [
    { key: "contact_id", meaning: "the CRM record to update (from resolving the customer first)", required: true },
    { key: "fields", meaning: "ONLY the fields to change, as key→value (sparse patch)", required: true },
  ],
  outcome: "the provided fields updated on the customer's CRM record; everything else untouched",
  success: { id: "record_updated", statement: "the provided fields now hold the new values on the record" },
  invariants: [
    {
      id: "contact_known",
      statement: "the CRM record to update is known (the customer was resolved first)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_id" },
    },
    {
      id: "fields_present",
      statement: "there is at least one concrete field to change",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "fields" },
    },
  ],
  failureModes: ["no_crm_configured", "vendor_does_not_support_update", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: false, escalate: "last_resort" },
  approval: "configurable",
};

const CREATE_TASK: OperationContract = {
  id: "CREATE_TASK",
  capability: "CRM",
  effect: "write",
  meaning: "create a follow-up task on this customer's CRM record for the human team",
  params: [
    { key: "contact_id", meaning: "the CRM contact the task belongs to (from resolving the customer first)", required: true },
    { key: "subject", meaning: "one-line task subject", required: true },
    { key: "body", meaning: "task details", required: false },
    { key: "due_at", meaning: "when the task is due (ISO time)", required: false },
  ],
  outcome: "a task on the customer's CRM record, visible to the human team",
  success: { id: "task_created", statement: "the task now exists on the customer's CRM record" },
  invariants: [
    {
      id: "contact_known",
      statement: "the CRM contact to attach the task to is known (the customer was resolved first)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "contact_id" },
    },
    {
      id: "subject_present",
      statement: "the task has a subject",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "subject" },
    },
  ],
  failureModes: ["no_crm_configured", "vendor_does_not_support_tasks", "vendor_unavailable"],
  recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: false, escalate: "never" },
  approval: "configurable",
};

export const CRM_CONTRACTS: Record<string, OperationContract> = {
  SEARCH_CUSTOMER,
  UPSERT_CUSTOMER,
  ADD_NOTE,
  GET_CUSTOMER_CONTEXT,
  UPDATE_RECORD,
  CREATE_TASK,
};
