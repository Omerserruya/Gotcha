"use client";

// The volume adjustment bar.
//
// One implementation, two sizes: `compact` sits inside a plan column, `full`
// drives the detailed configurator. They share this file rather than being
// written twice, because two copies of a control that both move the same price
// is exactly how the two surfaces start disagreeing.
//
// The control is a native `<input type="range">` stepping between option
// INDEXES, kept transparent over a drawn track. That is deliberate: arrow keys,
// Home/End, page keys and touch dragging all come from the platform, and
// `aria-valuetext` reads the volume and its cost instead of "3 out of 4".
//
// Stepping by index also means a drag can only ever land on a volume the plan
// actually sells; there is no in-between value to price.

import type { PublicVolumeOption } from "@/lib/api-public-pricing";

interface Props {
  legend: string;
  /** "per business day" - shown on the reading, never twice. */
  hint: string;
  options: PublicVolumeOption[];
  value: string | null;
  onChange: (optionKey: string) => void;
  size?: "compact" | "full";
  t: (k: string) => string;
}

export function MilestoneBar({ legend, hint, options, value, onChange, size = "full", t }: Props) {
  if (options.length === 0) return null;

  const compact = size === "compact";
  const index = Math.max(0, options.findIndex((o) => o.key === value));
  const max = options.length - 1;
  const current = options[index];
  const pct = max > 0 ? (index / max) * 100 : 0;
  const free = current.additionalPrice.amount === "0.00";

  const cost = free
    ? t("pricing.included")
    : `+${current.additionalPrice.formatted} / ${t("pricing.month")}`;

  return (
    <fieldset className={compact ? "" : "max-w-xl"}>
      {/* The unit lives on the reading below, not here as well: stating "per
          business day" twice within one control reads as a mistake. */}
      <legend
        className={
          compact
            ? "mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400"
            : "mb-4 text-[14px] font-medium text-gray-900"
        }
      >
        {legend}
      </legend>

      {/* The current reading, stated before the control so the number is the
          headline and the bar is the way to change it. */}
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 ${
          compact ? "mb-2.5" : "mb-4"
        }`}
      >
        <p className="flex items-baseline gap-1.5">
          <span
            className={`font-semibold leading-none tracking-[-0.02em] tabular-nums text-gray-900 ${
              compact ? "text-[19px]" : "text-[26px]"
            }`}
            dir="ltr"
          >
            {current.dailyVolume}
          </span>
          <span className={compact ? "text-[11.5px] text-gray-500" : "text-[12.5px] text-gray-500"}>
            {hint}
          </span>
        </p>
        <p className={`tabular-nums text-gray-500 ${compact ? "text-[11.5px]" : "text-[12.5px]"}`} dir="ltr">
          <span className={free ? "" : "font-medium text-gray-900"}>{cost}</span>
          {!free && !compact && (
            <span className="text-gray-400">
              {" · "}+{current.additionalCredits.toLocaleString()} {t("pricing.creditsWord")}
            </span>
          )}
        </p>
      </div>

      {/* Forced LTR: a quantity ladder runs low to high left to right in Hebrew
          too, and mirroring it makes "more" point the wrong way. */}
      <div className="px-2.5" dir="ltr">
        <div className={`relative ${compact ? "h-5" : "h-6"}`}>
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-200" />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-900 transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />

          {options.map((o, i) => (
            <span
              key={o.key}
              aria-hidden="true"
              className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                i <= index ? "bg-white/70" : "bg-gray-300"
              }`}
              style={{ left: `${max > 0 ? (i / max) * 100 : 0}%` }}
            />
          ))}

          {/* The input comes FIRST so the thumb can be its `peer` and pick up
              :focus-visible. The thumb is what a sighted user sees, but the
              input is what actually holds focus, and it is transparent. */}
          <input
            type="range"
            min={0}
            max={max}
            step={1}
            value={index}
            onChange={(e) => onChange(options[Number(e.target.value)].key)}
            aria-label={legend}
            aria-valuetext={t("pricing.a11y.volumeValue")
              .replace("{volume}", String(current.dailyVolume))
              .replace("{hint}", hint)
              .replace("{cost}", cost)}
            className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          />

          <span
            aria-hidden="true"
            className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-gray-900 bg-white shadow-sm transition-[left] duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-400 peer-focus-visible:ring-offset-2 motion-reduce:transition-none ${
              compact ? "h-4 w-4 border-[2.5px]" : "h-5 w-5 border-[3px]"
            }`}
            style={{ left: `${pct}%` }}
          />
        </div>

        {/* Milestone labels. Clickable for a mouse, but hidden from assistive
            tech: the range input above is the one accessible control, and a
            second set of five buttons would only add noise to it. */}
        <div className={`relative ${compact ? "mt-1.5 h-4" : "mt-2.5 h-5"}`}>
          {options.map((o, i) => {
            const p = max > 0 ? (i / max) * 100 : 0;
            const align = i === 0 ? "translate-x-0" : i === max ? "-translate-x-full" : "-translate-x-1/2";
            return (
              <button
                key={o.key}
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => onChange(o.key)}
                className={`absolute top-0 ${align} rounded px-1 tabular-nums transition-colors duration-200 ${
                  compact ? "text-[10.5px]" : "text-[11.5px]"
                } ${i === index ? "font-semibold text-gray-900" : "text-gray-400 hover:text-gray-700"}`}
                style={{ left: `${p}%` }}
              >
                {o.dailyVolume}
              </button>
            );
          })}
        </div>
      </div>

      {!compact && <p className="mt-3 text-[11.5px] text-gray-400">{t("pricing.volumeHint")}</p>}
    </fieldset>
  );
}
