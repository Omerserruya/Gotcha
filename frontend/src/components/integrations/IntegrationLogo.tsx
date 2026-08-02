"use client";

/**
 * One integration logo, resolved centrally.
 *
 * The previous sidebar read `logoUrl` off the catalog row. Not one of the 17
 * catalog rows has that column set, so every integration fell through to a
 * generated letter tile - G, S, A, F - which is what made the screen look
 * unfinished. Logos now come from the shared registry keyed by slug, with the
 * catalog value used only if it is actually populated.
 *
 * The fallback is a real connector glyph, never a letter. A letter tile reads
 * as "we could not be bothered"; an icon reads as "this provider has no mark",
 * which is the true statement.
 */

import { useState } from "react";
import clsx from "clsx";
import { logoForIntegration } from "@/lib/integration-logos";

export interface IntegrationLogoProps {
  slug: string;
  name: string;
  /** Populated catalog value wins over the registry; ignored when empty. */
  logoUrl?: string | null;
  /** Rendered box size in px. 24-28 in the sidebar, 32-36 in the header. */
  size?: number;
  className?: string;
}

/** Generic connector mark: two linked plates. Deliberately brand-neutral. */
function FallbackGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size * 0.62}
      height={size * 0.62}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 7V4.5M15 7V4.5" />
      <rect x="6.5" y="7" width="11" height="6" rx="1.6" />
      <path d="M12 13v3.2a3.3 3.3 0 0 1-3.3 3.3H8" />
    </svg>
  );
}

export function IntegrationLogo({ slug, name, logoUrl, size = 24, className }: IntegrationLogoProps) {
  const [broken, setBroken] = useState(false);
  const src = (logoUrl && logoUrl.trim()) || logoForIntegration(slug) || logoForIntegration(name);

  const box = clsx(
    "shrink-0 rounded-[6px] flex items-center justify-center overflow-hidden",
    className,
  );

  if (!src || broken) {
    return (
      <span
        data-testid={`integration-logo-fallback-${slug}`}
        style={{ width: size, height: size }}
        className={clsx(box, "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500")}
        role="img"
        aria-label={name}
      >
        <FallbackGlyph size={size} />
      </span>
    );
  }

  return (
    <span
      data-testid={`integration-logo-${slug}`}
      style={{ width: size, height: size }}
      // A white plate keeps dark-on-transparent brand marks legible in dark
      // mode without recolouring anyone's logo.
      className={clsx(box, "bg-white ring-1 ring-black/[0.06] dark:ring-white/10")}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        className="w-[78%] h-[78%] object-contain"
      />
    </span>
  );
}

export default IntegrationLogo;
