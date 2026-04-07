"use client";

import { useState, useEffect, useRef, useCallback, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import ConfirmModal from "@/components/ConfirmModal";
import {
  getOnboardingStatus,
  saveBusinessProfile,
  saveOnboardingDepartments,
  completeOnboarding,
  getChannels,
  connectWhatsApp,
  disconnectChannel,
  updateAutoGreeting,
  updateSlaSettings,
  updateBusinessHours,
  updateIdleAutomation,
  sendOnboardingChatMessage,
  generateOnboardingConfigs,
} from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || "";
const EMBEDDED_SIGNUP_CONFIG_ID = process.env.NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || "";

const INDUSTRIES = [
  "E-Commerce", "SaaS / Technology", "Healthcare", "Finance & Banking",
  "Education", "Real Estate", "Travel & Hospitality", "Retail",
  "Telecommunications", "Insurance", "Logistics", "Food & Beverage", "Other",
];

const BUSINESS_PRIORITIES = [
  { value: "MAXIMIZE_SALES", label: "Maximize Sales", desc: "Focus on lead conversion and revenue growth" },
  { value: "FAST_RESPONSE", label: "Fast Response Time", desc: "Minimize wait times and resolve quickly" },
  { value: "PREMIUM_EXPERIENCE", label: "Premium Customer Experience", desc: "Deliver personalized, high-touch service" },
  { value: "REDUCE_WORKLOAD", label: "Reduce Workload", desc: "Automate repetitive tasks and inquiries" },
];

const AI_MODES = [
  { value: "COPILOT", label: "Copilot", desc: "AI suggests responses, agents send manually" },
  { value: "AUTONOMOUS", label: "Autonomous", desc: "AI responds automatically, escalates when uncertain" },
  { value: "HYBRID", label: "Hybrid", desc: "AI auto-responds to simple queries, suggests for complex ones" },
];

const DEFAULT_DEPARTMENTS = [
  { name: "Sales", description: "Handle sales inquiries and lead qualification" },
  { name: "Customer Support", description: "Resolve customer issues and answer questions" },
  { name: "Technical Support", description: "Diagnose and solve technical problems" },
  { name: "Operations", description: "Manage operational requests and workflows" },
];

const TIMEZONES = [
  "Asia/Jerusalem", "Europe/London", "Europe/Berlin", "Europe/Paris",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Dubai", "Australia/Sydney", "Pacific/Auckland",
];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY_LABELS: Record<string, string> = {
  sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed",
  thursday: "Thu", friday: "Fri", saturday: "Sat",
};

interface DepartmentConfig {
  name: string;
  description: string;
  queueMode: string;
  slaTarget: number;
  escalateOnSlaBreach: boolean;
  aiSuggestionsEnabled: boolean;
  autoRepliesEnabled: boolean;
}

export default function SetupWizardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div>}>
      <SetupWizardContent />
    </Suspense>
  );
}

