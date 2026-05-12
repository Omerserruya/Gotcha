"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import type { CommittedUtterance } from "@/context/VoiceCallContext";

interface TranscriptStageProps {
  committedTranscripts: CommittedUtterance[];
  currentUtterance: { agent: string; customer: string };
  agentName: string;
  customerName: string;
  /** True when a call is in connecting/ringing/active so the "Listening…"
   * placeholder shows instead of the post-call empty state. */
  isLive: boolean;
  /** Optional outer className override — defaults to viewport-locked card. */
  className?: string;
}

/**
 * Teleprompter-style transcript view originally extracted from the
 * outbound/call PhoneCallUI. Renders committed finals + the in-flight
 * interim for each speaker; auto-scrolls to the latest line.
 *
 * The /outbound/call page still uses this exact component so the visual
 * stays byte-identical with the pre-extraction baseline.
 */
export function TranscriptStage({
  committedTranscripts,
  currentUtterance,
  agentName,
  customerName,
  isLive,
  className,
}: TranscriptStageProps) {
  const { t } = useI18n();
  const feedRef = useRef<HTMLDivElement>(null);
  const liveCount = (currentUtterance.agent ? 1 : 0) + (currentUtterance.customer ? 1 : 0);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [committedTranscripts.length, liveCount, currentUtterance.agent, currentUtterance.customer]);

  return (
    <div
      ref={feedRef}
      className={clsx(
        "flex-1 overflow-y-auto px-6 md:px-12 lg:px-20 pb-16 scroll-smooth",
        className,
      )}
    >
      {committedTranscripts.length === 0 && !currentUtterance.agent && !currentUtterance.customer ? (
        <div className="h-full flex items-center justify-center text-gray-500 text-lg italic">
          {isLive ? t("voice.workspace.transcript.listening") : t("voice.workspace.transcript.noTranscript")}
        </div>
      ) : (
        <div className="flex flex-col gap-6 pt-6">
          {committedTranscripts.map((t) => (
            <StageLine
              key={`committed:${t.speaker}:${t.seq}`}
              speaker={t.speaker}
              text={t.text}
              isLive={false}
              agentName={agentName}
              customerName={customerName}
            />
          ))}
          {currentUtterance.customer && (
            <StageLine
              key="live:customer"
              speaker="customer"
              text={currentUtterance.customer}
              isLive={true}
              agentName={agentName}
              customerName={customerName}
            />
          )}
          {currentUtterance.agent && (
            <StageLine
              key="live:agent"
              speaker="agent"
              text={currentUtterance.agent}
              isLive={true}
              agentName={agentName}
              customerName={customerName}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StageLine({
  speaker,
  text,
  isLive,
  agentName,
  customerName,
}: {
  speaker: "agent" | "customer";
  text: string;
  isLive: boolean;
  agentName: string;
  customerName: string;
}) {
  const isAgent = speaker === "agent";
  const name = isAgent ? agentName : customerName;
  return (
    <div className="flex flex-col items-start text-start">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500 mb-1">
        {name}
      </span>
      <p
        className={clsx(
          "max-w-[90%] md:max-w-[75%] text-xl md:text-2xl leading-relaxed font-light",
          isAgent ? "text-sky-200" : "text-gray-100",
          isLive && "opacity-70",
        )}
      >
        {text}
        {isLive && <span className="inline-block ms-1 w-2 h-5 align-middle bg-current opacity-80 animate-pulse" />}
      </p>
    </div>
  );
}
