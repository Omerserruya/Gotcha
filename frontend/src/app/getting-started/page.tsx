"use client";

// Getting Started - the premium post-onboarding "first steps" journey.
//
// The page has two jobs: (a) let the owner TALK to their AI employee
// immediately (the hero action - value in under a minute, zero setup), and
// (b) walk the five canonical setup actions to go live. The checklist is the
// SAME canonical journey the sidebar panel and nav badge read
// (lib/journey-cache.ts → GET /onboarding/journey): same items, same labels,
// same counts, same completion definitions - never computed locally.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { testAgentChat, type JourneyData, type JourneyMilestone } from "@/lib/api";
import { getCachedJourney, refreshJourney, subscribeJourney } from "@/lib/journey-cache";
import { track } from "@/lib/analytics";

type ChatMsg = { role: "user" | "assistant"; content: string };

const MILESTONE_ICONS: Record<string, string> = {
  connect_source_of_truth: "🔗",
  connect_channel: "📡",
  connect_knowledge: "📚",
  create_ai_employee: "👋",
  create_process: "⚙️",
};

export default function GettingStartedPage() {
  return (
    <AppLayout>
      <GettingStartedInner />
    </AppLayout>
  );
}

function GettingStartedInner() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [journey, setJourney] = useState<JourneyData | null>(getCachedJourney());
  const [loading, setLoading] = useState(!getCachedJourney());
  const [loadError, setLoadError] = useState(false);

  // chat state
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  // For setup_item_completed analytics: which items were incomplete last time.
  const prevIncompleteRef = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(false);
    const j = await refreshJourney(token, true);
    if (!j) setLoadError(true);
    setLoading(false);
  }, [token]);

  // Live store subscription: any refresh (this page, the sidebar panel, a
  // window-focus after OAuth) updates this page without a manual reload.
  useEffect(() =>
    subscribeJourney((j) => {
      if (!j) return;
      setJourney(j);
      setLoading(false);
      setLoadError(false);
      const incomplete = new Set(j.milestones.filter((m) => !m.done).map((m) => m.id as string));
      const prev = prevIncompleteRef.current;
      if (prev) {
        prev.forEach((id) => {
          if (!incomplete.has(id)) track("setup_item_completed", { item: id });
        });
      }
      prevIncompleteRef.current = incomplete;
    }),
  []);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.replace("/conversations");
      return;
    }
    void load();
  }, [user, router, load]);

  // Returning to the tab (OAuth flows, channel connects in a second tab)
  // re-derives readiness immediately.
  useEffect(() => {
    if (!token) return;
    const onFocus = () => void refreshJourney(token, true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [token]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const employee = journey?.employee || null;

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || !token || !employee || sending) return;
    setInput("");
    setChatError("");
    setSending(true);
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: msg }]);
    try {
      const r = await testAgentChat(token, employee.id, msg, history);
      setMessages((m) => [...m, { role: "assistant", content: r.data.reply }]);
    } catch {
      setChatError(t("gettingStarted.chat.error"));
    } finally {
      setSending(false);
    }
  }

  const milestones = journey?.milestones || [];
  const doneCount = journey?.summary?.done ?? milestones.filter((m) => m.done).length;
  const totalCount = journey?.summary?.total ?? milestones.length;
  const bizName = journey?.business?.name;
  const suggestions = [
    t("gettingStarted.chat.s1"),
    t("gettingStarted.chat.s2"),
    t("gettingStarted.chat.s3"),
  ];

  // Stable skeleton while readiness resolves - never a flash of "everything
  // incomplete" from local guesses.
  if (loading) {
    return (
      <div className="mx-auto h-full max-w-5xl overflow-y-auto px-6 py-10">
        <div className="mb-10 space-y-3">
          <div className="h-9 w-2/3 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-4 w-1/2 animate-pulse rounded-lg bg-slate-100" />
        </div>
        <div className="grid gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="h-96 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />
          </div>
          <div className="space-y-2 lg:col-span-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border border-slate-100 bg-slate-50" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Recoverable error instead of contradictory local guesses.
  if (loadError && !journey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-slate-500">{t("setupChecklist.error")}</p>
        <button
          onClick={() => { setLoading(true); void load(); }}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          {t("setupChecklist.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-6 py-10">
      {/* ── Hero ── */}
      <div className="mb-10 flex items-start justify-between gap-6">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <Image src="/logo_icon.png" alt="GOTCHA" width={40} height={40} className="rounded-xl" />
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              {bizName
                ? t("gettingStarted.titleWithBiz").replace("{business}", bizName)
                : t("gettingStarted.title")}
            </h1>
          </div>
          <p className="max-w-2xl text-slate-500">{t("gettingStarted.subtitle")}</p>
          <button
            onClick={() => window.dispatchEvent(new Event("gotcha:start-tour"))}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50"
          >
            ✨ {t("gettingStarted.tourCta")}
          </button>
          {/* what the AI already has - earned context, not empty promises */}
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {journey?.context?.coreSystem && (
              <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                ✓ {t("gettingStarted.chips.core").replace("{system}", journey.context.coreSystem)}
              </span>
            )}
            {(journey?.context?.kbCount ?? 0) > 0 && (
              <span className="rounded-full bg-indigo-50 px-3 py-1 font-medium text-indigo-700">
                ✓ {t("gettingStarted.chips.kb")}
              </span>
            )}
            {(journey?.context?.detectedChannelCount ?? 0) > 0 && (
              <span className="rounded-full bg-sky-50 px-3 py-1 font-medium text-sky-700">
                {t("gettingStarted.chips.channels").replace(
                  "{n}",
                  String(journey?.context?.detectedChannelCount),
                )}
              </span>
            )}
          </div>
        </div>
        {/* progress ring - same numbers as the sidebar panel and nav badge */}
        <div className="hidden shrink-0 flex-col items-center sm:flex">
          <div className="relative h-20 w-20">
            <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e2e8f0" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="15.9" fill="none" stroke="#6366f1" strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${(doneCount / Math.max(totalCount, 1)) * 100} 100`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-700">
              {doneCount}/{totalCount}
            </div>
          </div>
          <span className="mt-1 text-xs text-slate-400">{t("gettingStarted.progress")}</span>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        {/* ── Hero action: talk to your employee ── */}
        <section id="chat" className="lg:col-span-3">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-lg font-bold text-white">
                {(employee?.name || "A").charAt(0)}
              </div>
              <div>
                <div className="font-semibold text-slate-900">
                  {employee
                    ? t("gettingStarted.chat.title").replace("{name}", employee.name)
                    : t("gettingStarted.chat.noEmployeeTitle")}
                </div>
                <div className="text-xs text-slate-400">
                  {employee ? t("gettingStarted.chat.subtitle") : t("gettingStarted.chat.noEmployeeSub")}
                </div>
              </div>
              {employee && (
                <span className="ms-auto rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600">
                  {t("gettingStarted.chat.ready")}
                </span>
              )}
            </div>

            {employee ? (
              <>
                <div className="h-72 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
                  {messages.length === 0 && (
                    <div className="pt-6 text-center">
                      <p className="mb-4 text-sm text-slate-400">{t("gettingStarted.chat.empty")}</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            onClick={() => send(s)}
                            className="rounded-full border border-indigo-200 bg-white px-3 py-1.5 text-xs text-indigo-600 transition hover:bg-indigo-50"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map((m, i) => (
                    <div key={i} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                      <div
                        className={clsx(
                          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm",
                          m.role === "user"
                            ? "bg-indigo-600 text-white"
                            : "border border-slate-200 bg-white text-slate-700",
                        )}
                      >
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {sending && (
                    <div className="flex justify-start">
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-400">
                        <span className="animate-pulse">···</span>
                      </div>
                    </div>
                  )}
                  {chatError && <p className="text-center text-xs text-rose-500">{chatError}</p>}
                  <div ref={chatEndRef} />
                </div>
                <form
                  className="flex items-center gap-2 border-t border-slate-100 px-4 py-3"
                  onSubmit={(e) => { e.preventDefault(); send(); }}
                >
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={t("gettingStarted.chat.placeholder")}
                    className="flex-1 rounded-xl border border-slate-200 px-4 py-2 text-sm outline-none focus:border-indigo-400"
                  />
                  <button
                    type="submit"
                    disabled={sending || !input.trim()}
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
                  >
                    {t("gettingStarted.chat.send")}
                  </button>
                </form>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 px-5 py-12 text-center">
                <p className="max-w-sm text-sm text-slate-500">{t("gettingStarted.chat.noEmployeeBody")}</p>
                <Link
                  href="/ai-studio?tab=team"
                  onClick={() => track("setup_cta_clicked", { item: "create_ai_employee", surface: "chat_card" })}
                  className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  {t("gettingStarted.chat.createCta")}
                </Link>
              </div>
            )}
          </div>
        </section>

        {/* ── Setup checklist: the five canonical actions ── */}
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            {t("setupChecklist.title")}
          </h2>
          <ol className="space-y-2">
            {milestones.map((m) => (
              <ActionRow key={m.id} m={m} />
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

// One setup action: what's left, why it matters, its live status, and a
// primary CTA that opens the exact flow. Completed items switch to a quiet
// "done" look with a small Manage link - never the setup CTA again.
function ActionRow({ m }: { m: JourneyMilestone }) {
  const { t } = useI18n();
  const done = m.done;
  const attention = m.state === "attention";
  const inProgress = m.state === "in_progress";
  const active = m.status === "active" && !attention;

  const why = attention
    ? t(`setupChecklist.items.${m.id}.attention`) || t(`setupChecklist.items.${m.id}.why`)
    : inProgress
      ? t(`setupChecklist.items.${m.id}.inProgress`) || t(`setupChecklist.items.${m.id}.why`)
      : t(`setupChecklist.items.${m.id}.why`);
  const ctaLabel = attention ? t("setupChecklist.fix") : t(`setupChecklist.items.${m.id}.cta`);
  const statusLabel = done
    ? t("setupChecklist.status.done")
    : attention
      ? t("setupChecklist.status.attention")
      : inProgress
        ? t("setupChecklist.status.inProgress")
        : t("setupChecklist.status.notStarted");

  return (
    <li
      className={clsx(
        "rounded-xl border px-4 py-3 transition",
        done && "border-emerald-100 bg-emerald-50/50",
        attention && !done && "border-amber-200 bg-amber-50/50",
        active && !attention && "border-indigo-200 bg-indigo-50/60 shadow-sm",
        !done && !active && !attention && "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm",
            done ? "bg-emerald-500 text-white" : attention ? "bg-amber-100" : active ? "bg-indigo-100" : "bg-slate-100",
          )}
        >
          {done ? "✓" : attention ? "!" : MILESTONE_ICONS[m.id] || "•"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx("text-sm font-medium", done ? "text-emerald-700" : "text-slate-800")}>
              {t(`setupChecklist.items.${m.id}.title`)}
            </span>
            <span
              className={clsx(
                "ms-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                done && "bg-emerald-100 text-emerald-700",
                attention && !done && "bg-amber-100 text-amber-700",
                inProgress && !done && !attention && "bg-indigo-100 text-indigo-700",
                !done && !attention && !inProgress && "bg-slate-100 text-slate-500",
              )}
            >
              {statusLabel}
            </span>
          </div>
          {!done && <p className="mt-0.5 text-xs leading-snug text-slate-500">{why}</p>}
          {!done && m.hint && (
            <p className="mt-0.5 truncate text-[11px] text-slate-400" dir="ltr">{m.hint}</p>
          )}
          <div className="mt-2 flex items-center gap-3">
            {!done ? (
              <Link
                href={m.deepLink}
                onClick={() => track("setup_cta_clicked", { item: m.id, state: m.state, surface: "getting_started" })}
                className={clsx(
                  "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition",
                  attention ? "bg-amber-500 hover:bg-amber-600" : "bg-indigo-600 hover:bg-indigo-700",
                )}
              >
                {ctaLabel}
              </Link>
            ) : (
              <Link
                href={m.manageLink || m.deepLink}
                onClick={() => track("setup_cta_clicked", { item: m.id, state: "done", surface: "getting_started" })}
                className="text-xs font-medium text-emerald-700 underline-offset-2 hover:underline"
              >
                {t("setupChecklist.manage")}
              </Link>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
