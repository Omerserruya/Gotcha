"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useAuth, type Membership } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";

/**
 * Post-login workspace picker.
 *
 * Shown (full-screen, instead of the app) when the signed-in identity holds
 * more than one tenant membership and no workspace has been chosen yet. The
 * chosen tenant is remembered (localStorage + server-side last-used stamp),
 * so this screen appears once - after that, login drops straight into the
 * last workspace and switching happens from the sidebar switcher.
 */

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  AGENT: "Agent",
  SYSTEM_ADMIN: "System admin",
};

function timeAgo(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale === "he" ? "he" : "en", { numeric: "auto" });
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return rtf.format(-Math.floor(days / 30), "month");
}

/** Deterministic accent per tenant so each workspace card is recognizable. */
const AVATAR_GRADIENTS = [
  "from-primary-400 to-primary-600",
  "from-violet-400 to-violet-600",
  "from-emerald-400 to-emerald-600",
  "from-amber-400 to-amber-600",
  "from-rose-400 to-rose-600",
  "from-sky-400 to-sky-600",
];
function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

export function TenantPicker() {
  const { memberships, switchTenant, logout, user } = useAuth();
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memberships;
    return memberships.filter((m) => m.tenant.name.toLowerCase().includes(q));
  }, [memberships, query]);

  const pick = async (m: Membership) => {
    if (switchingTo) return;
    setSwitchingTo(m.tenant.id);
    try {
      await switchTenant(m.tenant.id);
    } catch {
      setSwitchingTo(null);
    }
  };

  return (
    <div className="min-h-screen app-bg flex flex-col items-center justify-center p-4">
      <div className="app-bg-spots" />
      <div className="relative z-10 w-full max-w-lg">
        <div className="flex flex-col items-center mb-8">
          <Image src="/apple-touch-icon.png" alt="GOTCHA" width={48} height={48} className="w-12 h-12 mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900">
            {t("tenant.pickerTitle") || "Choose a workspace"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {(t("tenant.pickerSubtitle") || "{name}, you're a member of several workspaces").replace(
              "{name}",
              user?.name?.split(" ")[0] || "",
            )}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-float p-3">
          {memberships.length > 6 && (
            <div className="p-2 pb-3">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("tenant.searchPlaceholder") || "Search workspaces..."}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              />
            </div>
          )}

          <div className="max-h-[50vh] overflow-y-auto space-y-1">
            {filtered.map((m) => {
              const last = timeAgo(m.lastActiveAt, locale);
              const busy = switchingTo === m.tenant.id;
              return (
                <button
                  key={m.tenant.id}
                  onClick={() => void pick(m)}
                  disabled={!!switchingTo}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-primary-50/60 transition text-start disabled:opacity-60"
                >
                  <div
                    className={`w-11 h-11 rounded-xl bg-gradient-to-br ${gradientFor(m.tenant.id)} flex items-center justify-center text-white font-bold text-lg shrink-0 shadow-sm`}
                  >
                    {m.tenant.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{m.tenant.name}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {t(`tenant.role.${m.role}`) || ROLE_LABELS[m.role] || m.role}
                      {last ? ` · ${(t("tenant.lastUsed") || "last used {when}").replace("{when}", last)}` : ""}
                    </p>
                  </div>
                  {busy ? (
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-primary-500 rounded-full animate-spin shrink-0" />
                  ) : (
                    <svg className="w-4 h-4 text-gray-300 shrink-0 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-center text-sm text-gray-400 py-8">
                {t("tenant.noResults") || "No workspace matches your search"}
              </p>
            )}
          </div>
        </div>

        <button
          onClick={logout}
          className="mt-6 mx-auto block text-sm text-gray-400 hover:text-gray-600 transition"
        >
          {t("tenant.signOut") || t("nav.logout") || "Sign out"}
        </button>
      </div>
    </div>
  );
}
