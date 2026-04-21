"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { composeAIMessage } from "@/lib/api";
import clsx from "clsx";

type Surface = "template" | "scheduled" | "inbox" | "command-center";

interface ScopeProps {
  surface: Surface;
  channel?: string;
  asTemplate?: boolean;
  conversationId?: string;
  currentValue: string;
  onApply: (text: string) => void;
  children: ReactNode;
  className?: string;
}

interface Ctx {
  surface: Surface;
  open: boolean;
  toggle: () => void;
  close: () => void;
  instruction: string;
  setInstruction: (s: string) => void;
  draft: string | null;
  clearDraft: () => void;
  generating: boolean;
  error: string | null;
  generate: () => Promise<void>;
  apply: () => void;
  hasCurrentValue: boolean;
}

const AIComposeCtx = createContext<Ctx | null>(null);

function useScope(): Ctx {
  const ctx = useContext(AIComposeCtx);
  if (!ctx) throw new Error("AIComposeTrigger/Panel must be used inside <AIComposeScope>");
  return ctx;
}

/**
 * Wraps a form region (label + input + panel). Owns the compose state so
 * <AIComposeTrigger /> (placed by the label) and <AIComposePanel /> (placed
 * below the input) can coordinate. Renders no extra layout itself.
 */
export function AIComposeScope({
  surface,
  channel,
  asTemplate,
  conversationId,
  currentValue,
  onApply,
  children,
  className,
}: ScopeProps) {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) {
        setInstruction("");
        setDraft(null);
        setError(null);
      }
      return next;
    });
  }

  function close() {
    setOpen(false);
  }

  function clearDraft() {
    setDraft(null);
    setError(null);
  }

  async function generate() {
    if (!token || !instruction.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await composeAIMessage(token, {
        instruction: instruction.trim(),
        surface,
        conversationId,
        channel,
        locale,
        currentDraft: currentValue,
        asTemplate,
      });
      setDraft(res.data?.text || "");
    } catch (e: any) {
      setError(e?.message || t("aiCompose.error"));
    } finally {
      setGenerating(false);
    }
  }

  function apply() {
    if (!draft) return;
    onApply(draft);
    setOpen(false);
    setDraft(null);
    setInstruction("");
  }

  const value: Ctx = {
    surface,
    open,
    toggle,
    close,
    instruction,
    setInstruction,
    draft,
    clearDraft,
    generating,
    error,
    generate,
    apply,
    hasCurrentValue: !!currentValue?.trim(),
  };

  return (
    <AIComposeCtx.Provider value={value}>
      {className ? <div className={className}>{children}</div> : children}
    </AIComposeCtx.Provider>
  );
}

export function AIComposeTrigger({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const { open, toggle } = useScope();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-label={t("aiCompose.button")}
      title={t("aiCompose.button")}
      className={clsx(
        "flex items-center gap-1.5 text-xs font-medium transition rounded-lg",
        compact
          ? "w-8 h-8 justify-center text-violet-500 hover:text-violet-700 hover:bg-violet-50"
          : "px-2.5 py-1.5 bg-gradient-to-br from-violet-50 to-purple-50 text-violet-600 hover:from-violet-100 hover:to-purple-100 ring-1 ring-violet-100",
        open && !compact && "from-violet-100 to-purple-100 ring-violet-200",
        open && compact && "bg-violet-100 text-violet-700",
      )}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
      {!compact && <span>{t("aiCompose.button")}</span>}
    </button>
  );
}

export function AIComposePanel() {
  const { t, dir } = useI18n();
  const {
    surface,
    open,
    close,
    instruction,
    setInstruction,
    draft,
    clearDraft,
    generating,
    error,
    generate,
    apply,
    hasCurrentValue,
  } = useScope();

  if (!open) return null;

  const placeholder =
    surface === "template"
      ? t("aiCompose.placeholderTemplate")
      : surface === "scheduled"
        ? t("aiCompose.placeholderScheduled")
        : surface === "inbox"
          ? t("aiCompose.placeholderInbox")
          : t("aiCompose.placeholderDefault");

  return (
    <div
      dir={dir}
      className={clsx(
        "mt-2 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50/60 via-white to-purple-50/40 p-3 shadow-sm",
        dir === "rtl" ? "text-right" : "text-left",
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <span className="text-[11px] font-bold text-violet-700 uppercase tracking-wider">
            {t("aiCompose.title")}
          </span>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-600 w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/70"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {!draft && (
        <>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={placeholder}
            rows={2}
            autoFocus
            dir={dir}
            className={clsx(
              "w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 transition resize-none",
              dir === "rtl" ? "text-right" : "text-left",
            )}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                generate();
              }
            }}
          />
          {hasCurrentValue && (
            <p className="mt-1.5 text-[11px] text-gray-500">
              {t("aiCompose.refineHint")}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-gray-400">{t("aiCompose.shortcutHint")}</span>
            <button
              type="button"
              onClick={generate}
              disabled={!instruction.trim() || generating}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-lg hover:from-violet-600 hover:to-purple-700 transition-all shadow-sm shadow-violet-300/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {generating && (
                <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {generating ? t("aiCompose.generating") : t("aiCompose.generate")}
            </button>
          </div>
        </>
      )}

      {draft && (
        <>
          <div
            dir={dir}
            className={clsx(
              "px-3 py-2.5 bg-white border border-violet-100 rounded-xl text-sm text-gray-800 whitespace-pre-wrap break-words max-h-60 overflow-y-auto",
              dir === "rtl" ? "text-right" : "text-left",
            )}
          >
            {draft}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={clearDraft}
              className="text-xs text-gray-500 hover:text-gray-800 transition"
            >
              {t("aiCompose.tryAgain")}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="px-2.5 py-1.5 text-xs font-medium text-violet-600 bg-white hover:bg-violet-50 border border-violet-100 rounded-lg transition disabled:opacity-40"
              >
                {generating ? "…" : t("aiCompose.regenerate")}
              </button>
              <button
                type="button"
                onClick={apply}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-lg hover:from-violet-600 hover:to-purple-700 transition-all shadow-sm shadow-violet-300/40"
              >
                {t("aiCompose.apply")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
