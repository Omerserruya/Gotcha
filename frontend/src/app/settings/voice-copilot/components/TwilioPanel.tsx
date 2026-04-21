"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";

const CONFIG_URL = "/api/ai-assist/voice-copilot/config";
const TEST_URL = "/api/ai-assist/voice-copilot/twilio/test";
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/;

type TestStatus = "idle" | "testing" | "ok" | "err";

export function TwilioPanel() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    fetch(CONFIG_URL, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const twilio = data?.twilio ?? {};
        setAccountSid(twilio.accountSid ?? "");
        setPhoneNumber(twilio.phoneNumber ?? "");
        setWebhookUrl(twilio.webhookUrl ?? "");
      })
      .catch(() => setError(t("settings.voiceCopilot.errors.loadFailed")))
      .finally(() => setLoading(false));
  }, [token]);

  function validatePhone(val: string): boolean {
    if (!PHONE_REGEX.test(val)) {
      setPhoneError(t("settings.voiceCopilot.errors.invalidPhone"));
      return false;
    }
    setPhoneError(null);
    return true;
  }

  async function handleTest() {
    if (!token) return;
    setTestStatus("testing");
    setTestMessage("");
    try {
      const res = await fetch(TEST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountSid, authToken }),
      });
      const data = await res.json();
      if (res.status === 401 || !data.ok) {
        setTestStatus("err");
        setTestMessage(
          t("settings.voiceCopilot.twilio.testErr", {
            reason: data.reason ?? String(res.status),
          })
        );
      } else {
        setTestStatus("ok");
        setTestMessage(
          t("settings.voiceCopilot.twilio.testOk", {
            name: data.friendlyName ?? accountSid,
          })
        );
      }
    } catch {
      setTestStatus("err");
      setTestMessage(
        t("settings.voiceCopilot.twilio.testErr", { reason: "network" })
      );
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (phoneNumber && !validatePhone(phoneNumber)) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        twilio: { accountSid, phoneNumber },
      };
      if (authToken) (body.twilio as Record<string, unknown>).authToken = authToken;

      const res = await fetch(CONFIG_URL, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setError(t("settings.voiceCopilot.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center">
        {t("app.loading")}
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {error && (
        <div className="px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {/* Account SID */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.twilio.accountSid")}
        </label>
        <input
          type="text"
          value={accountSid}
          onChange={(e) => setAccountSid(e.target.value)}
          className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
      </div>

      {/* Auth Token */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.twilio.authToken")}
        </label>
        <input
          type="password"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder="••••••••"
          className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
      </div>

      {/* Phone Number */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.twilio.phoneNumber")}
        </label>
        <input
          type="text"
          value={phoneNumber}
          onChange={(e) => {
            setPhoneNumber(e.target.value);
            setPhoneError(null);
          }}
          onBlur={(e) => {
            if (e.target.value) validatePhone(e.target.value);
          }}
          placeholder={t("settings.voiceCopilot.twilio.phoneNumberPlaceholder")}
          className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        {phoneError && (
          <p className="mt-1 text-xs text-red-600">{phoneError}</p>
        )}
      </div>

      {/* Webhook URL (read-only) */}
      {webhookUrl && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("settings.voiceCopilot.twilio.webhookUrl")}
          </label>
          <div className="flex items-center gap-2 max-w-md">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              {copied
                ? t("settings.voiceCopilot.twilio.copied")
                : t("settings.voiceCopilot.twilio.copy")}
            </button>
          </div>
        </div>
      )}

      {/* Test status */}
      {testStatus !== "idle" && (
        <div
          className={`px-4 py-2 text-sm rounded-lg border ${
            testStatus === "ok"
              ? "bg-green-50 border-green-200 text-green-700"
              : testStatus === "err"
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-gray-50 border-gray-200 text-gray-600"
          }`}
        >
          {testStatus === "testing"
            ? t("settings.voiceCopilot.twilio.testing")
            : testMessage}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition disabled:opacity-50"
        >
          {t("settings.voiceCopilot.twilio.save")}
        </button>
        <button
          type="button"
          disabled={testStatus === "testing"}
          onClick={handleTest}
          className="px-4 py-2 text-sm font-medium text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg transition disabled:opacity-50"
        >
          {testStatus === "testing"
            ? t("settings.voiceCopilot.twilio.testing")
            : t("settings.voiceCopilot.twilio.test")}
        </button>
      </div>
    </form>
  );
}
