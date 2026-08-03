/**
 * The `error_code` vocabulary every Sentry alert filters on.
 *
 * Alert rules must match something stable. Matching on an exception MESSAGE is
 * how alerting rots: someone rewords a string, the rule silently stops firing,
 * and the first anyone knows is the incident it was meant to catch. So every
 * alert-worthy failure carries an `error_code` tag from this list, and the tag
 * is the contract - the message can change freely.
 *
 * Codes are deliberately coarse. One code per THING SOMEONE DOES ABOUT IT, not
 * one per throw site: `action_provider_failed` and `action_persistence_failed`
 * are separate because the response differs (retry vs investigate data loss),
 * while a dozen provider-specific errors share one code because the response is
 * identical.
 *
 * Usage:
 *   captureError(err, { error_code: ERROR_CODES.action_provider_failed, provider: "shopify" })
 *
 * Tag values must stay LOW cardinality - a tenant id or a message id here turns
 * the Sentry tag index into a unique-value list and makes the alert useless.
 */
export const ERROR_CODES = {
  // ── Security: #gotcha-security ────────────────────────────────────────────
  /** A tenant boundary or permission check produced an impossible result. */
  authorization_invariant_broken: "authorization_invariant_broken",
  /** Data for tenant A was reachable from tenant B's context. */
  cross_tenant_exposure: "cross_tenant_exposure",
  /** An irreversible action ran twice for the same idempotency key. */
  irreversible_duplicate_execution: "irreversible_duplicate_execution",
  /** An approved HITL payload does not match what was presented for approval. */
  hitl_payload_mismatch: "hitl_payload_mismatch",
  /** A provider webhook failed signature verification. */
  webhook_signature_invalid: "webhook_signature_invalid",

  // ── AI / action execution: #gotcha-ai-ops ─────────────────────────────────
  /** An approved HITL action failed at execution time. */
  hitl_execution_failed: "hitl_execution_failed",
  /** The action kernel could not complete a tool execution. */
  action_execution_failed: "action_execution_failed",
  /** The downstream provider rejected or errored on the action. */
  action_provider_failed: "action_provider_failed",
  /** The action ran but its outcome could not be persisted. */
  action_persistence_failed: "action_persistence_failed",
  /** The action completed but the user was never notified. */
  action_notification_failed: "action_notification_failed",
  /** An LLM provider returned an error, timeout or rate limit. */
  ai_provider_degraded: "ai_provider_degraded",

  // ── Operational: #gotcha-prod-alerts ──────────────────────────────────────
  /** An OAuth or integration connect/refresh flow failed. */
  oauth_integration_failed: "oauth_integration_failed",
  /** An inbound webhook could not be processed after retries. */
  webhook_processing_failed: "webhook_processing_failed",
  /** A billing charge, invoice or entitlement operation failed. */
  billing_failed: "billing_failed",
  /** A call, media stream or TwiML operation failed. */
  voice_failed: "voice_failed",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Which Slack channel an alert on this code routes to. Documentation as data. */
export const CODE_CHANNEL: Record<ErrorCode, "#gotcha-security" | "#gotcha-ai-ops" | "#gotcha-prod-alerts"> = {
  authorization_invariant_broken: "#gotcha-security",
  cross_tenant_exposure: "#gotcha-security",
  irreversible_duplicate_execution: "#gotcha-security",
  hitl_payload_mismatch: "#gotcha-security",
  webhook_signature_invalid: "#gotcha-security",

  hitl_execution_failed: "#gotcha-ai-ops",
  action_execution_failed: "#gotcha-ai-ops",
  action_provider_failed: "#gotcha-ai-ops",
  action_persistence_failed: "#gotcha-ai-ops",
  action_notification_failed: "#gotcha-ai-ops",
  ai_provider_degraded: "#gotcha-ai-ops",

  oauth_integration_failed: "#gotcha-prod-alerts",
  webhook_processing_failed: "#gotcha-prod-alerts",
  billing_failed: "#gotcha-prod-alerts",
  voice_failed: "#gotcha-prod-alerts",
};
