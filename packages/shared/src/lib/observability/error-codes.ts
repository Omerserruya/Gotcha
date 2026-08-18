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
  // ── AI: #gotcha-ai-ops ────────────────────────────────────────────────────
  /** An LLM provider returned an error or was unreachable. */
  ai_provider_failure: "ai_provider_failure",
  /** An LLM call exceeded its deadline. */
  ai_timeout: "ai_timeout",
  /** An LLM provider rate-limited us. */
  ai_rate_limit: "ai_rate_limit",
  /** The model returned output that failed schema or parse validation. */
  ai_invalid_output: "ai_invalid_output",

  // ── HITL: #gotcha-ai-ops ──────────────────────────────────────────────────
  /** An approval request could not be created, so nobody can approve it. */
  hitl_request_creation_failed: "hitl_request_creation_failed",
  /** The approval exists but the approver was never told about it. */
  hitl_notification_failed: "hitl_notification_failed",
  /** An approval callback failed validation (bad token, unknown id, bad shape). */
  hitl_callback_invalid: "hitl_callback_invalid",
  /** An approval was acted on after it expired. */
  hitl_expired: "hitl_expired",
  /** An approval was acted on twice. */
  hitl_already_consumed: "hitl_already_consumed",

  // ── Integrations: #gotcha-prod-alerts ─────────────────────────────────────
  /** An OAuth start, callback or code exchange failed. */
  integration_oauth_failed: "integration_oauth_failed",
  /** A stored refresh token could not be exchanged for a new access token. */
  integration_token_refresh_failed: "integration_token_refresh_failed",
  /** Stored credentials were rejected by the provider. */
  integration_credentials_invalid: "integration_credentials_invalid",
  /** Provisioning a connected integration failed part-way. */
  integration_provisioning_failed: "integration_provisioning_failed",
  /** Disconnect ran but left provider-side state behind. */
  integration_disconnect_cleanup_failed: "integration_disconnect_cleanup_failed",

  // ── Webhooks: #gotcha-prod-alerts / #gotcha-security ──────────────────────
  /** A provider webhook failed signature verification. */
  webhook_signature_invalid: "webhook_signature_invalid",
  /** A webhook verification handshake failed (e.g. Meta hub.challenge). */
  webhook_verification_failed: "webhook_verification_failed",
  /** An inbound webhook could not be processed. */
  webhook_processing_failed: "webhook_processing_failed",

  // ── Attachment storage: #gotcha-prod-alerts ───────────────────────────────
  /**
   * Inbound media could not be written to the uploads volume.
   *
   * Almost always an ownership mismatch: the volume is root-owned and the
   * services run as `node`. Alert on the FIRST occurrence rather than on a
   * rate - unlike a signature mismatch, this is never background noise, and
   * every minute it lasts is a customer's attachments being lost permanently.
   */
  media_storage_unwritable: "media_storage_unwritable",

  // ── Billing: #gotcha-prod-alerts ──────────────────────────────────────────
  /** A payment provider callback could not be processed. */
  payment_callback_failed: "payment_callback_failed",
  /** A subscription could not be created or updated after payment. */
  subscription_update_failed: "subscription_update_failed",
  /** Entitlements could not be created, so a paying tenant has no access. */
  entitlement_creation_failed: "entitlement_creation_failed",

  // ── Voice: #gotcha-prod-alerts ────────────────────────────────────────────
  /** Provisioning a Twilio voice channel failed. */
  voice_provisioning_failed: "voice_provisioning_failed",
  /** Activating or deactivating a phone number's webhooks failed. */
  voice_number_activation_failed: "voice_number_activation_failed",
  /** TwiML generation or an inbound call handler failed. */
  voice_twiml_failed: "voice_twiml_failed",
  /** The Twilio media WebSocket failed to establish or dropped abnormally. */
  voice_media_stream_failed: "voice_media_stream_failed",
  /** Speech-to-text failed for a live call. */
  voice_transcription_failed: "voice_transcription_failed",

  // ── Security: #gotcha-security ────────────────────────────────────────────
  /** A tenant boundary or permission check produced an impossible result. */
  authorization_invariant_broken: "authorization_invariant_broken",
  /** Data for tenant A was reachable from tenant B's context. */
  cross_tenant_exposure: "cross_tenant_exposure",
  /** An irreversible action ran twice for the same idempotency key. */
  irreversible_duplicate_execution: "irreversible_duplicate_execution",
  /** An approved HITL payload does not match what was presented for approval. */
  hitl_payload_mismatch: "hitl_payload_mismatch",

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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Which Slack channel an alert on this code routes to. Documentation as data. */
export const CODE_CHANNEL: Record<ErrorCode, "#gotcha-security" | "#gotcha-ai-ops" | "#gotcha-prod-alerts"> = {
  ai_provider_failure: "#gotcha-ai-ops",
  ai_timeout: "#gotcha-ai-ops",
  ai_rate_limit: "#gotcha-ai-ops",
  ai_invalid_output: "#gotcha-ai-ops",

  hitl_request_creation_failed: "#gotcha-ai-ops",
  hitl_notification_failed: "#gotcha-ai-ops",
  hitl_callback_invalid: "#gotcha-security",
  hitl_expired: "#gotcha-ai-ops",
  hitl_already_consumed: "#gotcha-security",

  integration_oauth_failed: "#gotcha-prod-alerts",
  integration_token_refresh_failed: "#gotcha-prod-alerts",
  integration_credentials_invalid: "#gotcha-prod-alerts",
  integration_provisioning_failed: "#gotcha-prod-alerts",
  integration_disconnect_cleanup_failed: "#gotcha-prod-alerts",

  webhook_verification_failed: "#gotcha-prod-alerts",

  payment_callback_failed: "#gotcha-prod-alerts",
  subscription_update_failed: "#gotcha-prod-alerts",
  entitlement_creation_failed: "#gotcha-prod-alerts",

  voice_provisioning_failed: "#gotcha-prod-alerts",
  voice_number_activation_failed: "#gotcha-prod-alerts",
  voice_twiml_failed: "#gotcha-prod-alerts",
  voice_media_stream_failed: "#gotcha-prod-alerts",
  voice_transcription_failed: "#gotcha-prod-alerts",

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

  webhook_processing_failed: "#gotcha-prod-alerts",
  media_storage_unwritable: "#gotcha-prod-alerts",
};
