"use client";

/**
 * The shared tool-permission primitives every integration uses.
 *
 * Before this, each surface rendered its own switch, so "the plan does not
 * include this", "the provider scope was never granted" and "the admin turned
 * it off" all looked the same - an off toggle. The admin flipped it, nothing
 * happened, and the screen looked broken. Worse, they could believe a
 * capability was off by choice when it had never been available.
 *
 * The rules live in lib/tool-availability-client.ts (mirrored from
 * @chatcenter/shared with a parity test), so this file is presentation only.
 */

import clsx from "clsx";
import {
  type PermissionState,
  type RiskGroup,
  type ToolAvailability,
  type ToolCounts,
  mayBeAlwaysAllowed,
} from "@/lib/tool-availability-client";

// ─── Copy ───────────────────────────────────────────────────

const RISK_LABEL: Record<RiskGroup, { en: string; he: string }> = {
  read_only: { en: "Read only", he: "קריאה בלבד" },
  create_update: { en: "Create and update", he: "יצירה ועדכון" },
  delete: { en: "Delete", he: "מחיקה" },
  financial: { en: "Financial and irreversible", he: "כספי ובלתי הפיך" },
  sensitive_data: { en: "Sensitive customer data", he: "מידע רגיש של לקוחות" },
  administrative: { en: "Administrative", he: "ניהולי" },
};

const RISK_HINT: Record<RiskGroup, { en: string; he: string }> = {
  read_only: { en: "Looks things up. Safe to allow automatically.", he: "רק קורא מידע. בטוח לאשר אוטומטית." },
  create_update: { en: "Changes something. Worth requiring approval.", he: "משנה משהו. כדאי לדרוש אישור." },
  delete: { en: "Removes something. Hard to undo.", he: "מוחק משהו. קשה לשחזר." },
  financial: { en: "Moves money. Cannot be undone by the employee.", he: "מעביר כספים. העובד לא יכול לבטל." },
  sensitive_data: { en: "Writes to customer records.", he: "כותב לרשומות לקוחות." },
  administrative: { en: "Changes how the workspace itself works.", he: "משנה את אופן העבודה של הסביבה." },
};

const STATE_LABEL: Record<PermissionState, { en: string; he: string }> = {
  always_allow: { en: "Always allow", he: "מאושר תמיד" },
  require_approval: { en: "Require approval", he: "דורש אישור" },
  disabled: { en: "Disabled", he: "כבוי" },
  unavailable: { en: "Unavailable", he: "לא זמין" },
};

/**
 * The REAL reason, and what to do about it. Each one points at a different
 * screen, so reporting the wrong one wastes the admin's time.
 */
function unavailableCopy(a: ToolAvailability, he: boolean): { text: string; action?: string } {
  switch (a.reason) {
    case "plan_not_entitled":
      return {
        text: he ? "לא נכלל בתוכנית שלכם" : "Not included in your plan",
        action: he ? "שדרוג התוכנית" : "Upgrade plan",
      };
    case "integration_disconnected":
      return {
        text: he ? "האינטגרציה מנותקת" : "The integration is disconnected",
        action: he ? "חיבור מחדש" : "Reconnect",
      };
    case "missing_scope":
      return {
        text: he
          ? `חסרות הרשאות אצל הספק: ${a.missingScopes.join(", ")}`
          : `Missing provider permissions: ${a.missingScopes.join(", ")}`,
        action: he ? "אישור הרשאות" : "Grant access",
      };
    case "no_catalog_entry":
      return { text: he ? "הכלי לא רשום בקטלוג" : "This tool is not registered in the catalog" };
    default:
      return { text: he ? "לא זמין" : "Unavailable" };
  }
}

export function riskLabel(g: RiskGroup, he: boolean): string {
  return he ? RISK_LABEL[g].he : RISK_LABEL[g].en;
}
export function riskHint(g: RiskGroup, he: boolean): string {
  return he ? RISK_HINT[g].he : RISK_HINT[g].en;
}

// ─── Summary card ───────────────────────────────────────────

