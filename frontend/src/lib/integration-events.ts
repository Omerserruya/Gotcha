"use client";

import { useEffect } from "react";

/**
 * "An integration's connection changed" - broadcast to every screen showing it.
 *
 * WHY THIS EXISTS
 * Disconnecting Shopify on the integration screen left the Business systems
 * strip and the customer-system-of-record card showing the pre-disconnect
 * answer: the old shop domain, Shopify as the active source of truth and its
 * capability chips green, on the same page as a card that already said
 * "Disconnected". Each component fetched once on mount and never heard about
 * the other, so only a full page reload agreed with the database.
 *
 * The backend was right throughout. This is about the screens catching up
 * without the merchant having to reload.
 */
const EVENT = "gotcha:integrations-changed";

/** Call after any connect, disconnect or election change. */
export function notifyIntegrationsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Re-run `onChange` whenever an integration's connection changes. */
export function useIntegrationsChanged(onChange: () => void): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = () => onChange();
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, [onChange]);
}
