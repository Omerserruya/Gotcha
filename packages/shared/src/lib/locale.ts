/**
 * System-language resolver.
 *
 * Precedence:
 *   1. user.locale            (per-agent override; null = no override)
 *   2. tenant.defaultLocale   (org-wide default)
 *   3. SYSTEM_FALLBACK_LOCALE ("en")
 *
 * Surfaces that consume this:
 *   • UI strings — frontend reads the effective locale at boot
 *   • AI generators — customer brief, conversation aiSummary, voice
 *     copilot insights, post-call QA, CRM notes
 *
 * Surfaces that explicitly DO NOT consume this:
 *   • Suggested-reply drafts — use Conversation.detectedLocale so the
 *     draft matches the customer's language regardless of what the
 *     agent set in Settings.
 */

import { prisma } from "./prisma";

export type SupportedLocale = "en" | "he";
export const SUPPORTED_LOCALES: ReadonlyArray<SupportedLocale> = ["en", "he"];
export const SYSTEM_FALLBACK_LOCALE: SupportedLocale = "en";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

/** Normalize anything to a supported locale; unknown values collapse to the fallback. */
export function coerceLocale(value: unknown): SupportedLocale {
  if (typeof value === "string") {
    const head = value.toLowerCase().slice(0, 2);
    if (isSupportedLocale(head)) return head;
  }
  return SYSTEM_FALLBACK_LOCALE;
}

export interface ResolvedLocale {
  effective: SupportedLocale;
  tenantDefault: SupportedLocale;
  userOverride: SupportedLocale | null;
}

/**
 * Resolve the effective locale for a given (tenant, optional user). One
 * round-trip — selects only the locale columns. Safe to call inline from
 * request handlers; cheap enough that route-level caching isn't needed.
 */
export async function resolveEffectiveLocale(args: {
  tenantId: string;
  userId?: string | null;
}): Promise<ResolvedLocale> {
  const [tenant, user] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: args.tenantId },
      select: { defaultLocale: true },
    }),
    args.userId
      ? prisma.user.findUnique({
          where: { id: args.userId },
          select: { locale: true },
        })
      : Promise.resolve(null),
  ]);
  const tenantDefault = coerceLocale(tenant?.defaultLocale);
  const userOverride = user?.locale ? coerceLocale(user.locale) : null;
  const effective = userOverride ?? tenantDefault;
  return { effective, tenantDefault, userOverride };
}

/**
 * Conversation-side selection: when a generator should match the customer's
 * language (suggested replies, customer-facing drafts), prefer the detected
 * locale. Falls back to the system effective locale when detection hasn't
 * run yet (e.g. very first inbound, low-confidence heuristic).
 */
export async function resolveConversationLocale(args: {
  tenantId: string;
  conversationId: string;
  fallbackUserId?: string | null;
}): Promise<SupportedLocale> {
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { detectedLocale: true },
  });
  if (conv?.detectedLocale) {
    return coerceLocale(conv.detectedLocale);
  }
  const { effective } = await resolveEffectiveLocale({
    tenantId: args.tenantId,
    userId: args.fallbackUserId,
  });
  return effective;
}
