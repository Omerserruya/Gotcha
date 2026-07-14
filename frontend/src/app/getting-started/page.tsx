"use client";

// Getting Started - the premium post-onboarding "first steps" journey.
//
// Replaces the old spotlight tour as the landing surface for a fresh tenant:
// instead of a tour of empty rooms, the owner lands on a page that (a) shows
// what their AI employee already knows, (b) lets them TALK to it immediately
// (the hero action - value in under a minute, zero setup), and (c) walks the
// five milestones from "meet your employee" to "first real customer answered".
// All milestone state is live-derived server-side (GET /onboarding/journey);
// only `first_chat` is marked here, via the existing guides mechanism, because
// test-chat is deliberately stateless.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getOnboardingJourney,
  patchOnboardingGuide,
  testAgentChat,
  type JourneyData,
  type JourneyMilestone,
} from "@/lib/api";
import { setJourneyIncompleteCache } from "@/lib/journey-cache";

type ChatMsg = { role: "user" | "assistant"; content: string };

const MILESTONE_ICONS: Record<string, string> = {
  meet_employee: "👋",
  first_chat: "💬",
  go_live_channel: "📡",
  first_customer: "🎉",
  teach_knowledge: "📚",
};

const FEATURES: Array<{ id: string; href: string; icon: string }> = [
  { id: "inbox", href: "/conversations", icon: "📥" },
  { id: "business", href: "/settings/business", icon: "🏢" },
  { id: "aiStudio", href: "/ai-studio", icon: "✨" },
  { id: "channels", href: "/channels", icon: "📡" },
  { id: "knowledge", href: "/ai-studio/knowledge", icon: "📚" },
  { id: "analytics", href: "/analytics", icon: "📊" },
];

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

  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);

  // chat state
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const firstChatMarked = useRef(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await getOnboardingJourney(token);
      setJourney(r.data);
      setJourneyIncompleteCache(!r.data.complete); // keep Sidebar/root redirect in sync
    } catch {
      /* page degrades gracefully */
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.replace("/conversations");
      return;
    }
    load();
  }, [user, router, load]);

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
    // The milestone completes on the first ATTEMPT to talk - the point is the
    // owner engaging, and the guide write must not depend on LLM success.
    if (!firstChatMarked.current) {
      firstChatMarked.current = true;
      patchOnboardingGuide(token, "first_chat", "done").then(() => load()).catch(() => {});
    }
    try {
      const r = await testAgentChat(token, employee.id, msg, history);
      setMessages((m) => [...m, { role: "assistant", content: r.data.reply }]);
    } catch {
      setChatError(t("gettingStarted.chat.error"));
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  const milestones = journey?.milestones || [];
  const doneCount = milestones.filter((m) => m.status === "done").length;
  const bizName = journey?.business?.name;
  const suggestions = [
    t("gettingStarted.chat.s1"),
    t("gettingStarted.chat.s2"),
    t("gettingStarted.chat.s3"),
  ];

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
        {/* progress ring */}
        <div className="hidden shrink-0 flex-col items-center sm:flex">
          <div className="relative h-20 w-20">
            <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e2e8f0" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="15.9" fill="none" stroke="#6366f1" strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${(doneCount / Math.max(milestones.length, 1)) * 100} 100`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-700">
              {doneCount}/{milestones.length}
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
                  href="/ai-studio"
                  className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  {t("gettingStarted.chat.createCta")}
                </Link>
              </div>
            )}
          </div>
        </section>

        {/* ── Milestones ── */}
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            {t("gettingStarted.milestones.title")}
          </h2>
          <ol className="space-y-2">
            {milestones.map((m) => (
              <MilestoneRow key={m.id} m={m} />
            ))}
          </ol>
        </section>
      </div>

      {/* ── Core features ── */}
      <section className="mt-12">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          {t("gettingStarted.features.title")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {FEATURES.map((f) => (
            <Link
              key={f.id}
              href={f.href}
              className="group rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow"
            >
              <div className="mb-2 text-2xl">{f.icon}</div>
              <div className="text-sm font-medium text-slate-700 group-hover:text-indigo-600">
                {t(`gettingStarted.features.${f.id}`)}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function MilestoneRow({ m }: { m: JourneyMilestone }) {
  const { t } = useI18n();
  const done = m.status === "done";
  const active = m.status === "active";
  return (
    <li>
      <Link
        href={m.deepLink}
        className={clsx(
          "flex items-center gap-3 rounded-xl border px-4 py-3 transition",
          done && "border-emerald-100 bg-emerald-50/50",
          active && "border-indigo-200 bg-indigo-50/60 shadow-sm hover:bg-indigo-50",
          !done && !active && "border-slate-200 bg-white opacity-70 hover:opacity-100",
        )}
      >
        <span
          className={clsx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm",
            done ? "bg-emerald-500 text-white" : active ? "bg-indigo-100" : "bg-slate-100",
          )}
        >
          {done ? "✓" : MILESTONE_ICONS[m.id] || "•"}
        </span>
        <span className="min-w-0 flex-1">
          <span className={clsx("block text-sm font-medium", done ? "text-emerald-700" : "text-slate-800")}>
            {t(`gettingStarted.milestones.${m.id}.title`)}
          </span>
          {!done && (
            <span className="block truncate text-xs text-slate-400">
              {m.hint || t(`gettingStarted.milestones.${m.id}.desc`)}
            </span>
          )}
        </span>
        {active && (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
          </span>
        )}
      </Link>
    </li>
  );
}
