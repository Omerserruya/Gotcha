"use client";

/**
 * The selected integration's header.
 *
 * Deliberately NOT a card. The previous version wrapped this in a bordered,
 * shadowed panel, which pushed the tools - the actual content - below the fold
 * and made the summary look more important than the thing it summarises. This
 * sits directly on the page background and takes about a third of the height.
 */

import clsx from "clsx";
import { IntegrationLogo } from "./IntegrationLogo";

export interface IntegrationHeaderProps {
  slug: string;
  name: string;
  category?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  internal: boolean;
  connected?: boolean;
  missingScopes?: string[];
  capabilityFresh?: boolean;
  enabled: number;
  total: number;
  he: boolean;
  onDisconnect?: () => void;
  onConnect?: () => void;
}

/** DB enum ("PROJECT_MANAGEMENT") to something a person would say. */
function prettyCategory(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.toLowerCase().split(/[_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function IntegrationHeader({
  slug, name, category, description, logoUrl, internal, connected,
  missingScopes, capabilityFresh, enabled, total, he, onDisconnect, onConnect,
}: IntegrationHeaderProps) {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const cat = prettyCategory(internal ? "SYSTEM" : category);
  const missing = missingScopes ?? [];

  return (
    <header className="mb-4" data-testid="integration-header">
      <div className="flex items-start gap-3">
        <IntegrationLogo slug={slug} name={name} logoUrl={logoUrl} size={34} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[17px] font-semibold leading-tight text-gray-900 dark:text-white">{name}</h1>
            {cat && (
              <span
                data-testid="integration-category"
                className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              >
                {cat}
              </span>
            )}
            {/* Only surfaced when it differs from "healthy and connected". */}
            {!internal && connected === false && (
              <span data-testid="header-disconnected" className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-600">
                {L("Disconnected", "מנותק")}
              </span>
            )}
            {missing.length > 0 && (
              <span data-testid="header-missing-scopes" className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700">
                {L("Missing permissions", "חסרות הרשאות")}: {missing.join(", ")}
              </span>
            )}
            {capabilityFresh === false && (
              <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10.5px] text-gray-500">
                {L("Permission check is stale", "בדיקת ההרשאות לא עדכנית")}
              </span>
            )}
          </div>

          {description && (
            <p className="mt-0.5 text-[12px] leading-snug text-gray-500 dark:text-gray-400">{description}</p>
          )}
        </div>

        {/* GOTCHA is the platform itself - there is nothing to disconnect. */}
        {!internal && connected && onDisconnect && (
          <button
            type="button"
            data-testid="integration-disconnect"
            onClick={onDisconnect}
            className="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11.5px] font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
          >
            {L("Disconnect", "ניתוק")}
          </button>
        )}
        {!internal && connected === false && onConnect && (
          <button
            type="button"
            data-testid="integration-reconnect"
            onClick={onConnect}
            className="shrink-0 rounded-lg bg-primary-500 px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-primary-600"
          >
            {L("Reconnect", "חיבור מחדש")}
          </button>
        )}
      </div>

      {/* Tool-permission intro. The count lives on the same line as the
          explanation, exactly where the reader is already looking. */}
      <div className="mt-4">
        <h2 className="text-[13.5px] font-semibold text-gray-800 dark:text-gray-100">
          {L("Tool permissions", "הרשאות כלים")}
        </h2>
        <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">
          {L("Choose when your AI team is allowed to use these tools.", "בחרו מתי צוות ה-AI רשאי להשתמש בכלים האלה.")}{" "}
          <span data-testid="header-tool-count" className={clsx("font-medium text-gray-600 tabular-nums dark:text-gray-300")}>
            {L(`${enabled} of ${total} enabled`, `${enabled} מתוך ${total} מופעלים`)}
          </span>
        </p>
      </div>
    </header>
  );
}

export default IntegrationHeader;
