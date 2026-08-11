"use client";

// Getting Started - the post-onboarding "first steps" page.
//
// The page has ONE job: get the owner through the setup actions that take
// their workspace live, and make it obvious which one to do next.
//
// It used to lead with a sandbox chat against the AI employee. That is a
// rehearsal, not a first step: it changes nothing about readiness, it cannot
// be completed, and it took the top two thirds of the page from the five
// actions that actually move the workspace forward. Testing an employee lives
// where the employee lives (AI Studio), not on the setup page.
//
// The checklist is the SAME canonical journey the sidebar panel and nav badge
// read (lib/journey-cache.ts -> GET /onboarding/journey): same items, same
// labels, same counts, same completion definitions - never computed locally.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { type JourneyData, type JourneyMilestone } from "@/lib/api";
import { getCachedJourney, refreshJourney, subscribeJourney } from "@/lib/journey-cache";
import { track } from "@/lib/analytics";
import { nextAction } from "@/lib/first-steps";

// One icon per canonical milestone. Line icons rather than emoji: they inherit
// the step's colour, so a step reads as done / needs-attention / next at a
// glance instead of every row shouting the same brightness.
const MILESTONE_ICONS: Record<string, React.ReactNode> = {
  connect_source_of_truth: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  ),
  connect_channel: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
  ),
  connect_knowledge: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
  ),
  create_ai_employee: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
  ),
  create_process: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.007-1.875 2.25-1.875s2.25.84 2.25 1.875c0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z" />
  ),
};

