"use client";

// Shared pricing primitives.
//
// The visual brief was "mature enterprise software", which in practice means
// restraint: one accent colour used sparingly, fine 1px rules instead of
// borders on everything, generous whitespace, tabular figures so columns of
// numbers line up, and no decoration that does not carry information.
//
// Deliberately absent: gradients, glows, sparkles, glassmorphism, pulsing
// anything. The recommended plan is marked with a slightly darker rule and a
// small label, because that is enough.

import { useEffect, useRef, useState } from "react";

/** Section eyebrow. Matches the landing page's existing editorial rhythm. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary-500">{children}</p>
  );
}

export function SectionHeading({
  children,
  as: Tag = "h2",
  className = "",
}: {
  children: React.ReactNode;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <Tag
      className={`text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-gray-900 ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * A price.
 *
 * The currency symbol and the interval are deliberately lighter and smaller
 * than the figure: the number is the information, the rest is grammar. Tabular
 * figures keep the three plan prices optically aligned even at different digit
 * counts.
 */
export function Price({
  formatted,
  interval,
  size = "lg",
  className = "",
}: {
  formatted: string;
  interval?: string;
  size?: "sm" | "lg" | "xl";
  className?: string;
}) {
  const figure =
    size === "xl"
      ? "text-[2.75rem] leading-none"
      : size === "lg"
        ? "text-[2rem] leading-none"
        : "text-[1.375rem] leading-none";
  return (
    <div className={`flex flex-wrap items-baseline gap-x-1.5 ${className}`} dir="ltr">
      <span className={`${figure} font-semibold tracking-[-0.03em] text-gray-900 tabular-nums`}>
        {formatted}
      </span>
      {interval && (
        <span className="whitespace-nowrap text-[13px] font-normal text-gray-400">/ {interval}</span>
      )}
    </div>
  );
}

/** Fine horizontal rule used instead of a card border. */
export function Rule({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-gray-200/70 ${className}`} />;
}

/** Small neutral label. Used for Recommended and Current plan only. */
export function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
        tone === "accent" ? "bg-gray-900 text-white" : "bg-primary-50 text-primary-700"
      }`}
    >
      {children}
    </span>
  );
}

export function Check({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

/**
 * Unavailable marker.
 *
 * A dash plus an sr-only word: never colour alone, so the state survives
 * greyscale, low vision and a screen reader.
 */
export function NotIncluded({ label }: { label: string }) {
  return (
    <span className="text-gray-300" aria-hidden="false">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Announces a changed total to assistive technology.
 *
 * A sighted visitor sees the summary update; without this a screen-reader user
 * changes a selector and hears nothing at all.
 */
export function PriceAnnouncer({ message }: { message: string }) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

/** True when the visitor asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true); // assume reduced until proven otherwise
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

/**
 * One gentle entrance per section on first scroll into view. No parallax, no
 * continuous animation, and nothing at all when reduced motion is requested.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <div
      ref={ref}
      className={`${className} ${
        reduced
          ? ""
          : `transition-[opacity,transform] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
            }`
      }`}
      style={!reduced && delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Currency switch.
 *
 * A radiogroup rather than buttons, so arrow keys work and the selected state
 * is exposed. The change is announced by the summary's live region.
 */
export function CurrencyToggle({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: string[];
  onChange: (c: string) => void;
  label: string;
}) {
  if (options.length < 2) return null;
  return (
    <div className="flex items-center gap-2.5">
      <span id="currency-label" className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-400">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="currency-label"
        className="inline-flex rounded-full border border-gray-200 bg-white p-0.5"
        dir="ltr"
      >
        {options.map((c) => {
          const selected = value === c;
          return (
            <button
              key={c}
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(c)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1 ${
                selected ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {c}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Stable skeleton.
 *
 * Sized to the real content so the layout does not jump, and deliberately shows
 * no numerals: a flash of "$0" or "0 credits" during load would be a lie about
 * the price.
 */
export function PlanSkeleton() {
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl bg-gray-300 ring-1 ring-gray-300 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-white p-7">
          <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-50" />
          <div className="mt-1.5 h-3 w-4/5 animate-pulse rounded bg-gray-50" />
          <div className="mt-7 h-9 w-32 animate-pulse rounded bg-gray-100" />
          <div className="mt-7 space-y-2.5">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-3 w-3/4 animate-pulse rounded bg-gray-50" />
            ))}
          </div>
          <div className="mt-7 h-10 w-full animate-pulse rounded-xl bg-gray-100" />
        </div>
      ))}
    </div>
  );
}
