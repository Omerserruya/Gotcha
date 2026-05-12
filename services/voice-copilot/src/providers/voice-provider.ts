/**
 * VoiceProvider — provider-agnostic interface for the voice copilot's
 * outbound/inbound call orchestration.
 *
 * Each tenant's voice traffic is resolved per-call from their
 * `CommunicationChannel` + `VoiceChannel` row. There is no shared/env
 * fallback: a tenant without an ACTIVE voice channel is not callable.
 *
 * `authType` is BYO-only — tenants supply their own Twilio credentials
 * which are AES-256-GCM encrypted in `encryptedSecrets`.
 */

export type VoiceProviderSlug = "twilio";
export type VoiceAuthType = "BYO";

export interface ClientAccessToken {
  /** Provider-issued JWT for the browser SDK. */
  token: string;
  /** Provider-side identity assigned to the agent's client. */
  identity: string;
  /** TTL in seconds. */
  expiresIn: number;
}

export interface OutboundConferenceTwimlInput {
  conferenceName: string;
  statusCallbackUrl: string;
  /** Seconds to ring before giving up. */
  timeoutSeconds?: number;
}

export interface DialConferenceParticipantInput {
  conferenceSid: string;
  /** E.164 caller ID. */
  from: string;
  /** E.164 destination. */
  to: string;
  /** Provider participant label (also surfaced on callback events). */
  label: string;
  endConferenceOnExit?: boolean;
}

export interface AttachMediaStreamInput {
  callSid: string;
  streamUrl: string;
  track?: "inbound_track" | "outbound_track" | "both_tracks";
  parameters?: Record<string, string>;
}

export interface ValidateInboundSignatureInput {
  signature: string | undefined;
  /** Candidate URLs to validate against (TLS-terminator workaround). */
  candidateUrls: string[];
  /** Form params for HTTP webhooks; omit for WebSocket upgrades. */
  formParams?: Record<string, string>;
}

export interface VoiceProvider {
  readonly slug: VoiceProviderSlug;
  readonly authType: VoiceAuthType;

  /** True when this provider has enough credentials to mint a client token. */
  readonly isClientConfigured: boolean;

  /** Configured outbound caller ID, or null if not configured. */
  readonly callerId: string | null;

  /** Mint a short-lived voice access token for the agent's browser SDK. */
  mintClientAccessToken(input: {
    agentIdentity: string;
    ttlSeconds?: number;
  }): ClientAccessToken;

  /** Validate a provider-signed inbound HTTP or WS request. */
  validateInboundSignature(input: ValidateInboundSignatureInput): boolean;

  /** Render the outbound TwiML/instruction for the agent's leg. */
  generateOutboundConferenceTwiml(input: OutboundConferenceTwimlInput): string;

  /** Render a minimal "say + hangup" error response. */
  generateErrorTwiml(sayText: string): string;

  /** Add a second leg to an in-progress conference (e.g. dial the customer). */
  dialConferenceParticipant(input: DialConferenceParticipantInput): Promise<void>;

  /** Attach a bidirectional media stream to a call leg for transcription. */
  attachMediaStreamToCall(input: AttachMediaStreamInput): Promise<void>;
}

/**
 * Resolves the active VoiceProvider for a tenant. Throws
 * `NoActiveVoiceChannelError` when the tenant has no ACTIVE voice channel.
 */
export type VoiceProviderResolver = (tenantId: string) => Promise<VoiceProvider>;
