/**
 * Reasoner provider resolution - the single injection point that selects the
 * concrete reasoning engine. The platform code depends on `ReasonerProvider`
 * (from @chatcenter/shared); ONLY this file knows which vendor is wired.
 *
 * Add Claude / Gemini / DeepSeek / local by implementing `ReasonerProvider` in a
 * sibling file and registering it here - nothing above the boundary changes.
 */

import type { ReasonerProvider } from "@chatcenter/shared";
import { createOpenAIReasonerProvider } from "./openai-reasoner.provider";

let cached: ReasonerProvider | null = null;

/** The configured Reasoner provider (default: openai). Memoized per process. */
export function getReasonerProvider(): ReasonerProvider {
  if (cached) return cached;
  const which = (process.env.REASONER_PROVIDER || "openai").toLowerCase();
  switch (which) {
    case "openai":
    default:
      cached = createOpenAIReasonerProvider();
      break;
  }
  return cached;
}

/** Test/hot-swap seam. */
export function setReasonerProvider(p: ReasonerProvider | null): void {
  cached = p;
}

export { createOpenAIReasonerProvider } from "./openai-reasoner.provider";
