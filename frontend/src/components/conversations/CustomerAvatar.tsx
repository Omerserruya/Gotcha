"use client";

import Image from "next/image";
import clsx from "clsx";

const CHANNEL_ICONS: Record<string, { logo: string; label: string }> = {
  WHATSAPP: { logo: "/icons/wa.png", label: "WhatsApp" },
  MESSENGER: { logo: "/icons/msn.png", label: "Messenger" },
  INSTAGRAM: { logo: "/icons/ins.png", label: "Instagram" },
  GMAIL: { logo: "/icons/gm.png", label: "Gmail" },
  OUTLOOK: { logo: "/icons/ol.png", label: "Outlook" },
  SLACK: { logo: "/icons/slk.png", label: "Slack" },
};

interface Props {
  name?: string | null;
  avatarUrl?: string | null;
  channel?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function CustomerAvatar({ name, avatarUrl, channel, size = "md", className }: Props) {
  const initial = (name || "?").charAt(0).toUpperCase();
  const channelIcon = channel ? CHANNEL_ICONS[channel] : null;

  const sizeClasses = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12",
  };

  const badgeSize = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  const badgeImgSize = {
    sm: 12,
    md: 14,
    lg: 16,
  };

  const initialTextSize = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  return (
    <div className={clsx("relative shrink-0", sizeClasses[size], className)}>
      {/* Avatar */}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name || ""}
          className={clsx("rounded-xl object-cover", sizeClasses[size])}
          referrerPolicy="no-referrer"
          onError={(e) => {
            // Fallback to initial on load error
            (e.target as HTMLImageElement).style.display = "none";
            (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
          }}
        />
      ) : null}
      {/* Fallback initial (shown when no avatar or on error) */}
      <div
        className={clsx(
          "bg-gray-100 rounded-xl flex items-center justify-center",
          sizeClasses[size],
          avatarUrl ? "hidden" : ""
        )}
      >
        <span className={clsx("font-bold text-gray-600", initialTextSize[size])}>
          {initial}
        </span>
      </div>

      {/* Channel badge overlay - bottom-end */}
      {channelIcon && (
        <div
          className={clsx(
            "absolute -bottom-0.5 -end-0.5 rounded-full bg-white shadow-sm ring-1 ring-white flex items-center justify-center",
            badgeSize[size]
          )}
          title={channelIcon.label}
        >
          <Image
            src={channelIcon.logo}
            alt={channelIcon.label}
            width={badgeImgSize[size]}
            height={badgeImgSize[size]}
            className="rounded-full"
          />
        </div>
      )}
    </div>
  );
}