/** Where "explore the platform" sends people, once setup is under way. */
const EXPLORE_LINKS: { key: string; href: string; icon: React.ReactNode }[] = [
  {
    key: "inbox",
    href: "/conversations",
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />,
  },
  {
    key: "aiStudio",
    href: "/ai-studio",
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />,
  },
  {
    key: "channels",
    href: "/channels",
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />,
  },
  {
    key: "knowledge",
    href: "/ai-studio?tab=knowledge",
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />,
  },
  {
    key: "analytics",
    href: "/analytics",
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />,
  },
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

  const [journey, setJourney] = useState<JourneyData | null>(getCachedJourney());
  const [loading, setLoading] = useState(!getCachedJourney());
  const [loadError, setLoadError] = useState(false);
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

  const milestones = journey?.milestones || [];
  const doneCount = journey?.summary?.done ?? milestones.filter((m) => m.done).length;
  const totalCount = journey?.summary?.total ?? milestones.length;
  const bizName = journey?.business?.name;
  const next = nextAction(milestones);
  const allDone = totalCount > 0 && doneCount >= totalCount;
  const pct = Math.round((doneCount / Math.max(totalCount, 1)) * 100);

  // Stable skeleton while readiness resolves - never a flash of "everything
  // incomplete" from local guesses.
  if (loading) {
    return (
      <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-10">
        <div className="mb-8 space-y-3">
          <div className="h-9 w-2/3 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-4 w-1/2 animate-pulse rounded-lg bg-slate-100" />
        </div>
        <div className="mb-8 h-40 animate-pulse rounded-3xl bg-slate-100" />
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />
          ))}
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
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-10">
      {/* ── Header ── */}
      <header className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          <Image src="/logo_icon.png" alt="GOTCHA" width={40} height={40} className="rounded-xl" />
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {bizName
              ? t("gettingStarted.titleWithBiz").replace("{business}", bizName)
              : t("gettingStarted.title")}
          </h1>
        </div>
        <p className="max-w-2xl text-slate-500">{t("gettingStarted.subtitle")}</p>

        {/* Progress: one bar, the same numbers the sidebar panel and nav badge
            show. A bar rather than a ring because it carries the count inline
            and does not need to hide on small screens. */}
        <div className="mt-6 max-w-md">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("gettingStarted.progress")}
            </span>
            <span className="text-xs font-medium text-slate-500">
              {t("gettingStarted.progressCount")
                .replace("{done}", String(doneCount))
                .replace("{total}", String(totalCount))}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={clsx(
                "h-full rounded-full transition-all duration-500",
                allDone ? "bg-emerald-500" : "bg-indigo-500",
              )}
              style={{ width: `${Math.max(pct, doneCount > 0 ? 6 : 0)}%` }}
              role="progressbar"
              aria-valuenow={doneCount}
              aria-valuemin={0}
              aria-valuemax={totalCount}
            />
          </div>
        </div>

        {/* What the AI already has - earned context, not empty promises. */}
        {(journey?.context?.coreSystem ||
          (journey?.context?.kbCount ?? 0) > 0 ||
          (journey?.context?.detectedChannelCount ?? 0) > 0) && (
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
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
        )}
      </header>

      {/* ── Up next, or the finished state ── */}
      {allDone ? (
        <section className="mb-10 rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-7">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-2xl text-white">
              ✓
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-slate-900">{t("gettingStarted.allDoneTitle")}</h2>
              <p className="mt-1 max-w-xl text-sm text-slate-600">{t("gettingStarted.allDoneBody")}</p>
              <Link
                href="/conversations"
                onClick={() => track("setup_cta_clicked", { item: "all_done", surface: "getting_started" })}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
              >
                {t("gettingStarted.allDoneCta")}
              </Link>
            </div>
          </div>
        </section>
      ) : next ? (
        <section className="mb-10 rounded-3xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-7">
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-500">
            {t("gettingStarted.upNext")}
          </span>
          <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-center">
            <span
              className={clsx(
                "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl",
                next.state === "attention" ? "bg-amber-100 text-amber-600" : "bg-indigo-100 text-indigo-600",
              )}
            >
              <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                {MILESTONE_ICONS[next.id] ?? null}
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold text-slate-900">
                {t(`setupChecklist.items.${next.id}.title`)}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{whyFor(t, next)}</p>
              {next.hint && (
                <p className="mt-1 truncate text-xs text-slate-400" dir="ltr">{next.hint}</p>
              )}
            </div>
            <Link
              href={next.deepLink}
              onClick={() =>
                track("setup_cta_clicked", { item: next.id, state: next.state, surface: "getting_started_next" })
              }
              className={clsx(
                "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-sm transition",
                next.state === "attention"
                  ? "bg-amber-500 hover:bg-amber-600"
                  : "bg-indigo-600 hover:bg-indigo-700",
              )}
            >
              {next.state === "attention" ? t("setupChecklist.fix") : t(`setupChecklist.items.${next.id}.cta`)}
              <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      ) : null}

      {/* ── Every step ── */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {t("gettingStarted.milestones.title")}
          </h2>
          <button
            onClick={() => window.dispatchEvent(new Event("gotcha:start-tour"))}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
          >
            ✨ {t("gettingStarted.tourCta")}
          </button>
        </div>
        <ol className="space-y-3">
          {milestones.map((m, i) => (
            <ActionRow key={m.id} m={m} index={i + 1} isNext={!allDone && next?.id === m.id} />
          ))}
        </ol>
      </section>

      {/* ── Explore the platform ── */}
      <section className="mt-12 border-t border-slate-100 pt-8">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          {t("gettingStarted.features.title")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {EXPLORE_LINKS.map((f) => (
            <Link
              key={f.key}
              href={f.href}
              onClick={() => track("setup_cta_clicked", { item: `explore_${f.key}`, surface: "getting_started" })}
              className="group flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-4 text-center transition hover:border-indigo-200 hover:bg-indigo-50/40"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition group-hover:bg-indigo-100 group-hover:text-indigo-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                  {f.icon}
                </svg>
              </span>
              <span className="text-xs font-medium text-slate-600 group-hover:text-indigo-700">
                {t(`gettingStarted.features.${f.key}`)}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

/** The line under a step's title, which depends on the state it is in. */
function whyFor(t: (key: string) => string, m: JourneyMilestone): string {
  if (m.state === "attention") {
    return t(`setupChecklist.items.${m.id}.attention`) || t(`setupChecklist.items.${m.id}.why`);
  }
  if (m.state === "in_progress") {
    return t(`setupChecklist.items.${m.id}.inProgress`) || t(`setupChecklist.items.${m.id}.why`);
  }
  return t(`setupChecklist.items.${m.id}.why`);
}

// One setup action: what's left, why it matters, its live status, and a
// primary CTA that opens the exact flow. Completed items switch to a quiet
// "done" look with a small Manage link - never the setup CTA again.
function ActionRow({ m, index, isNext }: { m: JourneyMilestone; index: number; isNext: boolean }) {
  const { t } = useI18n();
  const done = m.done;
  const attention = m.state === "attention";
  const inProgress = m.state === "in_progress";

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
        "rounded-2xl border px-5 py-4 transition",
        done && "border-slate-100 bg-slate-50/60",
        attention && !done && "border-amber-200 bg-amber-50/50",
        isNext && !attention && "border-indigo-200 bg-white shadow-sm",
        !done && !isNext && !attention && "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-start gap-4">
        {/* Step marker: a tick when done, otherwise the step's own icon. The
            number keeps the sequence readable when several are complete. */}
        <span
          className={clsx(
            "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            done
              ? "bg-emerald-500 text-white"
              : attention
                ? "bg-amber-100 text-amber-600"
                : isNext
                  ? "bg-indigo-100 text-indigo-600"
                  : "bg-slate-100 text-slate-400",
          )}
        >
          {done ? (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
              {MILESTONE_ICONS[m.id] ?? null}
            </svg>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tabular-nums text-slate-300">
              {String(index).padStart(2, "0")}
            </span>
            <span className={clsx("text-sm font-semibold", done ? "text-slate-500" : "text-slate-900")}>
              {t(`setupChecklist.items.${m.id}.title`)}
            </span>
            <span
              className={clsx(
                "ms-auto shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
                done && "bg-emerald-50 text-emerald-600",
                attention && !done && "bg-amber-100 text-amber-700",
                inProgress && !done && !attention && "bg-indigo-100 text-indigo-700",
                !done && !attention && !inProgress && "bg-slate-100 text-slate-500",
              )}
            >
              {statusLabel}
            </span>
          </div>

          {!done && <p className="mt-1 text-xs leading-relaxed text-slate-500">{whyFor(t, m)}</p>}
          {!done && m.hint && (
            <p className="mt-0.5 truncate text-[11px] text-slate-400" dir="ltr">{m.hint}</p>
          )}

          <div className="mt-2.5 flex items-center gap-3">
            {!done ? (
              <Link
                href={m.deepLink}
                onClick={() => track("setup_cta_clicked", { item: m.id, state: m.state, surface: "getting_started" })}
                className={clsx(
                  "inline-flex items-center rounded-lg px-3.5 py-1.5 text-xs font-semibold transition",
                  attention
                    ? "bg-amber-500 text-white hover:bg-amber-600"
                    : isNext
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-indigo-600",
                )}
              >
                {ctaLabel}
              </Link>
            ) : (
              <Link
                href={m.manageLink || m.deepLink}
                onClick={() => track("setup_cta_clicked", { item: m.id, state: "done", surface: "getting_started" })}
                className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-indigo-600 hover:underline"
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
