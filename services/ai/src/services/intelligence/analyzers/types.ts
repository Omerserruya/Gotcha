import type { ConversationStateFrame } from "@chatcenter/shared";

/**
 * Context passed to every analyzer in the intelligence engine.
 *
 * Created by the runner per analysis turn and held immutable for that turn.
 * Analyzers consume only the fields they need.
 *
 * Phase 1: `memory`, `org`, `crm`, and `llm` are typed as `unknown` because
 * their concrete shapes land in Phase 3 alongside the first analyzer
 * implementations and ConversationMemory. Locking the context shape now
 * prevents drift; the unknown fields are tightened as Phase 3 lands.
 */
export interface AnalysisContext {
  conversationId: string;
  tenantId: string;
  agentId?: string;
  customerId?: string;
  playbookId?: string;
  memory: unknown;
  org: unknown;
  crm: unknown;
  llm: unknown;
  emit: (frame: Partial<ConversationStateFrame>) => void;
}

/**
 * Single shape every analyzer primitive implements.
 *
 * The `cadence` field is read by the runner to decide WHEN to invoke the
 * analyzer. Analyzers never branch on `mode` themselves - that would be the
 * "two stacks" duplication this architecture is designed to prevent.
 */
export interface TranscriptAnalyzer<TInput, TOutput> {
  readonly name: string;
  readonly mode: "live" | "qa" | "async";
  readonly cadence: "perUtterance" | "debounced" | "perWindow" | "onFinal";
  analyze(
    ctx: AnalysisContext,
    input: TInput,
  ): Promise<TOutput> | AsyncIterable<TOutput>;
}