function SetupWizardContent() {
  const { user, token, isLoading } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();

  const [step, setStep] = useState<"loading" | "business_profile" | "departments" | "ai_config" | "connect_platforms" | "completing" | "done">("loading");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Connect Platforms state
  const [channels, setChannels] = useState<any[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [platformMessage, setPlatformMessage] = useState("");
  const [platformMessageType, setPlatformMessageType] = useState<"success" | "error">("success");
  const [disconnectConfirm, setDisconnectConfirm] = useState<{ open: boolean; id: string }>({ open: false, id: "" });
  const [disconnecting, setDisconnecting] = useState(false);
  const sessionInfoRef = useRef<{ wabaId?: string; phoneNumberId?: string }>({});
  const searchParams = useSearchParams();

  // Business Profile state
  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("");
  const [dailyConversations, setDailyConversations] = useState(100);
  const [numAgents, setNumAgents] = useState(5);
  // Tenant-level automation settings state
  const [slaMinutes, setSlaMinutes] = useState(30);
  const [autoGreetingEnabled, setAutoGreetingEnabled] = useState(true);
  const [autoGreetingMessage, setAutoGreetingMessage] = useState("Hello! I'm {agentName}, how can I help you today?");
  const [businessHoursEnabled, setBusinessHoursEnabled] = useState(false);
  const [businessHoursTimezone, setBusinessHoursTimezone] = useState("Asia/Jerusalem");
  const [businessHoursSchedule, setBusinessHoursSchedule] = useState<Record<string, { enabled: boolean; open?: string; close?: string }>>({
    sunday:    { enabled: true, open: "09:00", close: "18:00" },
    monday:    { enabled: true, open: "09:00", close: "18:00" },
    tuesday:   { enabled: true, open: "09:00", close: "18:00" },
    wednesday: { enabled: true, open: "09:00", close: "18:00" },
    thursday:  { enabled: true, open: "09:00", close: "18:00" },
    friday:    { enabled: false },
    saturday:  { enabled: false },
  });
  const [businessHoursAutoResponse, setBusinessHoursAutoResponse] = useState("We're currently outside business hours. We'll get back to you as soon as we're open!");
  const [autoCloseEnabled, setAutoCloseEnabled] = useState(false);
  const [autoCloseMinutes, setAutoCloseMinutes] = useState(1440);
  const [autoCloseMessage, setAutoCloseMessage] = useState("Due to the lack of response, this conversation has been closed. Feel free to reach out again anytime!");
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderDelayMinutes, setReminderDelayMinutes] = useState(60);
  const [reminderMessage, setReminderMessage] = useState("Hi! We're still here and waiting for your response. Is there anything else we can help you with?");

  // Departments state
  const [departments, setDepartments] = useState<DepartmentConfig[]>([]);
  const [selectedDefaults, setSelectedDefaults] = useState<Set<string>>(new Set(["Sales", "Customer Support"]));

  // AI Config chat state
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [configsGenerated, setConfigsGenerated] = useState(false);
  const [generatingConfigs, setGeneratingConfigs] = useState(false);
  const [generatedConfigs, setGeneratedConfigs] = useState<any[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Check onboarding status on mount
  useEffect(() => {
    if (isLoading) return;
    if (!user || !token) { router.push("/login?redirect=setup"); return; }
    if (user.role !== "ADMIN") { router.push("/conversations"); return; }

    getOnboardingStatus(token)
      .then((res) => {
        const data = res.data;
        if (data.tenant.status === "ACTIVE") {
          router.push("/conversations");
          return;
        }
        if (data.businessProfileCompleted && data.onboarding.currentStep === "COMPLETED") {
          setStep("departments");
        } else if (data.businessProfileCompleted) {
          setStep("departments");
        } else {
          setStep("business_profile");
        }
        if (data.tenant.name) setOrgName(data.tenant.name);
      })
      .catch(() => setStep("business_profile"));
  }, [user, token, isLoading, router]);

  async function handleSaveBusinessProfile(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");
    setSaving(true);
    try {
      // Save business profile to DB
      await saveBusinessProfile(token, {
        organizationName: orgName,
        industry,
        businessDescription: description,
        businessPriority: priority,
        estimatedDailyConversations: dailyConversations,
        numberOfAgents: numAgents,
      });

      // Save tenant-level automation settings to Redis via settings APIs
      await Promise.all([
        updateSlaSettings(token, { enabled: true, slaMinutes, warningThreshold: 70 }),
        autoGreetingEnabled && autoGreetingMessage
          ? updateAutoGreeting(token, autoGreetingMessage)
          : updateAutoGreeting(token, ""),
        businessHoursEnabled
          ? updateBusinessHours(token, {
              enabled: true,
              timezone: businessHoursTimezone,
              autoResponse: businessHoursAutoResponse,
              schedule: businessHoursSchedule,
            })
          : updateBusinessHours(token, {
              enabled: false,
              timezone: businessHoursTimezone,
              autoResponse: businessHoursAutoResponse,
              schedule: businessHoursSchedule,
            }),
        updateIdleAutomation(token, {
          reminderEnabled,
          reminderDelayMinutes,
          reminderMessage,
          autoCloseEnabled,
          autoCloseDelayMinutes: autoCloseMinutes,
          autoCloseMessage,
        }),
      ]);

      // Initialize departments from selected defaults
      const depts = Array.from(selectedDefaults).map((name) => {
        const def = DEFAULT_DEPARTMENTS.find((d) => d.name === name);
        return {
          name,
          description: def?.description || "",
          queueMode: "ROUND_ROBIN",
          slaTarget: slaMinutes,
          escalateOnSlaBreach: false,
          aiSuggestionsEnabled: true,
          autoRepliesEnabled: false,
        } as DepartmentConfig;
      });
      setDepartments(depts.length > 0 ? depts : [{
        name: "General",
        description: "General department",
        queueMode: "CLAIM",
        slaTarget: slaMinutes,
        escalateOnSlaBreach: false,
        aiSuggestionsEnabled: true,
        autoRepliesEnabled: false,
      }]);
      setStep("departments");
    } catch (err: any) {
      setError(err.message || "Failed to save business profile");
    } finally {
      setSaving(false);
    }
  }

  function updateDepartment(index: number, field: string, value: any) {
    setDepartments((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function addCustomDepartment() {
    setDepartments((prev) => [...prev, {
      name: "",
      description: "",
      queueMode: "CLAIM",
      slaTarget: slaMinutes,
      escalateOnSlaBreach: false,
      aiSuggestionsEnabled: true,
      autoRepliesEnabled: false,
    }]);
  }

  function removeDepartment(index: number) {
    if (departments.length <= 1) return;
    setDepartments((prev) => prev.filter((_, i) => i !== index));
  }

  // ─── Connect Platforms: Load Facebook SDK ─────────────────
  useEffect(() => {
    if (step !== "connect_platforms") return;
    if (document.getElementById("facebook-jssdk")) return;
    (window as any).fbAsyncInit = function () {
      (window as any).FB.init({
        appId: META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: "v25.0",
      });
    };
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  }, [step]);

  // ─── Connect Platforms: WA_EMBEDDED_SIGNUP listener ───────
  useEffect(() => {
    if (step !== "connect_platforms") return;
    function handleMessage(event: MessageEvent) {
      if (!event.origin.endsWith("facebook.com")) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "WA_EMBEDDED_SIGNUP") {
          if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
            sessionInfoRef.current = {
              wabaId: data.data?.waba_id,
              phoneNumberId: data.data?.phone_number_id,
            };
          }
        }
      } catch { /* Non-JSON message from Facebook */ }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [step]);

  // ─── Connect Platforms: fetch connected channels ──────────
  const fetchChannels = useCallback(async () => {
    if (!token) return;
    setChannelsLoading(true);
    try {
      const res = await getChannels(token);
      setChannels(res.data || []);
    } catch { /* ignore */ } finally {
      setChannelsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (step === "connect_platforms") fetchChannels();
  }, [step, fetchChannels]);

  // ─── Connect Platforms: handle OAuth callback via URL params
  useEffect(() => {
    if (step !== "connect_platforms") return;
    const connected = searchParams.get("connected");
    const oauthError = searchParams.get("error");
    if (connected) {
      setPlatformMessage("Channel connected successfully!");
      setPlatformMessageType("success");
      fetchChannels();
      window.history.replaceState({}, "", "/setup");
    } else if (oauthError) {
      setPlatformMessage("Failed to connect channel. Please try again.");
      setPlatformMessageType("error");
      window.history.replaceState({}, "", "/setup");
    }
  }, [step, searchParams, fetchChannels]);

  function handleConnectWhatsApp() {
    if (!token) return;
    const FB = (window as any).FB;
    if (!FB) {
      setPlatformMessage("Facebook SDK not loaded. Please refresh the page.");
      setPlatformMessageType("error");
      return;
    }
    sessionInfoRef.current = {};
    setConnecting(true);
    FB.login(
      (response: any) => {
        if (!response.authResponse?.code) {
          setConnecting(false);
          return;
        }
        const code = response.authResponse.code;
        setTimeout(() => {
          const sessionInfo = sessionInfoRef.current;
          connectWhatsApp(token, code, sessionInfo)
            .then(() => {
              setPlatformMessage("WhatsApp connected successfully!");
              setPlatformMessageType("success");
              fetchChannels();
            })
            .catch((err: any) => {
              setPlatformMessage(err.message || "Failed to connect WhatsApp");
              setPlatformMessageType("error");
            })
            .finally(() => setConnecting(false));
        }, 500);
      },
      {
        config_id: EMBEDDED_SIGNUP_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          version: "v3",
        },
      }
    );
  }

  function handleOAuthConnect(platform: "messenger" | "instagram" | "gmail" | "outlook" | "slack") {
    if (!token) return;
    window.location.href = `${API_URL}/api/channels/oauth/init?platform=${platform}&token=${token}`;
  }

  function openDisconnectConfirm(id: string) {
    setDisconnectConfirm({ open: true, id });
  }

  async function confirmDisconnect() {
    if (!token) return;
    setDisconnecting(true);
    try {
      await disconnectChannel(token, disconnectConfirm.id);
      setDisconnectConfirm({ open: false, id: "" });
      setPlatformMessage("Channel disconnected.");
      setPlatformMessageType("success");
      fetchChannels();
    } catch (err: any) {
      setPlatformMessage(err.message || "Failed to disconnect");
      setPlatformMessageType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleCompleteSetup() {
    if (!token) return;
    setError("");
    setStep("completing");
    try {
      await completeOnboarding(token);
      setStep("done");
    } catch (err: any) {
      setError(err.message || "Failed to complete setup");
      setStep("connect_platforms");
    }
  }

  async function handleSaveDepartments(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");

    // Validate
    for (const dept of departments) {
      if (!dept.name.trim()) { setError(t("setup.allDeptsMustHaveName")); return; }
    }

    const names = departments.map((d) => d.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) { setError(t("setup.deptNamesMustBeUnique")); return; }

    setSaving(true);
    try {
      await saveOnboardingDepartments(token, { departments });
      setStep("ai_config");
    } catch (err: any) {
      setError(err.message || "Failed to save departments");
    } finally {
      setSaving(false);
    }
  }

  // Chat scroll effect
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Auto-start chat when ai_config step loads
  useEffect(() => {
    if (step === "ai_config" && chatMessages.length === 0 && token) {
      setChatSending(true);
      sendOnboardingChatMessage(token, { message: "Start configuring my AI copilot.", context: { locale } })
        .then(res => setChatMessages([{ role: "assistant", content: res.data.reply }]))
        .catch(() => setChatMessages([{ role: "assistant", content: t("setup.aiChatFallbackIntro") }]))
        .finally(() => setChatSending(false));
    }
  }, [step]);

  async function triggerGenerateConfigs() {
    if (!token || generatingConfigs || configsGenerated) return;
    setGeneratingConfigs(true);
    try {
      const res = await generateOnboardingConfigs(token);
      setConfigsGenerated(true);
      setGeneratedConfigs(res.data.configs || []);
      setChatMessages(prev => [...prev, {
        role: "assistant",
        content: `Done! I've created AI configurations for **${res.data.departmentsConfigured}** department(s). Each one has a customized system prompt, identity, goals, tone, and behavioral rules tailored to your business.\n\nYou can review and edit these anytime from the Co-Pilot settings page.\n\nClick **"Continue"** to proceed to connecting your messaging platforms.`
      }]);
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: "assistant", content: `${t("setup.aiChatGenerateError")}: ${err.message}` }]);
    } finally {
      setGeneratingConfigs(false);
    }
  }

  async function handleSendChatMessage(e: FormEvent) {
    e.preventDefault();
    if (!token || !chatInput.trim() || chatSending) return;

    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setChatSending(true);

    try {
      const res = await sendOnboardingChatMessage(token, {
        message: userMsg,
        context: { chatHistory: chatMessages, locale }
      });
      setChatMessages(prev => [...prev, { role: "assistant", content: res.data.reply }]);

      // AI decided it has enough info - auto-trigger generation
      if (res.data.readyToGenerate) {
        setTimeout(() => triggerGenerateConfigs(), 1500);
      }
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: "assistant", content: t("setup.aiChatError") }]);
    } finally {
      setChatSending(false);
    }
  }

  if (step === "loading" || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (step === "completing") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">{t("setup.settingUpWorkspace")}</h2>
          <p className="text-gray-500 mt-2">{t("setup.generatingAgentConfigs")}</p>
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md text-center bg-white rounded-2xl shadow-lg p-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{t("setup.setupComplete")}</h2>
          <p className="text-gray-500 mb-6">
            {t("setup.setupCompleteDesc")}
          </p>
          <button
            onClick={() => router.push("/conversations")}
            className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition shadow-lg shadow-primary-500/25"
          >
            {t("setup.goToDashboard")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">{t("setup.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("setup.subtitle")}</p>
          {/* Step indicator */}
          <div className="flex items-center gap-3 mt-4">
            <div className={`flex items-center gap-2 text-sm font-medium ${step === "business_profile" ? "text-primary-600" : "text-green-600"}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step === "business_profile" ? "bg-primary-100 text-primary-600" : "bg-green-100 text-green-600"}`}>
                {step === "business_profile" ? "1" : "\u2713"}
              </div>
              {t("setup.stepBusinessProfile")}
            </div>
            <div className="flex-1 h-px bg-gray-200" />
            <div className={`flex items-center gap-2 text-sm font-medium ${step === "departments" ? "text-primary-600" : (step === "ai_config" || step === "connect_platforms") ? "text-green-600" : "text-gray-400"}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step === "departments" ? "bg-primary-100 text-primary-600" : (step === "ai_config" || step === "connect_platforms") ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                {(step === "ai_config" || step === "connect_platforms") ? "\u2713" : "2"}
              </div>
              {t("setup.stepDepartments")}
            </div>
            <div className="flex-1 h-px bg-gray-200" />
            <div className={`flex items-center gap-2 text-sm font-medium ${step === "ai_config" ? "text-primary-600" : step === "connect_platforms" ? "text-green-600" : "text-gray-400"}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step === "ai_config" ? "bg-primary-100 text-primary-600" : step === "connect_platforms" ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                {step === "connect_platforms" ? "\u2713" : "3"}
              </div>
              {t("setup.stepAiConfig")}
            </div>
            <div className="flex-1 h-px bg-gray-200" />
            <div className={`flex items-center gap-2 text-sm font-medium ${step === "connect_platforms" ? "text-primary-600" : "text-gray-400"}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step === "connect_platforms" ? "bg-primary-100 text-primary-600" : "bg-gray-100 text-gray-400"}`}>
                4
              </div>
              {t("setup.stepConnectPlatforms")}
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="max-w-3xl mx-auto px-6 mt-4">
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>
        </div>
      )}

      {/* Step A: Business Profile */}
      {step === "business_profile" && (
        <form onSubmit={handleSaveBusinessProfile} className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border p-6 space-y-5">
            <h2 className="text-lg font-semibold text-gray-900">{t("setup.businessProfile")}</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.orgName")}</label>
              <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} required
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.industry")}</label>
              <select value={industry} onChange={(e) => setIndustry(e.target.value)} required
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm">
                <option value="">{t("setup.selectIndustry")}</option>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{t(`setup.industries.${i}`) || i}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.businessDescription")}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} required rows={3}
                placeholder={t("setup.businessDescPlaceholder")}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t("setup.businessPriority")}</label>
              <div className="grid grid-cols-2 gap-3">
                {BUSINESS_PRIORITIES.map((p) => (
                  <button key={p.value} type="button" onClick={() => setPriority(p.value)}
                    className={`p-3 rounded-xl border text-left transition ${priority === p.value ? "border-primary-500 bg-primary-50 ring-2 ring-primary-200" : "border-gray-200 hover:border-gray-300"}`}>
                    <div className="text-sm font-medium text-gray-900">{t(`setup.priorities.${p.value}`)}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{t(`setup.priorities.${p.value}_DESC`)}</div>
                  </button>
                ))}
              </div>
              {!priority && <input type="text" required value="" className="opacity-0 h-0 w-0 absolute" tabIndex={-1} onChange={() => {}} />}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.estDailyConversations")}</label>
                <input type="number" value={dailyConversations} onChange={(e) => setDailyConversations(parseInt(e.target.value) || 0)} min={1} required
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.numberOfAgents")}</label>
                <input type="number" value={numAgents} onChange={(e) => setNumAgents(parseInt(e.target.value) || 0)} min={1} required
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm" />
              </div>
            </div>

          </div>

          {/* Department selection preview */}
          <div className="bg-white rounded-2xl shadow-sm border p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t("setup.selectDepartments")}</h2>
            <p className="text-sm text-gray-500">{t("setup.selectDepartmentsDesc")}</p>
            <div className="grid grid-cols-2 gap-3">
              {DEFAULT_DEPARTMENTS.map((d) => (
                <button key={d.name} type="button"
                  onClick={() => {
                    setSelectedDefaults((prev) => {
                      const next = new Set(prev);
                      if (next.has(d.name)) next.delete(d.name); else next.add(d.name);
                      return next;
                    });
                  }}
                  className={`p-3 rounded-xl border text-left transition ${selectedDefaults.has(d.name) ? "border-primary-500 bg-primary-50 ring-2 ring-primary-200" : "border-gray-200 hover:border-gray-300"}`}>
                  <div className="text-sm font-medium text-gray-900">{t(`setup.defaultDepartments.${d.name}`) || d.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{t(`setup.defaultDepartments.${d.name}Desc`) || d.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Automation Settings (Tenant Level) */}
          <div className="bg-white rounded-2xl shadow-sm border p-6 space-y-5">
            <h2 className="text-lg font-semibold text-gray-900">{t("setup.automationSettings")}</h2>
            <p className="text-sm text-gray-500">{t("setup.automationSettingsDesc")}</p>

            {/* SLA */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.slaResponseTime")}</label>
              <input type="number" value={slaMinutes} onChange={(e) => setSlaMinutes(parseInt(e.target.value) || 30)} min={1} max={1440}
                className="w-full max-w-xs px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm" />
              <p className="text-xs text-gray-400 mt-1">{t("setup.slaResponseTimeDesc")}</p>
            </div>

            {/* Auto-Greeting */}
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <input type="checkbox" checked={autoGreetingEnabled} onChange={(e) => setAutoGreetingEnabled(e.target.checked)}
                  className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                {t("setup.autoGreeting")}
              </label>
              {autoGreetingEnabled && (
                <div>
                  <textarea value={autoGreetingMessage} onChange={(e) => setAutoGreetingMessage(e.target.value)} rows={2}
                    placeholder="Hello! I'm {agentName}, how can I help you today?"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none" />
                  <p className="text-xs text-gray-400 mt-1">Use <code className="bg-gray-100 px-1 rounded">{"{agentName}"}</code> to include the agent&apos;s name</p>
                </div>
              )}
            </div>

            {/* Business Hours */}
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <input type="checkbox" checked={businessHoursEnabled} onChange={(e) => setBusinessHoursEnabled(e.target.checked)}
                  className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                {t("setup.businessHours")}
              </label>
              {businessHoursEnabled && (
                <div className="space-y-3 ml-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.timezone")}</label>
                    <select value={businessHoursTimezone} onChange={(e) => setBusinessHoursTimezone(e.target.value)}
                      className="w-full max-w-xs px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none">
                      {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    {DAY_NAMES.map((day) => (
                      <div key={day} className="flex items-center gap-3">
                        <label className="flex items-center gap-1.5 w-16 text-xs">
                          <input type="checkbox" checked={businessHoursSchedule[day]?.enabled || false}
                            onChange={(e) => setBusinessHoursSchedule((prev) => ({ ...prev, [day]: { ...prev[day], enabled: e.target.checked } }))}
                            className="rounded border-gray-300 text-primary-500 focus:ring-primary-500 w-3.5 h-3.5" />
                          <span className="text-gray-600 font-medium">{DAY_LABELS[day]}</span>
                        </label>
                        {businessHoursSchedule[day]?.enabled && (
                          <>
                            <input type="time" value={businessHoursSchedule[day]?.open || "09:00"}
                              onChange={(e) => setBusinessHoursSchedule((prev) => ({ ...prev, [day]: { ...prev[day], open: e.target.value } }))}
                              className="px-2 py-1 border border-gray-200 rounded-lg text-xs bg-gray-50" />
                            <span className="text-xs text-gray-400">to</span>
                            <input type="time" value={businessHoursSchedule[day]?.close || "18:00"}
                              onChange={(e) => setBusinessHoursSchedule((prev) => ({ ...prev, [day]: { ...prev[day], close: e.target.value } }))}
                              className="px-2 py-1 border border-gray-200 rounded-lg text-xs bg-gray-50" />
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.outsideHoursResponse")}</label>
                    <textarea value={businessHoursAutoResponse} onChange={(e) => setBusinessHoursAutoResponse(e.target.value)} rows={2}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none resize-none" />
                  </div>
                </div>
              )}
            </div>

            {/* Auto-Reminder */}
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <input type="checkbox" checked={reminderEnabled} onChange={(e) => setReminderEnabled(e.target.checked)}
                  className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                {t("setup.autoReminder")}
              </label>
              {reminderEnabled && (
                <div className="space-y-2 ml-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.sendReminderAfter")}</label>
                    <input type="number" value={reminderDelayMinutes} onChange={(e) => setReminderDelayMinutes(parseInt(e.target.value) || 60)} min={1} max={10080}
                      className="w-full max-w-xs px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.reminderMessage")}</label>
                    <textarea value={reminderMessage} onChange={(e) => setReminderMessage(e.target.value)} rows={2}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none resize-none" />
                  </div>
                </div>
              )}
            </div>

            {/* Auto-Close */}
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <input type="checkbox" checked={autoCloseEnabled} onChange={(e) => setAutoCloseEnabled(e.target.checked)}
                  className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                {t("setup.autoClose")}
              </label>
              {autoCloseEnabled && (
                <div className="space-y-2 ml-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.closeAfterInactivity")}</label>
                    <input type="number" value={autoCloseMinutes} onChange={(e) => setAutoCloseMinutes(parseInt(e.target.value) || 1440)} min={1} max={10080}
                      className="w-full max-w-xs px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t("setup.closeMessage")}</label>
                    <textarea value={autoCloseMessage} onChange={(e) => setAutoCloseMessage(e.target.value)} rows={2}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none resize-none" />
                  </div>
                </div>
              )}
            </div>
          </div>

          <button type="submit" disabled={saving}
            className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25">
            {saving ? t("common.loading") : t("setup.continueToDepartments")}
          </button>
        </form>
      )}

      {/* Step B: Department Configuration */}
      {step === "departments" && (
        <form onSubmit={handleSaveDepartments} className="max-w-3xl mx-auto px-6 py-6 space-y-4">
          <div className="bg-primary-50 border border-primary-200 rounded-xl px-4 py-3 text-sm text-primary-700">
            {t("setup.deptConfigNote")}
          </div>
          {departments.map((dept, idx) => (
            <div key={idx} className="bg-white rounded-2xl shadow-sm border p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">
                  {dept.name || `Department ${idx + 1}`}
                </h3>
                {departments.length > 1 && (
                  <button type="button" onClick={() => removeDepartment(idx)}
                    className="text-sm text-red-500 hover:text-red-700 transition">
                    {t("setup.remove")}
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.departmentName")}</label>
                <input type="text" value={dept.name} onChange={(e) => updateDepartment(idx, "name", e.target.value)} required
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.queueMode")}</label>
                <div className="flex gap-2">
                  {[{ value: "ROUND_ROBIN" }, { value: "CLAIM" }].map((m) => (
                    <button key={m.value} type="button" onClick={() => updateDepartment(idx, "queueMode", m.value)}
                      className={`flex-1 py-2 px-3 rounded-lg border text-xs font-medium transition ${dept.queueMode === m.value ? "border-primary-500 bg-primary-50 text-primary-700" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}>
                      {m.value === "ROUND_ROBIN" ? t("departments.roundRobin") : t("departments.claim")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Department-specific toggles */}
              <div className="border-t pt-4 space-y-3">
                <h4 className="text-sm font-medium text-gray-700">{t("setup.departmentOptions")}</h4>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={dept.escalateOnSlaBreach}
                      onChange={(e) => updateDepartment(idx, "escalateOnSlaBreach", e.target.checked)}
                      className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                    <span className="text-gray-700">{t("setup.escalateOnSlaBreach")}</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={dept.aiSuggestionsEnabled}
                      onChange={(e) => updateDepartment(idx, "aiSuggestionsEnabled", e.target.checked)}
                      className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                    <span className="text-gray-700">{t("setup.aiSuggestions")}</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={dept.autoRepliesEnabled}
                      onChange={(e) => updateDepartment(idx, "autoRepliesEnabled", e.target.checked)}
                      className="rounded border-gray-300 text-primary-500 focus:ring-primary-500" />
                    <span className="text-gray-700">{t("setup.autoReplies")}</span>
                  </label>
                </div>
              </div>
            </div>
          ))}

          <button type="button" onClick={addCustomDepartment}
            className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:text-primary-600 hover:border-primary-300 transition">
            {t("setup.addCustomDepartment")}
          </button>

          <div className="flex gap-3">
            <button type="button" onClick={() => setStep("business_profile")}
              className="flex-1 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-xl transition">
              {t("common.back")}
            </button>
            <button type="submit" disabled={saving}
              className="flex-[2] py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25">
              {saving ? t("common.loading") : t("setup.continueToConnect")}
            </button>
          </div>
        </form>
      )}

      {/* Step C: AI Configuration */}
      {step === "ai_config" && (
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
          {/* Chat Container */}
          <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
            <div className="bg-gradient-to-r from-primary-500 to-violet-500 px-6 py-4 text-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-lg">{t("setup.aiConfigTitle")}</h3>
                  <p className="text-white/80 text-sm">{t("setup.aiConfigSubtitle")}</p>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="h-[400px] overflow-y-auto p-4 space-y-3 bg-gray-50">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-primary-500 text-white rounded-br-md"
                      : "bg-white border border-gray-200 text-gray-700 rounded-bl-md shadow-sm"
                  }`}>
                    {msg.content.split('\n').map((line, li) => (
                      <span key={li}>
                        {line.replace(/\*\*(.*?)\*\*/g, '$1')}
                        {li < msg.content.split('\n').length - 1 && <br />}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {chatSending && (
                <div className="flex justify-start">
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                    <div className="flex gap-1.5">
                      <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="border-t bg-white p-3">
              <form onSubmit={handleSendChatMessage} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={t("setup.typeMessage")}
                  disabled={chatSending}
                  className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={chatSending || !chatInput.trim()}
                  className="w-10 h-10 bg-primary-500 hover:bg-primary-600 text-white rounded-xl flex items-center justify-center transition disabled:opacity-40"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              </form>
            </div>
          </div>

          {/* Generating indicator */}
          {generatingConfigs && (
            <div className="flex items-center gap-3 px-4 py-3 bg-violet-50 border border-violet-200 rounded-xl">
              <div className="w-5 h-5 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
              <span className="text-sm text-violet-700 font-medium">{t("setup.generatingConfigs")}</span>
            </div>
          )}

          {/* Generated Configs Preview */}
          {configsGenerated && generatedConfigs.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-3">
              <h3 className="font-semibold text-gray-900">{t("setup.generatedConfigs")}</h3>
              <div className="space-y-2">
                {generatedConfigs.map((cfg: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{cfg.departmentName}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {[cfg.hasIdentity && "Identity", cfg.hasGoals && "Goals", cfg.hasTone && "Tone", cfg.hasBehavioral && "Behavioral"].filter(Boolean).join(" + ")}
                      </p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 bg-green-50 text-green-600 rounded-full ring-1 ring-green-200 font-medium">{t("setup.configured")}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400">{t("setup.generatedConfigsDesc")}</p>
            </div>
          )}

          {/* Continue button - after generation */}
          {configsGenerated && (
            <button
              type="button"
              onClick={() => setStep("connect_platforms")}
              className="w-full flex items-center justify-center gap-2 py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition shadow-lg shadow-primary-500/25"
            >
              {t("setup.continueToConnectPlatforms")}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setStep("departments")}
              className="text-sm text-gray-400 hover:text-gray-600 transition"
            >
              {t("setup.backToDepartments")}
            </button>
            {!configsGenerated && !generatingConfigs && (
              <button
                type="button"
                onClick={() => setStep("connect_platforms")}
                className="text-sm text-gray-400 hover:text-gray-600 transition"
              >
                {t("setup.skipForNow")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step D: Connect Platforms */}
      {step === "connect_platforms" && (
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t("setup.connectPlatforms")}</h2>
            <p className="text-sm text-gray-500">
              {t("setup.connectPlatformsDesc")}
            </p>

            {/* Platform message toast */}
            {platformMessage && (
              <div className={`text-sm px-4 py-2.5 rounded-xl border ${
                platformMessageType === "success"
                  ? "bg-green-50 text-green-700 border-green-200"
                  : "bg-red-50 text-red-700 border-red-200"
              }`}>
                {platformMessage}
              </div>
            )}

            {/* Platform cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* WhatsApp */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.whatsapp")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.whatsappDesc")}</p>
                </div>
                <button
                  onClick={handleConnectWhatsApp}
                  disabled={connecting}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium disabled:opacity-40 w-full"
                >
                  {connecting ? t("setup.connecting") : t("setup.connect")}
                </button>
              </div>

              {/* Messenger */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2.04c-5.5 0-10 4.49-10 10.02 0 5 3.66 9.15 8.44 9.9v-7H7.9v-2.9h2.54V9.85c0-2.52 1.49-3.93 3.78-3.93 1.09 0 2.23.19 2.23.19v2.47h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.9h-2.33v7a10 10 0 008.44-9.9c0-5.53-4.5-10.02-10-10.02z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.messenger")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.messengerDesc")}</p>
                </div>
                <button
                  onClick={() => handleOAuthConnect("messenger")}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium w-full"
                >
                  {t("setup.connect")}
                </button>
              </div>

              {/* Instagram */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-pink-50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-pink-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.instagram")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.instagramDesc")}</p>
                </div>
                <button
                  onClick={() => handleOAuthConnect("instagram")}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium w-full"
                >
                  {t("setup.connect")}
                </button>
              </div>

              {/* Gmail */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73l-6.546 4.91-6.546-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.gmail")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.gmailDesc")}</p>
                </div>
                <button
                  onClick={() => handleOAuthConnect("gmail")}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium w-full"
                >
                  {t("setup.connect")}
                </button>
              </div>

              {/* Outlook */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-blue-600" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 7.387v10.478c0 .23-.08.424-.238.576a.806.806 0 01-.587.234h-8.327v-6.408l1.674 1.258a.39.39 0 00.494 0l.005-.004 6.98-5.282V7.387zm-11.5 7.863L.493 5.534a.39.39 0 01.005-.648l.086-.058A1.91 1.91 0 011.636 4.5h20.728c.38 0 .726.113 1.052.328l.086.058a.39.39 0 01.005.648L12.5 15.25a.78.78 0 01-.996 0zM0 7.387v11.478c0 .23.08.424.238.576a.806.806 0 00.587.234h8.327v-6.408L7.478 14.525a.39.39 0 01-.494 0l-.005-.004L0 9.24V7.387z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.outlook")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.outlookDesc")}</p>
                </div>
                <button
                  onClick={() => handleOAuthConnect("outlook")}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium w-full"
                >
                  {t("setup.connect")}
                </button>
              </div>

              {/* Slack */}
              <div className="rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="#E01E5A">
                    <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 012.52-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.52V8.834zm-1.268 0a2.528 2.528 0 01-2.524 2.521 2.528 2.528 0 01-2.52-2.521V2.522A2.528 2.528 0 0115.165 0a2.528 2.528 0 012.524 2.522v6.312zm-2.524 10.124a2.528 2.528 0 012.524 2.52A2.528 2.528 0 0115.165 24a2.528 2.528 0 01-2.52-2.522v-2.52h2.52zm0-1.268a2.528 2.528 0 01-2.52-2.524 2.528 2.528 0 012.52-2.52h6.313A2.528 2.528 0 0124 15.165a2.528 2.528 0 01-2.522 2.524h-6.313z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-900">{t("setup.slack")}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{t("setup.slackDesc")}</p>
                </div>
                <button
                  onClick={() => handleOAuthConnect("slack")}
                  className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium w-full"
                >
                  {t("setup.connect")}
                </button>
              </div>
            </div>
          </div>

          {/* Connected channels list */}
          {channelsLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : channels.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border p-6">
              <h3 className="font-semibold text-sm text-gray-900 mb-3">{t("setup.connectedChannels")}</h3>
              <div className="space-y-2">
                {channels.map((ch) => (
                  <div key={ch.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white ${
                      ch.channel === "WHATSAPP" ? "bg-green-500" :
                      ch.channel === "MESSENGER" ? "bg-blue-500" :
                      ch.channel === "INSTAGRAM" ? "bg-pink-500" :
                      ch.channel === "GMAIL" ? "bg-red-500" :
                      ch.channel === "OUTLOOK" ? "bg-blue-600" :
                      ch.channel === "SLACK" ? "bg-purple-500" : "bg-gray-500"
                    }`}>
                      {ch.channel === "WHATSAPP" ? "WA" :
                       ch.channel === "MESSENGER" ? "FB" :
                       ch.channel === "INSTAGRAM" ? "IG" :
                       ch.channel === "GMAIL" ? "GM" :
                       ch.channel === "OUTLOOK" ? "OL" :
                       ch.channel === "SLACK" ? "SL" : "??"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-gray-900">{ch.displayName}</p>
                      <p className="text-xs text-gray-400">{ch.externalId}</p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 bg-green-50 text-green-600 ring-green-200">
                      {t("setup.connected")}
                    </span>
                    <button
                      onClick={() => openDisconnectConfirm(ch.id)}
                      className="text-xs text-red-500 hover:text-red-700 transition p-1"
                      title={t("common.disconnect")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-3">
            <button
              onClick={handleCompleteSetup}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition shadow-lg shadow-primary-500/25"
            >
              {t("setup.completeSetup")}
            </button>
            <button
              onClick={handleCompleteSetup}
              className="w-full text-sm text-gray-400 hover:text-gray-600 transition py-2"
            >
              {t("setup.skipForNow")}
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={disconnectConfirm.open}
        title={t("confirm.disconnectTitle")}
        message={t("confirm.disconnectChannelMsg")}
        confirmText={t("common.disconnect")}
        danger
        loading={disconnecting}
        onConfirm={confirmDisconnect}
        onCancel={() => setDisconnectConfirm({ open: false, id: "" })}
      />
    </div>
  );
}
