"use client";

import { useI18n } from "@/context/I18nContext";
import { Locale, localeConfig } from "@/i18n";

export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="bg-white/20 backdrop-blur text-sm rounded-lg px-3 py-1.5 border border-white/30 text-white focus:outline-none focus:ring-2 focus:ring-white/50 cursor-pointer"
    >
      {Object.entries(localeConfig).map(([key, config]) => (
        <option key={key} value={key} className="text-gray-900">
          {config.label}
        </option>
      ))}
    </select>
  );
}
