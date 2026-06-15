"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  activateVoiceChannelNumber,
  createVoiceChannelBYO,
  type VoiceChannel,
  type VoiceChannelPhoneNumber,
} from "@/lib/api";
import clsx from "clsx";

type Step = 1 | 2 | 3;

const ACCOUNT_SID_REGEX = /^AC[0-9a-f]{32}$/;
const TWILIO_CONSOLE_URL = "https://console.twilio.com";

interface ByoForm {
  friendlyName: string;
  accountSid: string;
  authToken: string;
}

const EMPTY_FORM: ByoForm = {
  friendlyName: "",
  accountSid: "",
  authToken: "",
};

interface ActivationProgress {
  total: number;
  done: number;
  failed: { id: string; e164: string; message: string }[];
}

export default function NewVoiceChannelPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const flags = useVoiceFlags();

  const [step, setStep] = useState<Step>(1);

  // Step 1 - credentials form
  const [form, setForm] = useState<ByoForm>(EMPTY_FORM);
  const [byoSubmitting, setByoSubmitting] = useState(false);
  const [byoError, setByoError] = useState<string | null>(null);
  const [accountSidError, setAccountSidError] = useState<string | null>(null);
  const [showAuthToken, setShowAuthToken] = useState(false);

  // Step 2 - discovered numbers
  const [channel, setChannel] = useState<VoiceChannel | null>(null);
  const [selectedNumberIds, setSelectedNumberIds] = useState<Set<string>>(new Set());

  // Step 3 - activation
  const [progress, setProgress] = useState<ActivationProgress>({
    total: 0,
    done: 0,
    failed: [],
  });
  const [activationRunning, setActivationRunning] = useState(false);
  const [activationDone, setActivationDone] = useState(false);

  const accountSidValid = useMemo(
    () => ACCOUNT_SID_REGEX.test(form.accountSid),
    [form.accountSid],
  );

  const byoCanSubmit = useMemo(
    () =>
      form.friendlyName.trim().length > 0 &&
      accountSidValid &&
      form.authToken.length > 0 &&
      !byoSubmitting,
    [form, accountSidValid, byoSubmitting],
  );

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">{t("settings.voiceChannels.adminRequired")}</p>
      </div>
    );
  }

  if (flags.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm py-16">
        {t("settings.voiceChannels.loading")}
      </div>
    );
  }

  if (!flags.voiceCopilotEnabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">404</h1>
        <p className="text-sm text-gray-500">{t("settings.voiceChannels.pageNotAvailable")}</p>
      </div>
    );
  }

  function validateAccountSid(value: string): boolean {
    if (!ACCOUNT_SID_REGEX.test(value)) {
      setAccountSidError(t("settings.voiceChannels.wizard.step1BYOAccountSidError"));
      return false;
    }
    setAccountSidError(null);
    return true;
  }

  async function handleByoSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !byoCanSubmit) return;
    if (!validateAccountSid(form.accountSid)) return;

    setByoSubmitting(true);
    setByoError(null);
    try {
      const res = await createVoiceChannelBYO(token, {
        friendlyName: form.friendlyName.trim(),
        accountSid: form.accountSid,
        authToken: form.authToken,
      });
      setChannel(res.data);
      setSelectedNumberIds(new Set(res.data.numbers.map((n) => n.id)));
      setStep(2);
    } catch (err) {
      setByoError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setByoSubmitting(false);
    }
  }

  function toggleNumber(numberId: string) {
    setSelectedNumberIds((prev) => {
      const next = new Set(prev);
      if (next.has(numberId)) next.delete(numberId);
      else next.add(numberId);
      return next;
    });
  }

  function selectAll() {
    if (!channel) return;
    setSelectedNumberIds(new Set(channel.numbers.map((n) => n.id)));
  }

  function deselectAll() {
    setSelectedNumberIds(new Set());
  }

  async function runActivation() {
    if (!token || !channel || activationRunning) return;
    const ids = Array.from(selectedNumberIds);
    setActivationRunning(true);
    setActivationDone(false);
    setProgress({ total: ids.length, done: 0, failed: [] });
    setStep(3);

    const failed: ActivationProgress["failed"] = [];
    let done = 0;

    for (const id of ids) {
      const number: VoiceChannelPhoneNumber | undefined = channel.numbers.find(
        (n) => n.id === id,
      );
      try {
        await activateVoiceChannelNumber(token, channel.id, id);
      } catch (err) {
        failed.push({
          id,
          e164: number?.e164 ?? id,
          message: err instanceof Error ? err.message : "activation_failed",
        });
      } finally {
        done += 1;
        setProgress({ total: ids.length, done, failed: [...failed] });
      }
    }

    setActivationRunning(false);
    setActivationDone(true);

    // Tell VoiceCallContext + useVoiceFlags that at least one channel just
    // came online so the Twilio token fetch can arm itself without a page
    // reload. Skipped when every activation failed.
    if (done > failed.length) {
      window.dispatchEvent(new Event("voice-channel:activated"));
    }
  }

  // ─── Render ───────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-20">
      {/* Breadcrumb back link */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/settings/voice-channels"
          className="text-xs text-gray-500 hover:text-primary-600 inline-flex items-center gap-1"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("settings.voiceChannels.wizard.backLink")}
        </Link>
        <Stepper step={step} t={t} />
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.voiceChannels.wizard.step1Title")}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t("settings.voiceChannels.wizard.step1Subtitle")}
        </p>
      </div>

      {/* Step 1 - BYO credentials form */}
      {step === 1 && (
        <form
          onSubmit={handleByoSubmit}
          className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6 space-y-5"
        >
          <div>
            <h2 className="text-base font-semibold text-gray-900">{t("settings.voiceChannels.wizard.step1BYOTitle")}</h2>
            <p className="text-xs text-gray-500 mt-1">
              {t("settings.voiceChannels.wizard.step1BYOSubtitle")}{" "}
              <a
                href={TWILIO_CONSOLE_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary-600 hover:text-primary-700 underline underline-offset-2"
              >
                {t("settings.voiceChannels.wizard.step1BYOWhereToFind")}
              </a>{" "}
              {t("settings.voiceChannels.wizard.step1BYOAutoSetup")}
            </p>
          </div>

          {byoError && (
            <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-red-200">
              {byoError}
            </div>
          )}

          <Field
            label={t("settings.voiceChannels.wizard.step1BYOFriendlyName")}
            help={t("settings.voiceChannels.wizard.step1BYOFriendlyNameHelp")}
          >
            <input
              type="text"
              value={form.friendlyName}
              onChange={(e) => setForm((p) => ({ ...p, friendlyName: e.target.value }))}
              placeholder="GOTCHA Israel"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
              required
            />
          </Field>

          <Field
            label={t("settings.voiceChannels.wizard.step1BYOAccountSid")}
            help={t("settings.voiceChannels.wizard.step1BYOAccountSidHelp")}
            error={accountSidError}
          >
            <input
              type="text"
              value={form.accountSid}
              onChange={(e) => {
                setForm((p) => ({ ...p, accountSid: e.target.value.trim() }));
                if (accountSidError) setAccountSidError(null);
              }}
              onBlur={(e) => {
                if (e.target.value) validateAccountSid(e.target.value);
              }}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full text-sm font-mono border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
              required
            />
          </Field>

          <Field
            label={t("settings.voiceChannels.wizard.step1BYOAuthToken")}
            help={t("settings.voiceChannels.wizard.step1BYOAuthTokenHelp")}
          >
            <div className="relative">
              <input
                type={showAuthToken ? "text" : "password"}
                value={form.authToken}
                onChange={(e) => setForm((p) => ({ ...p, authToken: e.target.value }))}
                placeholder="••••••••"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pe-20 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                required
              />
              <button
                type="button"
                onClick={() => setShowAuthToken((v) => !v)}
                className="absolute end-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-50"
              >
                {showAuthToken
                  ? t("settings.voiceChannels.wizard.step1BYOSecretHide")
                  : t("settings.voiceChannels.wizard.step1BYOSecretShow")}
              </button>
            </div>
          </Field>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={!byoCanSubmit}
              className="px-5 py-2 min-h-[40px] text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-xl transition disabled:opacity-50"
            >
              {byoSubmitting ? t("settings.voiceChannels.wizard.step1BYOSubmitting") : t("settings.voiceChannels.wizard.step1BYOSubmit")}
            </button>
          </div>
        </form>
      )}

      {/* Step 2 - discovered numbers */}
      {step === 2 && channel && (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{t("settings.voiceChannels.wizard.step2Title")}</h2>
            <p className="text-xs text-gray-500 mt-1">
              {t("settings.voiceChannels.wizard.step2Subtitle", { count: String(channel.numbers.length) })}
            </p>
          </div>

          {channel.numbers.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              {t("settings.voiceChannels.wizard.step2NoNumbers")}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={selectAll}
                  className="px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 ring-1 ring-primary-200 rounded-lg"
                >
                  {t("settings.voiceChannels.wizard.step2SelectAll")}
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 ring-1 ring-gray-200 rounded-lg"
                >
                  {t("settings.voiceChannels.wizard.step2DeselectAll")}
                </button>
              </div>

              <div className="space-y-2">
                {channel.numbers.map((number) => {
                  const checked = selectedNumberIds.has(number.id);
                  return (
                    <label
                      key={number.id}
                      className={clsx(
                        "flex items-center gap-3 px-3 py-2.5 rounded-xl ring-1 cursor-pointer transition",
                        checked
                          ? "bg-primary-50/40 ring-primary-200"
                          : "bg-gray-50 ring-gray-100 hover:bg-gray-100",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleNumber(number.id)}
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-200"
                      />
                      <span className="font-mono text-sm text-gray-900">{number.e164}</span>
                      {number.friendlyName && (
                        <span className="text-xs text-gray-500 truncate">
                          {number.friendlyName}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => router.push(`/settings/voice-channels/${channel.id}`)}
              className="px-4 py-2 min-h-[40px] text-sm text-gray-600 bg-gray-50 hover:bg-gray-100 ring-1 ring-gray-200 rounded-xl transition"
            >
              {t("settings.voiceChannels.wizard.step2SkipButton")}
            </button>
            <button
              type="button"
              onClick={runActivation}
              disabled={selectedNumberIds.size === 0}
              className="px-5 py-2 min-h-[40px] text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-xl transition disabled:opacity-50"
            >
              {t("settings.voiceChannels.wizard.step2ActivateButton", { count: String(selectedNumberIds.size) })}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 - activation progress */}
      {step === 3 && channel && (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6 space-y-5">
          <h2 className="text-base font-semibold text-gray-900">
            {activationDone ? t("settings.voiceChannels.wizard.step3TitleDone") : t("settings.voiceChannels.wizard.step3TitleRunning")}
          </h2>

          <div>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
              <span>
                {progress.done} / {progress.total}
              </span>
              <span>{Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={clsx(
                  "h-full transition-all",
                  activationRunning ? "bg-primary-400" : "bg-primary-500",
                )}
                style={{
                  width: `${Math.min(
                    100,
                    (progress.done / Math.max(progress.total, 1)) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>

          {progress.failed.length > 0 && (
            <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-red-200 space-y-1">
              <div className="font-medium">{t("settings.voiceChannels.wizard.step3PartialFailTitle")}</div>
              <ul className="list-disc ps-5 text-xs space-y-0.5">
                {progress.failed.map((f) => (
                  <li key={f.id}>
                    <span className="font-mono">{f.e164}</span> - {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activationDone && (
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => router.push(`/settings/voice-channels/${channel.id}`)}
                className="px-5 py-2 min-h-[40px] text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-xl transition"
              >
                {t("settings.voiceChannels.wizard.step3OpenButton")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────

function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
      {children}
      {error ? (
        <p className="text-[11px] text-red-600 mt-1">{error}</p>
      ) : help ? (
        <p className="text-[11px] text-gray-400 mt-1">{help}</p>
      ) : null}
    </div>
  );
}

function Stepper({ step, t }: { step: Step; t: (key: string) => string }) {
  const labels: { id: Step; label: string }[] = [
    { id: 1, label: t("settings.voiceChannels.wizard.stepperDetails") },
    { id: 2, label: t("settings.voiceChannels.wizard.stepperNumbers") },
    { id: 3, label: t("settings.voiceChannels.wizard.stepperActivation") },
  ];
  return (
    <ol className="hidden md:flex items-center gap-1.5 text-[11px] text-gray-400">
      {labels.map((item, idx) => {
        const active = item.id === step;
        const done = item.id < step;
        return (
          <li key={item.id} className="flex items-center gap-1.5">
            <span
              className={clsx(
                "w-5 h-5 rounded-full flex items-center justify-center font-medium",
                active
                  ? "bg-primary-500 text-white"
                  : done
                  ? "bg-primary-100 text-primary-700"
                  : "bg-gray-100 text-gray-400",
              )}
            >
              {item.id}
            </span>
            <span className={clsx(active && "text-gray-700 font-medium")}>{item.label}</span>
            {idx < labels.length - 1 && <span className="text-gray-200">›</span>}
          </li>
        );
      })}
    </ol>
  );
}
