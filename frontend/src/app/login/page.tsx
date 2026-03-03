"use client";

import { useState, FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { login as apiLogin, systemLogin as apiSystemLogin, forgotPassword as apiForgotPassword } from "@/lib/api";
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
  const [showPassword, setShowPassword] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotTenantSlug, setForgotTenantSlug] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState("");
  const [forgotError, setForgotError] = useState("");

  async function handleForgotPassword(e: FormEvent) {
    e.preventDefault();
    setForgotError("");
    setForgotMessage("");
    setForgotLoading(true);
    try {
      const result = await apiForgotPassword(forgotEmail, forgotTenantSlug);
      setForgotMessage(result.message || "If an account exists, a reset link has been sent.");
      setForgotEmail("");
      setForgotTenantSlug("");
    } catch (err: any) {
      setForgotError(err.message || "Failed to send reset link");
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isSystemAdmin) {
        const result = await apiSystemLogin(email, password);
        login(result.token, result.user, (result as any).refreshToken);
        router.push("/system");
      } else {
        const result = await apiLogin(email, password, tenantSlug);
        login(result.token, result.user, result.refreshToken);
        // Redirect to setup wizard if tenant onboarding is not complete
        const tenantStatus = (result as any).tenantStatus;
        if (tenantStatus && tenantStatus !== "ACTIVE" && result.user.role === "ADMIN") {
          router.push("/setup");
        } else if (tenantStatus && tenantStatus !== "ACTIVE") {
          setError("Your organization setup is not complete. Please contact your admin.");
          return;
        } else {
          router.push("/conversations");
        }
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
            <Image src="/apple-touch-icon.png" alt="GOTCHA" width={64} height={64} className="w-16 h-16 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900">{t("app.name")}</h1>
            <p className="text-gray-400 mt-1 text-sm">{t("auth.welcome")}</p>
          </div>

          {showForgotPassword ? (
            <>
              <div className="mb-5">
                <button
                  type="button"
                  onClick={() => { setShowForgotPassword(false); setForgotMessage(""); setForgotError(""); }}
                  className="text-xs text-gray-400 hover:text-primary-500 transition flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                  </svg>
                  Back to login
                </button>
                <h2 className="text-lg font-semibold text-gray-900 mt-3">Forgot Password</h2>
                <p className="text-xs text-gray-400 mt-1">Enter your email and workspace slug to receive a reset link.</p>
              </div>

              {forgotMessage && (
                <div className="mb-4 p-3 rounded-xl bg-green-50 text-green-700 text-sm">
                  {forgotMessage}
                </div>
              )}
              {forgotError && (
                <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm">
                  {forgotError}
                </div>
              )}

              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {t("auth.tenant")}
                  </label>
                  <input
                    type="text"
                    value={forgotTenantSlug}
                    onChange={(e) => setForgotTenantSlug(e.target.value)}
                    placeholder="demo-company"
                    required
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {t("auth.email")}
                  </label>
                  <input
                    type="email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="admin@demo.com"
                    required
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary-500/25 text-sm"
                >
                  {forgotLoading ? t("common.loading") : "Send Reset Link"}
                </button>
              </form>
            </>
          ) : (
            <>
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
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="********"
                      required
                      className="w-full px-4 py-2.5 pe-10 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {!isSystemAdmin && (
                    <div className="flex justify-end mt-1.5">
                      <button
                        type="button"
                        onClick={() => setShowForgotPassword(true)}
                        className="text-xs text-primary-500 hover:text-primary-600 transition"
                      >
                        Forgot password?
                      </button>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary-500/25 text-sm"
                >
                  {loading ? t("common.loading") : t("auth.loginButton")}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
