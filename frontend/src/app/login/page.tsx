"use client";

import { useState, FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { login as apiLogin, systemLogin as apiSystemLogin } from "@/lib/api";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export default function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isSystemAdmin) {
        const result = await apiSystemLogin(email, password);
        login(result.token, result.user);
        router.push("/system");
      } else {
        const result = await apiLogin(email, password, tenantSlug);
        login(result.token, result.user);
        router.push("/conversations");
      }
    } catch (err: any) {
      setError(err.message || t("auth.loginError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-500 via-primary-600 to-primary-800 p-4">
      <div className="absolute top-4 end-4">
        <LanguageSwitcher />
      </div>

      {/* Decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -end-40 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -start-40 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-md relative">
        <div className="bg-white rounded-3xl shadow-2xl p-8">
          {/* Logo / Header */}
          <div className="text-center mb-8">
            <Image src="/apple-touch-icon.png" alt="GOTCHA" width={64} height={64} className="w-16 h-16 rounded-2xl mx-auto mb-4 shadow-lg shadow-primary-500/25" />
            <h1 className="text-2xl font-bold text-gray-900">{t("app.name")}</h1>
            <p className="text-gray-400 mt-1 text-sm">{t("auth.welcome")}</p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              {error}
            </div>
          )}

          {/* System Admin Toggle */}
          <div className="flex items-center justify-center mb-2">
            <button
              type="button"
              onClick={() => setIsSystemAdmin(!isSystemAdmin)}
              className="text-xs text-gray-400 hover:text-primary-500 transition"
            >
              {isSystemAdmin ? "Back to tenant login" : "System Admin Login"}
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {!isSystemAdmin && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t("auth.tenant")}
                </label>
                <input
                  type="text"
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  placeholder="demo-company"
                  required
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("auth.email")}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@demo.com"
                required
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("auth.password")}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="********"
                required
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary-500/25 text-sm"
            >
              {loading ? t("common.loading") : t("auth.loginButton")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
