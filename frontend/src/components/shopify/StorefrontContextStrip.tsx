"use client";

import { useMemo } from "react";
import { useI18n } from "@/context/I18nContext";

/**
 * Where the shopper is standing, shown to the agent.
 *
 * Answering "is this in stock?" is impossible without knowing what "this"
 * is, and the shopper will not say. This strip carries the page context
 * that rode in on their last message, so an agent picking up from the AI
 * has the same footing the AI had.
 *
 * Only structural facts appear here. Cart CONTENTS and shopper identity
 * are never in the payload to begin with, so there is nothing sensitive
 * to leak into an agent's screenshot.
 */

interface Props {
  channel?: string;
  messages: Array<{ direction: string; metadata?: any }>;
  shopDomain?: string | null;
}

export function StorefrontContextStrip({ channel, messages, shopDomain }: Props) {
  const { t } = useI18n();

  const context = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.direction !== "INBOUND") continue;
      const s = m.metadata?.storefront;
      if (s && typeof s === "object") return s;
    }
    return null;
  }, [messages]);

  if (channel !== "SHOPIFY_LIVE_CHAT" || !context) return null;

  const parts: string[] = [];
  if (shopDomain) parts.push(shopDomain);
  if (context.pageType) parts.push(t(`shopifyChat.page.${context.pageType}`));
  if (context.productHandle) parts.push(context.productHandle);
  else if (context.collectionHandle) parts.push(context.collectionHandle);
  if (typeof context.cartItemCount === "number" && context.cartItemCount > 0) {
    parts.push(t("shopifyChat.cartItems").replace("{count}", String(context.cartItemCount)));
  }

  if (!parts.length) return null;

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50/60 border-b border-emerald-100 text-[11px] text-emerald-900">
      <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8h12l-1 12H7L6 8Z" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      </svg>
      <span className="truncate">{parts.join(" · ")}</span>
    </div>
  );
}
