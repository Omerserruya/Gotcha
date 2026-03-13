"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import { submitWaitlistEntry } from "@/lib/api";

/* ─── Step config ─────────────────────────────────────────── */

type StepType = "text" | "email" | "tel" | "select" | "textarea";

interface StepConfig {
  key: string;
  type: StepType;
  required: boolean;
}

const STEPS: StepConfig[] = [
  { key: "firstName", type: "text", required: true },
  { key: "email", type: "email", required: true },
  { key: "phone", type: "tel", required: false },
  { key: "role", type: "select", required: true },
  { key: "companySize", type: "select", required: true },
  { key: "companyDomain", type: "select", required: true },
  { key: "frustration", type: "textarea", required: false },
];

/* ─── Component ───────────────────────────────────────────── */

export default function EarlyAccessForm() {
  const { t, dir } = useI18n();

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const [formData, setFormData] = useState<Record<string, string>>({
    firstName: "",
    email: "",
    phone: "",
    role: "",
    companySize: "",
    companyDomain: "",
    frustration: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  // Auto-focus input on step change
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [step]);

  /* ─── Helpers ─────────────────────────────────────────── */

  const currentStep = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  function getOptions(key: string): { value: string; label: string }[] {
    const opts = t(`earlyAccess.steps.${key}.options`) as unknown;
    if (!opts || typeof opts !== "object") return [];
    return Object.entries(opts as Record<string, string>).map(([value, label]) => ({
      value,
      label,
    }));
  }

  function validate(): boolean {
    const cfg = currentStep;
    const value = formData[cfg.key]?.trim() ?? "";

    if (cfg.required && !value) {
      setErrors({ [cfg.key]: t("earlyAccess.errors.required") });
      return false;
    }

    if (cfg.type === "email" && value) {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(value)) {
        setErrors({ [cfg.key]: t("earlyAccess.errors.invalidEmail") });
        return false;
      }
    }

    setErrors({});
    return true;
  }

  /* ─── Navigation ──────────────────────────────────────── */

  const goNext = useCallback(async () => {
    if (!validate()) return;

    if (isLastStep) {
      await handleSubmit();
      return;
    }

    setDirection("forward");
    setStep((s) => s + 1);
  }, [step, formData, isLastStep]);

  function goBack() {
    if (step === 0) return;
    setErrors({});
    setDirection("backward");
    setStep((s) => s - 1);
  }

  function skipStep() {
    if (isLastStep) {
      handleSubmit();
      return;
    }
    setDirection("forward");
    setStep((s) => s + 1);
  }

  /* ─── Submit ──────────────────────────────────────────── */

  async function handleSubmit() {
    if (!validate()) return;
    setIsSubmitting(true);

    try {
      await submitWaitlistEntry({
        firstName: formData.firstName.trim(),
        email: formData.email.trim().toLowerCase(),
        phone: formData.phone?.trim() || undefined,
        role: formData.role,
        companySize: formData.companySize,
        companyDomain: formData.companyDomain,
        frustration: formData.frustration?.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("already on the waitlist") || msg.includes("409")) {
        setErrors({ submit: t("earlyAccess.errors.alreadyOnWaitlist") });
      } else {
        setErrors({ submit: t("earlyAccess.errors.generic") });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  /* ─── Keyboard ────────────────────────────────────────── */

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      goNext();
    }
  }

  /* ─── Thank You Screen ────────────────────────────────── */

  if (submitted) {
    return (
      <div dir={dir} className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <div className="ea-pop-in flex flex-col items-center text-center max-w-md">
          {/* Checkmark circle */}
          <div className="w-20 h-20 rounded-full bg-green-50 flex items-center justify-center mb-6">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="18" stroke="#22c55e" strokeWidth="2.5" />
              <path
                d="M12 20.5l5.5 5.5L28 15"
                stroke="#22c55e"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="ea-check-draw"
              />
            </svg>
          </div>
          {/* Badge */}
          <span className="inline-block px-4 py-1.5 text-xs font-semibold text-primary-600 bg-primary-50 rounded-full mb-4 tracking-wide uppercase">
            {t("earlyAccess.thankYou.badge")}
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 mb-2">
            {t("earlyAccess.thankYou.title")}
          </h1>
          <p className="text-lg text-gray-500 mb-2">
            {t("earlyAccess.thankYou.subtitle")}
          </p>
          <p className="text-sm text-gray-400 mb-8 max-w-xs">
            {t("earlyAccess.thankYou.message")}
          </p>
          <Link
            href="/"
            className="px-6 py-3 text-sm font-semibold text-white bg-primary-500 rounded-2xl hover:bg-primary-600 transition-colors"
          >
            {t("earlyAccess.thankYou.backHome")}
          </Link>
        </div>
      </div>
    );
  }

  /* ─── Step Renderer ───────────────────────────────────── */

  const stepKey = currentStep.key;
  const label = t(`earlyAccess.steps.${stepKey}.label`);
  const placeholder = t(`earlyAccess.steps.${stepKey}.placeholder`);
  const micro = t(`earlyAccess.steps.${stepKey}.micro`);
  const value = formData[stepKey] ?? "";
  const error = errors[stepKey] || errors.submit || "";

  const inputClasses =
    "w-full bg-transparent border-b-2 border-gray-200 focus:border-primary-500 outline-none py-3 text-xl sm:text-2xl text-gray-900 placeholder:text-gray-300 transition-colors";

  function renderInput() {
    switch (currentStep.type) {
      case "select":
        return (
          <select
            ref={inputRef as React.Ref<HTMLSelectElement>}
            value={value}
            onChange={(e) => setFormData((d) => ({ ...d, [stepKey]: e.target.value }))}
            onKeyDown={handleKeyDown}
            className={`${inputClasses} cursor-pointer appearance-none bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M2%204l4%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat`}
          >
            <option value="" disabled>
              {placeholder}
            </option>
            {getOptions(stepKey).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );
      case "textarea":
        return (
          <textarea
            ref={inputRef as React.Ref<HTMLTextAreaElement>}
            value={value}
            onChange={(e) => setFormData((d) => ({ ...d, [stepKey]: e.target.value }))}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={2}
            className={`${inputClasses} resize-none`}
          />
        );
      default:
        return (
          <input
            ref={inputRef as React.Ref<HTMLInputElement>}
            type={currentStep.type}
            value={value}
            onChange={(e) => setFormData((d) => ({ ...d, [stepKey]: e.target.value }))}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={inputClasses}
            autoComplete={currentStep.type === "email" ? "email" : currentStep.type === "tel" ? "tel" : "off"}
          />
        );
    }
  }

  /* ─── Layout ──────────────────────────────────────────── */

  const progress = (step + 1) / STEPS.length;

  return (
    <div dir={dir} className="min-h-screen flex flex-col bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4">
        <Link href="/" className="text-xl font-bold tracking-tight text-gray-900">
          GOTCHA
        </Link>
        <span className="text-xs text-gray-400 font-medium">
          {t("earlyAccess.stepOf", { current: String(step + 1), total: String(STEPS.length) })}
        </span>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-gray-100 mx-6 rounded-full overflow-hidden">
        <div
          className="ea-progress-fill h-full bg-primary-500 rounded-full"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>

      {/* Content area */}
      <main className="flex-1 flex items-center justify-center px-6">
        <div
          key={step}
          className={`w-full max-w-lg ${direction === "forward" ? "ea-step-forward" : "ea-step-backward"}`}
        >
          {/* Step number */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-semibold text-primary-500">
              {step + 1}
            </span>
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-primary-300">
              <path d="M2 1l4 3-4 3" fill="currentColor" />
            </svg>
          </div>

          {/* Label */}
          <h2 className="text-2xl sm:text-3xl font-semibold text-gray-900 mb-2 tracking-tight">
            {label}
          </h2>

          {/* Microcopy */}
          <p className="text-sm text-gray-400 mb-6">{micro}</p>

          {/* Input */}
          {renderInput()}

          {/* Error */}
          {error && (
            <p className="mt-2 text-sm text-red-500">{error}</p>
          )}

          {/* Skip link for optional fields */}
          {!currentStep.required && (
            <button
              onClick={skipStep}
              className="mt-3 text-sm text-gray-400 hover:text-gray-600 transition-colors underline underline-offset-2"
            >
              {t("earlyAccess.skip")}
            </button>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
        {/* Back button */}
        <button
          onClick={goBack}
          disabled={step === 0}
          className={`flex items-center gap-1.5 text-sm font-medium transition-colors ${
            step === 0 ? "text-gray-200 cursor-not-allowed" : "text-gray-500 hover:text-gray-900"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={dir === "rtl" ? "rotate-180" : ""}>
            <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("earlyAccess.back")}
        </button>

        {/* Enter hint */}
        <span className="hidden sm:inline text-xs text-gray-300">
          {t("earlyAccess.pressEnter")} ↵
        </span>

        {/* OK / Submit button */}
        <button
          onClick={goNext}
          disabled={isSubmitting}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-primary-500 rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50"
        >
          {isSubmitting
            ? t("common.saving")
            : isLastStep
              ? t("earlyAccess.submit")
              : t("earlyAccess.ok")}
          {!isSubmitting && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={dir === "rtl" ? "rotate-180" : ""}>
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </footer>
    </div>
  );
}
