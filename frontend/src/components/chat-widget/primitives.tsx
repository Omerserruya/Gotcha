"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { sanitizeMediaUrl, MEDIA_GUIDANCE } from "@/lib/shopify-chat-ux-client";

/**
 * The chat widget editor's building blocks.
 *
 * Lifted out of the Shopify channel's settings page so the website widget
 * is configured through the same controls rather than a smaller imitation
 * of them. Nothing here knows which channel it is editing - that was
 * already true of the markup, it was just living in a file named after
 * one channel.
 */

/**
 * A media URL input that validates against the SAME rule the storefront
 * applies, and explains a refusal in place.
 *
 * Without this the merchant pasted an http:// or .svg URL, saw the field
 * accept it, and found an empty hero on their live store with nothing to
 * explain it.
 */
export function MediaField({
  label, hint, slot, value, onChange, t,
}: {
  label: string;
  hint?: string;
  slot: "image" | "video";
  value: string | null;
  onChange: (v: string | null) => void;
  t: (k: string) => string;
}) {
  const [raw, setRaw] = useState(value ?? "");
  useEffect(() => { setRaw(value ?? ""); }, [value]);

  const verdict = useMemo(() => {
    if (!raw.trim()) return null;
    return sanitizeMediaUrl(raw, slot);
  }, [raw, slot]);
  const rejected = raw.trim().length > 0 && verdict === null;

  return (
    <Field
      label={label}
      hint={
        hint ??
        (slot === "video"
          ? t("shopifyChat.mediaHintVideo")
              .replace("{mb}", String(Math.round(MEDIA_GUIDANCE.videoMaxBytes / 1e6)))
              .replace("{secs}", String(MEDIA_GUIDANCE.videoMaxSeconds))
          : t("shopifyChat.mediaHintImage")
              .replace("{mb}", String((MEDIA_GUIDANCE.imageMaxBytes / 1e6).toFixed(1)))
              .replace("{w}", String(MEDIA_GUIDANCE.recommendedWidth))
              .replace("{h}", String(MEDIA_GUIDANCE.recommendedHeight)))
      }
    >
      <input
        type="url"
        value={raw}
        placeholder="https://"
        onChange={(e) => {
          setRaw(e.target.value);
          // Only a URL the storefront would actually accept reaches the
          // draft; a rejected one stays in the box with the reason next
          // to it, rather than being saved and silently dropped later.
          const next = e.target.value.trim();
          onChange(next ? sanitizeMediaUrl(next, slot) : null);
        }}
        className={clsx(
          "w-full text-sm px-3 py-2 border rounded-lg",
          rejected ? "border-red-300 bg-red-50" : "border-gray-200",
        )}
      />
      {rejected && (
        <p className="mt-1 text-xs text-red-600">{t("shopifyChat.mediaRejected")}</p>
      )}
      {!rejected && verdict && (
        <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
          {slot === "video" ? (
            <video src={verdict} className="h-24 w-full object-cover" muted playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={verdict} alt="" className="h-24 w-full object-cover" />
          )}
        </div>
      )}
    </Field>
  );
}

export function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-5 space-y-3.5">
      <div>
        <h2 className="font-semibold text-sm text-gray-900">{title}</h2>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

/**
 * Play the built-in tones so a merchant can hear what they are choosing.
 *
 * Synthesised with the same oscillator recipe the widget uses, so the
 * preview cannot drift from the storefront. A click is itself the user
 * gesture browsers require, so nothing has to be unlocked first.
 */

/**
 * Play the built-in tones so a merchant can hear what they are choosing.
 *
 * Synthesised with the same oscillator recipe the widget uses, so the
 * preview cannot drift from the storefront. A click is itself the user
 * gesture browsers require, so nothing has to be unlocked first.
 */
export function SoundPreview({ pack, volume, t }: { pack: string; volume: number; t: (k: string) => string }) {
  const TONES: Record<string, Record<string, [number, number]>> = {
    subtle: { outgoing: [520, 0.06], incoming_ai: [660, 0.09], incoming_human: [740, 0.09], proactive: [600, 0.1] },
    classic: { outgoing: [660, 0.07], incoming_ai: [880, 0.11], incoming_human: [990, 0.11], proactive: [780, 0.12] },
  };

  function play(event: string) {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const spec = (TONES[pack] ?? TONES.subtle)[event] ?? [660, 0.09];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = spec[0];
      const vol = Math.max(0, Math.min(1, volume / 100)) * 0.25;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + spec[1]);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + spec[1] + 0.02);
      setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch {
      /* a browser that will not make noise is not an error worth showing */
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {["outgoing", "incoming_ai", "incoming_human", "proactive"].map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => play(e)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
        >
          ▸ {t(`shopifyChat.sound.${e}`)}
        </button>
      ))}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium text-end">{value}</span>
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4"
      />
      <span className="min-w-0">
        <span className="block text-sm text-gray-900">{label}</span>
        {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </span>
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg bg-white"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-10 h-9 rounded-lg border border-gray-200"
        aria-label={value}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono"
      />
    </div>
  );
}
