"use client";

import Image from "next/image";
import clsx from "clsx";
import { ShopifyGlyph } from "@/components/shopify/ShopifyGlyph";

interface Props {
  channel?: string;
  size?: "sm" | "md";
  showLabel?: boolean;
}

const CHANNEL_MAP: Record<string, { label: string; logo: string }> = {
  WHATSAPP: { label: "WhatsApp", logo: "/icons/wa.png" },
  MESSENGER: { label: "Messenger", logo: "/icons/msn.png" },
  INSTAGRAM: { label: "Instagram", logo: "/icons/ins.png" },
  GMAIL: { label: "Gmail", logo: "/icons/gm.png" },
  OUTLOOK: { label: "Outlook", logo: "/icons/ol.png" },
  SLACK: { label: "Slack", logo: "/icons/slk.png" },
};

export function ChannelBadge({ channel, size = "sm", showLabel = false }: Props) {
  const config = channel ? CHANNEL_MAP[channel] : undefined;
  const label = config?.label || channel || "Unknown";
  const imgSize = size === "sm" ? 14 : 18;

  // Shopify Live Chat carries the Shopify mark, like every other channel
  // carries its platform's. The merchant's own branding is what the
  // storefront visitor sees; in the inbox the useful signal is which
  // platform the conversation arrived from.
  if (channel === "SHOPIFY_LIVE_CHAT") {
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1 shrink-0",
          showLabel && "font-medium",
          size === "sm" ? "text-[9px]" : "text-[11px]",
        )}
        title="Shopify Live Chat"
      >
        <ShopifyGlyph className={size === "sm" ? "w-3.5 h-3.5" : "w-4.5 h-4.5"} />
        {showLabel && <span>Shopify Live Chat</span>}
      </span>
    );
  }

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 shrink-0",
        showLabel && "font-medium",
        size === "sm" ? "text-[9px]" : "text-[11px]"
      )}
      title={label}
    >
      {config?.logo ? (
        <Image src={config.logo} alt={label} width={imgSize} height={imgSize} className="rounded-sm" />
      ) : (
        <svg className={size === "sm" ? "w-3.5 h-3.5" : "w-4.5 h-4.5"} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      )}
      {showLabel && <span>{label}</span>}
    </span>
  );
}
