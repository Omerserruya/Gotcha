/**
 * TwilioProvider — concrete VoiceProvider backed by Twilio Voice.
 *
 * Per-tenant: every instance is built from decrypted DB credentials by
 * `resolve-provider.ts`. There is no env-credentialed shared instance —
 * a tenant without an ACTIVE voice channel is not callable.
 *
 * Methods that depend on a credential the channel didn't supply (e.g.
 * minting a browser token requires API Key SID/Secret + TwiML App SID)
 * throw a clear error instead of silently returning a half-broken token.
 */
import twilio from "twilio";
import type { Logger } from "../../lib/logger";
import { validateTwilioSignature } from "../../ws/twilio-frames";
import type {
  AttachMediaStreamInput,
  ClientAccessToken,
  DialConferenceParticipantInput,
  OutboundConferenceTwimlInput,
  ValidateInboundSignatureInput,
  VoiceAuthType,
  VoiceProvider,
} from "../voice-provider";

const VoiceResponse = twilio.twiml.VoiceResponse;

export interface TwilioProviderCredentials {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  callerId: string;
}

export interface TwilioProviderOptions {
  credentials: TwilioProviderCredentials;
  authType: VoiceAuthType;
  logger: Logger;
}

export class TwilioProvider implements VoiceProvider {
  readonly slug = "twilio" as const;
  readonly authType: VoiceAuthType;

  private readonly creds: TwilioProviderCredentials;
  private readonly logger: Logger;
  private _client: ReturnType<typeof twilio> | null = null;

  constructor(opts: TwilioProviderOptions) {
    this.creds = opts.credentials;
    this.authType = opts.authType;
    this.logger = opts.logger;
  }

  get isClientConfigured(): boolean {
    return Boolean(
      this.creds.accountSid &&
      this.creds.apiKeySid &&
      this.creds.apiKeySecret &&
      this.creds.twimlAppSid,
    );
  }

  get callerId(): string | null {
    return this.creds.callerId || null;
  }

  mintClientAccessToken(input: { agentIdentity: string; ttlSeconds?: number }): ClientAccessToken {
    if (!this.isClientConfigured) {
      throw new Error(
        "twilio_client_not_configured: minting access tokens requires accountSid, apiKeySid, apiKeySecret, twimlAppSid",
      );
    }
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const ttl = input.ttlSeconds ?? 3600;

    const token = new AccessToken(
      this.creds.accountSid,
      this.creds.apiKeySid,
      this.creds.apiKeySecret,
      { identity: input.agentIdentity, ttl },
    );
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: this.creds.twimlAppSid,
      incomingAllow: false,
    });
    token.addGrant(voiceGrant);

    return {
      token: token.toJwt(),
      identity: input.agentIdentity,
      expiresIn: ttl,
    };
  }

  validateInboundSignature(input: ValidateInboundSignatureInput): boolean {
    if (!this.creds.authToken) {
      // No auth token configured ⇒ refuse the signature. Previous behavior
      // was to short-circuit to `true` in dev; the new architecture has no
      // env fallback, so a missing token is a real configuration error.
      this.logger.warn("twilio-provider: validateInboundSignature called without authToken");
      return false;
    }
    const params = input.formParams;
    if (params === undefined) {
      // WebSocket-style: URL-only HMAC (validateTwilioSignature already does this).
      return input.candidateUrls.some((u) => validateTwilioSignature(input.signature, u, this.creds.authToken));
    }
    // HTTP form-encoded: defer to twilio.validateRequest which signs over params.
    return input.candidateUrls.some((u) =>
      twilio.validateRequest(this.creds.authToken, input.signature ?? "", u, params),
    );
  }

  generateOutboundConferenceTwiml(input: OutboundConferenceTwimlInput): string {
    if (!this.callerId) {
      throw new Error("twilio_caller_id_not_configured: no active phone number for this channel");
    }
    const resp = new VoiceResponse();
    const dial = resp.dial({ answerOnBridge: true, timeout: input.timeoutSeconds ?? 30 });
    dial.conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        beep: "false",
        waitUrl: "",
        statusCallback: input.statusCallbackUrl,
        statusCallbackEvent: ["start", "join", "leave", "end"],
        statusCallbackMethod: "POST",
      },
      input.conferenceName,
    );
    return resp.toString();
  }

  generateErrorTwiml(sayText: string): string {
    const resp = new VoiceResponse();
    resp.say(sayText);
    resp.hangup();
    return resp.toString();
  }

  async dialConferenceParticipant(input: DialConferenceParticipantInput): Promise<void> {
    const client = this.getClient();
    const params: Record<string, unknown> = {
      from: input.from,
      to: input.to,
      label: input.label,
      endConferenceOnExit: input.endConferenceOnExit ?? true,
    };
    if (input.statusCallbackUrl) {
      params.statusCallback = input.statusCallbackUrl;
      params.statusCallbackEvent = ["completed"];
      params.statusCallbackMethod = "POST";
    }
    const create = (client.conferences(input.conferenceSid).participants.create as unknown) as (p: Record<string, unknown>) => Promise<unknown>;
    await create(params);
  }

  async attachMediaStreamToCall(input: AttachMediaStreamInput): Promise<void> {
    const client = this.getClient();
    const params: Record<string, string> = {
      url: input.streamUrl,
      track: input.track ?? "inbound_track",
    };
    let i = 1;
    for (const [name, value] of Object.entries(input.parameters ?? {})) {
      params[`parameter${i}.name`] = name;
      params[`parameter${i}.value`] = value;
      i += 1;
    }
    // Twilio's typed SDK doesn't accept the parameterN.* form natively; the
    // call.streams.create REST param is a flat dict at the wire level.
    const create = (client.calls(input.callSid).streams.create as unknown) as (p: Record<string, string>) => Promise<unknown>;
    await create(params);
  }

  async endCall(input: { callSid: string }): Promise<void> {
    if (!input.callSid) return;
    const client = this.getClient();
    try {
      // Twilio: marking a call "completed" forces the provider side to hang
      // up immediately. If the call leg is already over (status=completed,
      // failed, no-answer, busy, canceled) Twilio returns a 4xx — swallow
      // it so the caller can treat endCall as idempotent.
      await client.calls(input.callSid).update({ status: "completed" });
      this.logger.info({ callSid: input.callSid }, "twilio-provider: endCall ok");
    } catch (err: any) {
      const code = err?.status ?? err?.code;
      if (code === 404 || code === 400 || code === 20404) {
        this.logger.warn({ callSid: input.callSid, code }, "twilio-provider: endCall noop (already finished)");
        return;
      }
      this.logger.error({ err, callSid: input.callSid }, "twilio-provider: endCall failed");
      throw err;
    }
  }

  private getClient() {
    if (!this._client) {
      if (!this.creds.accountSid || !this.creds.authToken) {
        throw new Error("twilio_rest_not_configured: accountSid + authToken required");
      }
      this._client = twilio(this.creds.accountSid, this.creds.authToken);
    }
    return this._client;
  }
}
