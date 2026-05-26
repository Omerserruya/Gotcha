/**
 * AIWorker — top-level orchestration class for a single session.
 *
 * This is the call-site entry point that replaces:
 *   - LivePromptAssembler.build()
 *   - buildAgentPrompt(opts)
 *
 * Lifecycle:
 *   const worker = AIWorker.open({ sessionId, config, profile });
 *   const result = await worker.generate({ turnMessages });
 *   ... // many calls within the same session reuse the cached session
 *   worker.close();
 *
 * `open()` is idempotent — calling it twice with the same sessionId
 * returns the SAME WorkerSession via the registry. This is what guarantees
 * the prefix bytes don't drift across turns within a session.
 *
 * Phase 5 ships this class behind a feature flag. Phase 6 deletes the
 * legacy assemblers once every call site is flipped.
 */

import type {
  AIWorkerConfig,
  AIWorkerMode,
  AIWorkerSessionProfile,
} from "@chatcenter/shared";
import {
  getOrCreateSession,
  verifySessionFingerprint,
  releaseSession,
  type WorkerSession,
} from "./session-registry";
import { decideToolPolicy, type ToolPolicyDecision } from "./tools/policy";
import {
  generateResponse,
  streamResponse,
  type AIRequestParams,
  type AIResponse,
  type AIStreamEvent,
} from "../services/ai.service";

export interface OpenWorkerArgs {
  sessionId: string;
  config: AIWorkerConfig;
  mode?: AIWorkerMode;
  profile: AIWorkerSessionProfile;
  locale?: string;
  /**
   * Tenant-level tool overrides loaded by the call site. Empty/undefined
   * means "no allowlist — every skill-granted tool is offered".
   */
  tenantAllowlist?: string[];
  tenantDenylist?: string[];
}

export interface GenerateArgs {
  /**
   * The dynamic part of the conversation — everything that changes turn
   * to turn. Appended AFTER the cached prefix. Typically:
   *   - prior user/assistant/tool messages from the conversation
   *   - the latest user turn at the tail
   * The worker does NOT order or filter these — pass them in the order
   * they should appear to OpenAI.
   */
  turnMessages: AIRequestParams["messages"];
  /** Token cap for the assistant reply. */
  maxTokens?: number;
  /** Override worker default temperature. */
  temperature?: number;
  /** OpenAI tool schemas (full function definitions, not just names). */
  toolSchemas?: AIRequestParams["tools"];
  responseFormat?: AIRequestParams["responseFormat"];
  signal?: AbortSignal;
  /** Optional metadata extension for usage logging. */
  metadata?: AIRequestParams["metadata"];
}

export interface WorkerGenerationResult {
  response: AIResponse;
  session: WorkerSession;
  toolPolicy: ToolPolicyDecision;
}

export class AIWorker {
  private constructor(private readonly session: WorkerSession, private readonly toolPolicy: ToolPolicyDecision) {}

  static open(args: OpenWorkerArgs): AIWorker {
    const session = getOrCreateSession({
      sessionId: args.sessionId,
      worker: args.config,
      mode: args.mode,
      profile: args.profile,
      locale: args.locale,
    });
    const toolPolicy = decideToolPolicy({
      mode: session.mode,
      skillToolsAdded: session.skillToolsAdded,
      tenantAllowlist: args.tenantAllowlist,
      tenantDenylist: args.tenantDenylist,
    });
    return new AIWorker(session, toolPolicy);
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get fingerprintHash(): string {
    return this.session.fingerprint.hash;
  }

  get allowedTools(): string[] {
    return this.toolPolicy.allowed;
  }

  /**
   * Compose the OpenAI message array for a generation call.
   *
   * Structure: [system: SYSTEM_CORE, system: SESSION_PROFILE, ...turnMessages]
   * The first two messages are byte-identical across all calls in this
   * session — which is what makes OpenAI's prefix cache hit.
   */
  buildMessages(turnMessages: AIRequestParams["messages"]): AIRequestParams["messages"] {
    return [
      { role: "system", content: this.session.systemCore },
      { role: "system", content: this.session.sessionProfileText },
      ...turnMessages,
    ];
  }

  async generate(args: GenerateArgs): Promise<WorkerGenerationResult> {
    verifySessionFingerprint(this.session.sessionId);
    const messages = this.buildMessages(args.turnMessages);
    const response = await generateResponse({
      tenantId: this.session.worker.tenantId,
      sessionId: this.session.sessionId,
      messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      tools: args.toolSchemas,
      responseFormat: args.responseFormat,
      signal: args.signal,
      metadata: {
        ...(args.metadata ?? {}),
        conversationId: this.session.profile.conversationId,
        aiAgentId: this.session.worker.id,
        systemPromptHash: this.session.fingerprint.hash,
      },
    });
    return { response, session: this.session, toolPolicy: this.toolPolicy };
  }

  async *stream(args: GenerateArgs): AsyncGenerator<AIStreamEvent, void, void> {
    verifySessionFingerprint(this.session.sessionId);
    const messages = this.buildMessages(args.turnMessages);
    yield* streamResponse({
      tenantId: this.session.worker.tenantId,
      sessionId: this.session.sessionId,
      messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      tools: args.toolSchemas,
      responseFormat: args.responseFormat,
      signal: args.signal,
      metadata: {
        ...(args.metadata ?? {}),
        conversationId: this.session.profile.conversationId,
        aiAgentId: this.session.worker.id,
        systemPromptHash: this.session.fingerprint.hash,
      },
    });
  }

  /**
   * Release the session entry. Call this when the conversation/call
   * ends so the registry stays small. Safe to call multiple times.
   */
  close(): void {
    releaseSession(this.session.sessionId);
  }
}
