"use client";

import { useState } from "react";
import { submitWaitlistEntry } from "@/lib/api";

/**
 * Embedded early-access form for the landing CTA — a lightweight version of
 * /early-access asking only name, phone and industry. Submits to the same
 * waitlist endpoint with source "landing-cta".
 */
export default function CtaForm({ t, isRtl }: { t: (key: string, vars?: Record<string, string>) => string; isRtl: boolean }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [industry, setIndustry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const f = (k: string) => t(`landing.cta.form.${k}`);

  // Reuse the industry list from the full early-access form.
  const opts = t("earlyAccess.steps.companyDomain.options") as unknown;
  const industries: { value: string; label: string }[] =
    opts && typeof opts === "object"
      ? Object.entries(opts as Record<string, string>).map(([value, label]) => ({ value, label }))
      : [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError(f("errName")); return; }
    if (phone.replace(/\D/g, "").length < 7) { setError(f("errPhone")); return; }

    setSubmitting(true);
    try {
      await submitWaitlistEntry({
        firstName: name.trim(),
        phone: phone.trim(),
        company: industries.find((o) => o.value === industry)?.label || undefined,
        source: "landing-cta",
      });
      setSubmitted(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      setError(/already on the waitlist|409/.test(msg) ? f("errAlready") : f("errGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-colors focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15";

  return (
    <section className="py-20 sm:py-36 px-4 sm:px-6">
      <div className="max-w-xl mx-auto text-center">
        <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-4">
          {t("landing.cta.title")}
        </h2>
        <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed mb-8">
          {t("landing.cta.subtitle")}
        </p>

        <div className="relative rounded-3xl border border-gray-100 bg-white p-6 sm:p-8 shadow-[0_30px_80px_-32px_rgba(124,92,252,0.45)] text-start">
          {/* soft brand glow */}
          <div className="pointer-events-none absolute -inset-px rounded-3xl" style={{ background: "linear-gradient(140deg,rgba(124,92,252,0.10),transparent 45%)" }} />

          {submitted ? (
            <div className="relative ea-pop-in flex flex-col items-center text-center py-6">
              <div className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center mb-4">
                <svg width="30" height="30" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="#22c55e" strokeWidth="2.5" />
                  <path d="M12 20.5l5.5 5.5L28 15" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ea-check-draw" />
                </svg>
              </div>
              <p className="text-lg font-semibold text-gray-900">{f("successTitle")}</p>
              <p className="text-sm text-gray-500 mt-1">{f("successMsg")}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="relative space-y-3" dir={isRtl ? "rtl" : "ltr"} noValidate>
              <div className="grid sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={f("namePlaceholder")}
                  autoComplete="name"
                  className={fieldClass}
                />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={f("phonePlaceholder")}
                  autoComplete="tel"
                  dir="ltr"
                  className={`${fieldClass} ${isRtl ? "text-right" : ""}`}
                />
              </div>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className={`${fieldClass} cursor-pointer appearance-none bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M2%204l4%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-no-repeat ${isRtl ? "bg-[left_1rem_center]" : "bg-[right_1rem_center]"} ${industry ? "text-gray-900" : "text-gray-400"}`}
              >
                <option value="" disabled>{f("industryPlaceholder")}</option>
                {industries.map((o) => (
                  <option key={o.value} value={o.value} className="text-gray-900">{o.label}</option>
                ))}
              </select>

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-3.5 text-[15px] font-semibold text-white bg-primary-500 rounded-xl hover:bg-primary-600 transition-all duration-200 hover:scale-[1.01] disabled:opacity-60 disabled:hover:scale-100"
                style={{ boxShadow: "0 4px 20px rgba(124,92,252,0.25)" }}
              >
                {submitting ? f("submitting") : f("submit")}
              </button>
              <p className="text-[12px] text-gray-400 text-center pt-0.5">{f("privacy")}</p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