export function IntegrationToolSummary({
  name, category, description, logo, connected, counts, he, onReconnect,
}: {
  name: string;
  category?: string | null;
  description?: string | null;
  logo?: string | null;
  connected: boolean;
  counts: ToolCounts;
  he: boolean;
  onReconnect?: () => void;
}) {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm" data-testid="integration-summary">
      <div className="flex items-start gap-3">
        {logo ? (
          <img src={logo} alt="" className="w-10 h-10 rounded-xl object-contain shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-xl bg-gray-100 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{name}</h3>
            {category && (
              <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">{category}</span>
            )}
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                connected ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
              )}
              data-testid="integration-connection"
            >
              {connected ? L("Connected", "מחובר") : L("Disconnected", "מנותק")}
            </span>
          </div>
          {description && <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">{description}</p>}

          {/* The headline. `enabled` counts what can ACTUALLY run, so an
              unavailable tool is never counted here just because its stored
              preference says on. */}
          <p className="mt-2 text-xs font-medium text-gray-700 tabular-nums" data-testid="tool-count">
            {L(
              `${counts.enabled} of ${counts.total} tools enabled`,
              `${counts.enabled} מתוך ${counts.total} כלים מופעלים`,
            )}
          </p>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {counts.requireApproval > 0 && (
              <Chip tone="amber" testid="chip-approval">
                {L(`${counts.requireApproval} need approval`, `${counts.requireApproval} דורשים אישור`)}
              </Chip>
            )}
            {counts.disabled > 0 && (
              <Chip tone="gray" testid="chip-disabled">
                {L(`${counts.disabled} off`, `${counts.disabled} כבויים`)}
              </Chip>
            )}
            {/* Unavailable is called out separately from "off" on purpose. */}
            {counts.unavailable > 0 && (
              <Chip tone="rose" testid="chip-unavailable">
                {L(`${counts.unavailable} unavailable`, `${counts.unavailable} לא זמינים`)}
              </Chip>
            )}
          </div>

          {!connected && onReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              className="mt-2 text-xs font-medium text-violet-600 hover:text-violet-700"
            >
              {L("Reconnect", "חיבור מחדש")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ tone, children, testid }: { tone: "amber" | "gray" | "rose"; children: React.ReactNode; testid?: string }) {
  return (
    <span
      data-testid={testid}
      className={clsx(
        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
        tone === "amber" && "bg-amber-50 text-amber-700",
        tone === "gray" && "bg-gray-100 text-gray-600",
        tone === "rose" && "bg-rose-50 text-rose-700",
      )}
    >
      {children}
    </span>
  );
}

// ─── Group heading ──────────────────────────────────────────

export function RiskGroupHeading({ group, count, he }: { group: RiskGroup; count: number; he: boolean }) {
  return (
    <div className="flex items-baseline gap-2 pt-3 pb-1" data-testid={`risk-group-${group}`}>
      <h4 className="text-xs font-semibold text-gray-900">{riskLabel(group, he)}</h4>
      <span className="text-[10px] text-gray-400 tabular-nums">{count}</span>
      <span className="text-[10px] text-gray-400">{riskHint(group, he)}</span>
    </div>
  );
}

// ─── One tool row ───────────────────────────────────────────

export function ToolPermissionRow({
  displayName, rawName, description, requiredScopes, availability, he, saving, onChange, showRawName,
}: {
  /** Human, localized name. The raw identifier is admin-diagnostics only. */
  displayName: string;
  rawName: string;
  description?: string | null;
  requiredScopes?: string[];
  availability: ToolAvailability;
  he: boolean;
  saving?: boolean;
  onChange?: (next: Exclude<PermissionState, "unavailable">) => void;
  /** Admin diagnostics: reveal the raw adapter identifier. */
  showRawName?: boolean;
}) {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const isUnavailable = availability.state === "unavailable";
  const reason = isUnavailable ? unavailableCopy(availability, he) : null;
  const lockedFromAlwaysAllow = !mayBeAlwaysAllowed(availability.riskGroup);

  const OPTIONS: Array<Exclude<PermissionState, "unavailable">> = ["always_allow", "require_approval", "disabled"];

  return (
    <div
      className={clsx(
        "rounded-xl border p-3",
        isUnavailable ? "border-gray-100 bg-gray-50/60" : "border-gray-100 bg-white",
      )}
      data-testid={`tool-row-${rawName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={clsx("text-sm font-medium truncate", isUnavailable ? "text-gray-400" : "text-gray-900")}>
            {displayName}
          </p>
          {description && <p className="mt-0.5 text-[11px] text-gray-500 line-clamp-2">{description}</p>}
          {showRawName && (
            <p className="mt-0.5 font-mono text-[10px] text-gray-400" dir="ltr" data-testid={`raw-name-${rawName}`}>
              {rawName}
            </p>
          )}
          {requiredScopes && requiredScopes.length > 0 && (
            <p className="mt-0.5 text-[10px] text-gray-400" dir="ltr">
              {L("Needs", "דורש")}: {requiredScopes.join(", ")}
            </p>
          )}
        </div>

        {isUnavailable ? (
          // NOT rendered as an off switch: the admin's switch does not control
          // this, and pretending otherwise is the bug.
          <div className="shrink-0 text-end" data-testid={`unavailable-${rawName}`}>
            <span className="rounded-md bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-700">
              {he ? STATE_LABEL.unavailable.he : STATE_LABEL.unavailable.en}
            </span>
            <p className="mt-1 max-w-[220px] text-[10px] text-gray-500">{reason!.text}</p>
            {reason!.action && (
              <p className="mt-0.5 text-[10px] font-medium text-violet-600">{reason!.action}</p>
            )}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label={displayName}>
            {OPTIONS.map((opt) => {
              const active = availability.state === opt;
              const blocked = opt === "always_allow" && lockedFromAlwaysAllow;
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={saving || blocked}
                  title={
                    blocked
                      ? L(
                          "This action cannot be set to always allow, it is irreversible",
                          "לא ניתן לאשר את הפעולה הזו תמיד, היא בלתי הפיכה",
                        )
                      : undefined
                  }
                  onClick={() => onChange?.(opt)}
                  data-testid={`state-${opt}-${rawName}`}
                  className={clsx(
                    "rounded-md px-2 py-1 text-[10px] font-medium border transition",
                    active
                      ? opt === "always_allow"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : opt === "require_approval"
                          ? "bg-amber-50 text-amber-700 border-amber-300"
                          : "bg-gray-100 text-gray-600 border-gray-300"
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-300",
                    blocked && "opacity-40 cursor-not-allowed",
                  )}
                >
                  {he ? STATE_LABEL[opt].he : STATE_LABEL[opt].en}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ToolPermissionRow;
