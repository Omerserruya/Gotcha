"use client";

/**
 * Why a tool cannot run - which is NEVER the same thing as the admin choosing
 * to switch it off.
 *
 * Each reason points at a different screen, so reporting the wrong one wastes
 * the reader's time: an unentitled plan cannot be fixed by reconnecting, a
 * disconnected integration cannot be fixed by granting a scope, and a missing
 * scope cannot be fixed by touching the control on this row.
 */

import type { ToolAvailability } from "@/lib/tool-availability-client";

export function availabilityReasonText(a: ToolAvailability, he: boolean): string | null {
  switch (a.reason) {
    case "plan_not_entitled":
      return he ? "לא נכלל בתוכנית שלכם" : "Not included in your plan";
    case "integration_disconnected":
      return he ? "האינטגרציה מנותקת" : "Integration disconnected";
    case "missing_scope":
      return he
        ? `חסרות הרשאות אצל הספק: ${a.missingScopes.join(", ")}`
        : `Missing provider permissions: ${a.missingScopes.join(", ")}`;
    case "no_catalog_entry":
      return he ? "הכלי לא רשום בקטלוג" : "Not registered in the catalog";
    case "ok":
    default:
      // "ok" means the state really IS the admin's choice, so there is no
      // reason to show. Returning a string here would relabel a deliberate
      // Disabled as though the platform had blocked it.
      return null;
  }
}

export function ToolAvailabilityReason({ availability, he }: { availability: ToolAvailability; he: boolean }) {
  const text = availabilityReasonText(availability, he);
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-600 dark:text-amber-500">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {text}
    </span>
  );
}

export default ToolAvailabilityReason;
