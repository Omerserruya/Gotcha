"use client";

/**
 * "This person came from an ad" - shown where the agent is already looking.
 *
 * A lead that arrived through a Click-to-WhatsApp ad is a different
 * conversation from a walk-in: they clicked something specific, they are
 * expecting it to be continued, and the business paid for them. Meta tells us
 * this on the customer's very first message and nowhere else, so if it is not
 * surfaced here it may as well not have been captured.
 *
 * Two states, deliberately distinct:
 *   * we know the ad - show its headline, because that is the thing the
 *     customer actually read before writing;
 *   * we only know it was an ad (the referral never reached us, but Meta
 *     billed the conversation as a referral conversion) - say exactly that
 *     rather than inventing a campaign name.
 */

import { useState } from "react";

export interface CampaignOrigin {
  fromAdCampaign?: boolean;
  referralSourceType?: string | null;
  referralSourceId?: string | null;
  referralSourceUrl?: string | null;
  referralHeadline?: string | null;
  referralBody?: string | null;
}

export function CampaignBadge({
  conversation,
  t,
  compact = false,
}: {
  conversation: CampaignOrigin | null | undefined;
  t: (k: string, vars?: Record<string, string>) => string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!conversation?.fromAdCampaign) return null;

  const headline = conversation.referralHeadline?.trim();
  const label = headline || t("conversations.campaign.unknownAd");
  const hasDetail = Boolean(headline || conversation.referralBody || conversation.referralSourceUrl);

  const icon = (
    <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84a4.5 4.5 0 010-7.68m0 7.68L4.5 18V6l5.84 2.16m0 7.68V8.16m0 7.68L19.5 19.5V4.5L10.34 8.16" />
    </svg>
  );

  if (compact) {
    // Inbox list: the fact only. The list is scanned, not read.
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700"
        title={label}
      >
        {icon}
        {t("conversations.campaign.short")}
      </span>
    );
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ${hasDetail ? "hover:bg-amber-100" : "cursor-default"}`}
      >
        {icon}
        <span className="truncate">{t("conversations.campaign.from").replace("{ad}", label)}</span>
        {hasDetail && (
          <svg className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>

      {open && hasDetail && (
        <div className="mt-1.5 rounded-lg border border-amber-100 bg-amber-50/60 p-2 text-[11px] leading-relaxed text-gray-700">
          {headline && <div className="font-medium text-gray-900">{headline}</div>}
          {conversation.referralBody && <p className="mt-0.5">{conversation.referralBody}</p>}
          {conversation.referralSourceUrl && (
            <a
              href={conversation.referralSourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block font-medium text-amber-800 underline"
            >
              {t("conversations.campaign.openAd")}
            </a>
          )}
          {conversation.referralSourceId && (
            <div className="mt-1 font-mono text-[10px] text-gray-500">
              {t("conversations.campaign.adId")}: {conversation.referralSourceId}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
