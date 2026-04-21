"use client";

import { useState } from "react";
import { useI18n } from "@/context/I18nContext";
import { SttConfigPanel } from "./components/SttConfigPanel";
import { TwilioPanel } from "./components/TwilioPanel";
import { LiveMonitoringPanel } from "./components/LiveMonitoringPanel";
import clsx from "clsx";

type Tab = "stt" | "twilio" | "live";

function TabButton({
  id,
  active,
  label,
  onClick,
}: {
  id: Tab;
  active: boolean;
  label: string;
  onClick: (id: Tab) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={clsx(
        "px-4 py-2 text-sm font-medium -mb-px border-b-2 transition",
        active
          ? "text-violet-700 border-violet-600"
          : "text-gray-500 border-transparent hover:text-gray-700"
      )}
    >
      {label}
    </button>
  );
}

export default function VoiceCopilotContent() {
  const [tab, setTab] = useState<Tab>("stt");
  const { t } = useI18n();

  return (
    <div className="p-6 max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900">
          {t("settings.voiceCopilot.title")}
        </h1>
      </header>

      <div className="flex gap-2 border-b border-gray-200 mb-6">
        <TabButton
          id="stt"
          active={tab === "stt"}
          label={t("settings.voiceCopilot.tabs.stt")}
          onClick={setTab}
        />
        <TabButton
          id="twilio"
          active={tab === "twilio"}
          label={t("settings.voiceCopilot.tabs.twilio")}
          onClick={setTab}
        />
        <TabButton
          id="live"
          active={tab === "live"}
          label={t("settings.voiceCopilot.tabs.live")}
          onClick={setTab}
        />
      </div>

      {tab === "stt" && <SttConfigPanel />}
      {tab === "twilio" && <TwilioPanel />}
      {tab === "live" && <LiveMonitoringPanel />}
    </div>
  );
}
