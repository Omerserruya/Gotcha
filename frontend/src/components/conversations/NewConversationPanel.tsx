"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getChannelAccounts, getContacts, getTemplates, createContact, initiateConversation } from "@/lib/api";
import Image from "next/image";
import clsx from "clsx";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";

interface Props {
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}

type Step = "channel" | "recipient" | "message";
type RecipientMode = "search" | "manual";

const CHANNEL_CONFIG: Record<string, {
  label: string;
  logo: string;
  color: string;
  bg: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  identifierType: string;
  templateOnly: boolean;
  description: string;
}> = {
  // Meta channels (Facebook / Instagram / Messenger) intentionally absent —
  // they don't support business-initiated outbound (Meta only allows DMs
  // inside a 24h messaging window after a user-initiated message). Listing
  // them here would let agents start chats that the platform then rejects.
  WHATSAPP: {
    label: "WhatsApp",
    logo: "/icons/wa.png",
    color: "text-green-600",
    bg: "bg-green-50 border-green-200 hover:bg-green-100",
    identifierLabel: "newConversation.identifier.phone",
    identifierPlaceholder: "+972501234567",
    identifierType: "tel",
    templateOnly: true,
    description: "newConversation.channelDesc.whatsapp",
  },
  GMAIL: {
    label: "Gmail",
    logo: "/icons/gm.png",
    color: "text-red-600",
    bg: "bg-red-50 border-red-200 hover:bg-red-100",
    identifierLabel: "newConversation.identifier.email",
    identifierPlaceholder: "user@example.com",
    identifierType: "email",
    templateOnly: false,
    description: "newConversation.channelDesc.email",
  },
  OUTLOOK: {
    label: "Outlook",
    logo: "/icons/ol.png",
    color: "text-blue-700",
    bg: "bg-sky-50 border-sky-200 hover:bg-sky-100",
    identifierLabel: "newConversation.identifier.email",
    identifierPlaceholder: "user@example.com",
    identifierType: "email",
    templateOnly: false,
    description: "newConversation.channelDesc.email",
  },
  SLACK: {
    label: "Slack",
    logo: "/icons/slk.png",
    color: "text-purple-600",
    bg: "bg-purple-50 border-purple-200 hover:bg-purple-100",
    identifierLabel: "newConversation.identifier.slackId",
    identifierPlaceholder: "U01ABCDEF",
    identifierType: "text",
    templateOnly: false,
    description: "newConversation.channelDesc.slack",
  },
};

export function NewConversationPanel({ onClose, onCreated }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();

  // Step management
  const [step, setStep] = useState<Step>("channel");

  // Channel selection
  const [channelAccounts, setChannelAccounts] = useState<any[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  // Recipient
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("search");
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<any[]>([]);
  const [contactSearchLoading, setContactSearchLoading] = useState(false);
  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [manualIdentifier, setManualIdentifier] = useState("");
  const contactSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Message
  const [messageBody, setMessageBody] = useState("");
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Sending
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Load channel accounts on mount
  useEffect(() => {
    if (!token) return;
    setLoadingAccounts(true);
    getChannelAccounts(token)
      .then((res) => {
        const accounts = Array.isArray(res) ? res : (res as any)?.data || [];
        // Only show active & connected accounts. Hide Meta channels —
        // Facebook/Instagram/Messenger DMs cannot be initiated by the
        // business; outbound is restricted to user-initiated 24h messaging
        // windows, so these never belong in a new-conversation picker.
        const blocked = new Set(["INSTAGRAM", "MESSENGER", "FACEBOOK"]);
        setChannelAccounts(
          accounts.filter(
            (a: any) =>
              a.isActive !== false
              && !blocked.has(String(a.channel || "").toUpperCase()),
          ),
        );
      })
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }, [token]);

  // Group accounts by channel type
  const accountsByChannel = channelAccounts.reduce<Record<string, any[]>>((acc, a) => {
    if (!acc[a.channel]) acc[a.channel] = [];
    acc[a.channel].push(a);
    return acc;
  }, {});

  // Debounced contact search
  useEffect(() => {
    if (recipientMode !== "search" || !token) return;
    if (contactSearchRef.current) clearTimeout(contactSearchRef.current);
    if (!contactSearch.trim()) { setContactResults([]); return; }
    setContactSearchLoading(true);
    contactSearchRef.current = setTimeout(async () => {
      try {
        const res = await getContacts(token, { q: contactSearch.trim() });
        setContactResults((res as any)?.data || []);
      } catch { setContactResults([]); }
      finally { setContactSearchLoading(false); }
    }, 300);
    return () => { if (contactSearchRef.current) clearTimeout(contactSearchRef.current); };
  }, [contactSearch, recipientMode, token]);

  // Load templates when WhatsApp channel is selected
  useEffect(() => {
    if (!token || selectedChannel !== "WHATSAPP") return;
    setLoadingTemplates(true);
    getTemplates(token, { channel: "WHATSAPP", status: "APPROVED" })
      .then((res) => {
        setTemplates((res as any)?.data || []);
      })
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  }, [token, selectedChannel]);

  const channelConfig = selectedChannel ? CHANNEL_CONFIG[selectedChannel] : null;
  const isTemplateOnly = channelConfig?.templateOnly ?? false;

  const selectedTemplate = templates.find((t: any) => t.id === selectedTemplateId);

  // Parse template variables
  const templateVarKeys = selectedTemplate
    ? (selectedTemplate.body?.match(/\{\{(\d+)\}\}/g) || []).map((m: string) => m.replace(/[^0-9]/g, ""))
    : [];

  // Rendered template preview
  const renderedTemplate = selectedTemplate
    ? selectedTemplate.body?.replace(/\{\{(\d+)\}\}/g, (_: string, n: string) => templateVariables[n] || `{{${n}}}`)
    : "";

  function handleSelectChannel(accountId: string, channel: string) {
    setSelectedAccountId(accountId);
    setSelectedChannel(channel);
    setSelectedContact(null);
    setManualIdentifier("");
    setMessageBody("");
    setSelectedTemplateId("");
    setTemplateVariables({});
    setError("");
    setStep("recipient");
  }

  function handleSelectContact(contact: any) {
    setSelectedContact(contact);
    setContactSearch("");
    setContactResults([]);
    setStep("message");
  }

  function handleManualNext() {
    if (!manualIdentifier.trim()) return;
    setStep("message");
  }

  function handleBack() {
    setError("");
    if (step === "message") {
      setStep("recipient");
    } else if (step === "recipient") {
      setStep("channel");
      setSelectedAccountId("");
      setSelectedChannel("");
    }
  }

  const canSend = (() => {
    const hasRecipient = selectedContact || manualIdentifier.trim();
    if (!hasRecipient) return false;
    if (isTemplateOnly) return !!selectedTemplateId;
    return !!messageBody.trim();
  })();

  const handleSend = useCallback(async () => {
    if (!token || !selectedAccountId || sending) return;
    setSending(true);
    setError("");

    try {
      let contactId = selectedContact?.id;

      // If manual identifier, create/upsert contact first
      if (!contactId && manualIdentifier.trim()) {
        const contactRes = await createContact(token, {
          externalId: manualIdentifier.trim(),
          channel: selectedChannel,
          displayName: manualIdentifier.trim(),
        });
        contactId = (contactRes as any)?.data?.id;
        if (!contactId) {
          setError(t("newConversation.errors.contactFailed"));
          setSending(false);
          return;
        }
      }

      // Build message body
      let body = messageBody.trim();
      if (isTemplateOnly && selectedTemplate) {
        body = renderedTemplate || selectedTemplate.body;
      }

      const res = await initiateConversation(token, {
        contactId,
        channelAccountId: selectedAccountId,
        body,
        messageType: isTemplateOnly ? "template" : "text",
        templateId: isTemplateOnly ? selectedTemplateId : undefined,
        variables: isTemplateOnly ? templateVariables : undefined,
      });

      const convId = (res as any)?.data?.id;
      if (convId) {
        onCreated(convId);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || t("newConversation.errors.sendFailed"));
    } finally {
      setSending(false);
    }
  }, [token, selectedAccountId, selectedContact, manualIdentifier, selectedChannel, messageBody, isTemplateOnly, selectedTemplate, renderedTemplate, sending, onCreated, onClose, t]);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Side panel */}
      <div className="relative ms-auto w-full max-w-[420px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
          {step !== "channel" && (
            <button
              onClick={handleBack}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0"
            >
              <svg className="w-4 h-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900">{t("newConversation.title")}</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {step === "channel" && t("newConversation.steps.channel")}
              {step === "recipient" && t("newConversation.steps.recipient")}
              {step === "message" && t("newConversation.steps.message")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-5 py-3 flex items-center gap-2">
          {(["channel", "recipient", "message"] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={clsx(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all",
                step === s ? "bg-primary-500 text-white shadow-sm" :
                (["channel", "recipient", "message"].indexOf(step) > i) ? "bg-primary-100 text-primary-600" :
                "bg-gray-100 text-gray-400"
              )}>
                {["channel", "recipient", "message"].indexOf(step) > i ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {i < 2 && (
                <div className={clsx(
                  "flex-1 h-0.5 rounded-full transition-all",
                  ["channel", "recipient", "message"].indexOf(step) > i ? "bg-primary-300" : "bg-gray-100"
                )} />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* STEP 1: Channel Selection */}
          {step === "channel" && (
            <div className="space-y-3 pt-2">
              <p className="text-sm font-medium text-gray-600">{t("newConversation.selectChannel")}</p>

              {loadingAccounts ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                </div>
              ) : Object.keys(accountsByChannel).length === 0 ? (
                <div className="text-center py-12">
                  <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <svg className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-gray-600">{t("newConversation.noChannels")}</p>
                  <p className="text-xs text-gray-400 mt-1">{t("newConversation.noChannelsDesc")}</p>
                </div>
              ) : (
                <div className="grid gap-2.5">
                  {Object.entries(accountsByChannel).map(([channel, accounts]) => {
                    const config = CHANNEL_CONFIG[channel];
                    if (!config) return null;
                    return accounts.map((account: any) => (
                      <button
                        key={account.id}
                        onClick={() => handleSelectChannel(account.id, channel)}
                        className={clsx(
                          "w-full flex items-center gap-3.5 p-3.5 rounded-xl border transition-all text-start group",
                          config.bg
                        )}
                      >
                        <div className="w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center shrink-0">
                          <Image src={config.logo} alt={config.label} width={24} height={24} className="rounded" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={clsx("text-sm font-semibold", config.color)}>{config.label}</span>
                            {config.templateOnly && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-amber-100 text-amber-600 rounded-full font-medium">
                                {t("newConversation.templateOnly")}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {account.displayName || account.externalId}
                          </p>
                        </div>
                        <svg className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition rtl:rotate-180 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                      </button>
                    ));
                  })}
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Recipient */}
          {step === "recipient" && channelConfig && (
            <div className="space-y-4 pt-2">
              {/* Selected channel indicator */}
              <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-xl">
                <Image src={channelConfig.logo} alt={channelConfig.label} width={20} height={20} className="rounded" />
                <span className={clsx("text-sm font-medium", channelConfig.color)}>{channelConfig.label}</span>
                <span className="text-xs text-gray-400">
                  {channelAccounts.find((a) => a.id === selectedAccountId)?.displayName}
                </span>
              </div>

              {/* Mode toggle */}
              <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
                <button
                  onClick={() => { setRecipientMode("search"); setManualIdentifier(""); }}
                  className={clsx(
                    "flex-1 py-2 text-xs font-medium rounded-lg transition-all",
                    recipientMode === "search"
                      ? "bg-white text-gray-800 shadow-sm"
                      : "text-gray-400 hover:text-gray-600"
                  )}
                >
                  {t("newConversation.recipient.searchContacts")}
                </button>
                <button
                  onClick={() => { setRecipientMode("manual"); setSelectedContact(null); setContactSearch(""); setContactResults([]); }}
                  className={clsx(
                    "flex-1 py-2 text-xs font-medium rounded-lg transition-all",
                    recipientMode === "manual"
                      ? "bg-white text-gray-800 shadow-sm"
                      : "text-gray-400 hover:text-gray-600"
                  )}
                >
                  {t("newConversation.recipient.enterManually")}
                </button>
              </div>

              {/* Search mode */}
              {recipientMode === "search" && (
                <div>
                  {selectedContact ? (
                    <div className="flex items-center gap-3 p-3 bg-primary-50 rounded-xl border border-primary-200">
                      <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center shrink-0">
                        <span className="text-sm font-bold text-primary-600">
                          {(selectedContact.displayName || selectedContact.externalId || "?").charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{selectedContact.displayName || selectedContact.externalId}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {selectedContact.channel && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded font-medium uppercase">{selectedContact.channel}</span>
                          )}
                          <span className="text-xs text-gray-400 truncate">{selectedContact.externalId}</span>
                        </div>
                      </div>
                      <button onClick={() => setSelectedContact(null)} className="text-gray-400 hover:text-red-500 transition">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <svg className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                      <input
                        type="text"
                        value={contactSearch}
                        onChange={(e) => setContactSearch(e.target.value)}
                        placeholder={t("newConversation.recipient.searchPlaceholder")}
                        className="w-full ps-9 pe-4 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                        autoFocus
                      />
                      {contactSearchLoading && (
                        <div className="absolute end-3 top-1/2 -translate-y-1/2">
                          <div className="w-4 h-4 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                        </div>
                      )}
                      {contactResults.length > 0 && (
                        <div className="absolute top-full start-0 end-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-100 z-10 max-h-48 overflow-y-auto">
                          {contactResults.map((c: any) => (
                            <button
                              key={c.id}
                              onClick={() => handleSelectContact(c)}
                              className="w-full text-start px-4 py-2.5 hover:bg-gray-50 transition flex items-center gap-3"
                            >
                              <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
                                <span className="text-xs font-bold text-gray-500">
                                  {(c.displayName || c.externalId || "?").charAt(0).toUpperCase()}
                                </span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-800 truncate">{c.displayName || c.externalId}</p>
                                <div className="flex items-center gap-2">
                                  {c.channel && (
                                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded font-medium uppercase">{c.channel}</span>
                                  )}
                                  <span className="text-xs text-gray-400 truncate">{c.externalId}</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      {contactSearch.trim() && !contactSearchLoading && contactResults.length === 0 && (
                        <div className="absolute top-full start-0 end-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-100 z-10 px-4 py-3 text-sm text-gray-400 text-center">
                          {t("newConversation.recipient.noResults")}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Next button for search mode */}
                  {selectedContact && (
                    <button
                      onClick={() => setStep("message")}
                      className="w-full mt-3 py-2.5 bg-primary-500 text-white text-sm font-medium rounded-xl hover:bg-primary-600 transition flex items-center justify-center gap-2"
                    >
                      {t("newConversation.continue")}
                      <svg className="w-4 h-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                      </svg>
                    </button>
                  )}
                </div>
              )}

              {/* Manual mode */}
              {recipientMode === "manual" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {t(channelConfig.identifierLabel)}
                  </label>
                  <input
                    type={channelConfig.identifierType}
                    value={manualIdentifier}
                    onChange={(e) => setManualIdentifier(e.target.value)}
                    placeholder={channelConfig.identifierPlaceholder}
                    className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                    autoFocus
                    dir="ltr"
                  />
                  <p className="text-[11px] text-gray-400 mt-1.5">{t(channelConfig.description)}</p>

                  <button
                    onClick={handleManualNext}
                    disabled={!manualIdentifier.trim()}
                    className="w-full mt-3 py-2.5 bg-primary-500 text-white text-sm font-medium rounded-xl hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                  >
                    {t("newConversation.continue")}
                    <svg className="w-4 h-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* STEP 3: Message */}
          {step === "message" && channelConfig && (
            <div className="space-y-4 pt-2">
              {/* Recipient summary */}
              <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-xl">
                <Image src={channelConfig.logo} alt={channelConfig.label} width={18} height={18} className="rounded" />
                <span className="text-xs text-gray-500">{t("newConversation.to")}:</span>
                <span className="text-sm font-medium text-gray-800 truncate">
                  {selectedContact?.displayName || selectedContact?.externalId || manualIdentifier}
                </span>
              </div>

              {/* WhatsApp: Template selector */}
              {isTemplateOnly ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t("newConversation.message.selectTemplate")}
                    </label>
                    <p className="text-[11px] text-amber-600 bg-amber-50 px-3 py-2 rounded-lg mb-2 flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z" />
                      </svg>
                      {t("newConversation.message.waTemplateNotice")}
                    </p>

                    {loadingTemplates ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                      </div>
                    ) : templates.length === 0 ? (
                      <div className="text-center py-6 bg-gray-50 rounded-xl">
                        <p className="text-sm text-gray-500">{t("newConversation.message.noTemplates")}</p>
                        <a href="/outbound/templates" className="text-xs text-primary-600 hover:underline mt-1 inline-block">
                          {t("newConversation.message.createTemplate")}
                        </a>
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {templates.map((tpl: any) => (
                          <button
                            key={tpl.id}
                            onClick={() => { setSelectedTemplateId(tpl.id); setTemplateVariables({}); }}
                            className={clsx(
                              "w-full text-start p-3 rounded-xl border transition-all",
                              selectedTemplateId === tpl.id
                                ? "border-primary-300 bg-primary-50 ring-1 ring-primary-200"
                                : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
                            )}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium text-gray-800">{tpl.name}</span>
                              <span className="text-[9px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded-full font-medium uppercase">{tpl.language}</span>
                            </div>
                            <p className="text-xs text-gray-500 line-clamp-2">{tpl.body}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Template variable inputs */}
                  {selectedTemplate && templateVarKeys.length > 0 && (
                    <div className="space-y-2">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t("newConversation.message.variables")}
                      </label>
                      {templateVarKeys.map((key: string) => (
                        <input
                          key={key}
                          type="text"
                          value={templateVariables[key] || ""}
                          onChange={(e) => setTemplateVariables((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder={`{{${key}}}`}
                          className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
                        />
                      ))}
                    </div>
                  )}

                  {/* Template preview */}
                  {selectedTemplate && (
                    <div className="bg-green-50 rounded-xl p-3 border border-green-100">
                      <p className="text-[10px] font-semibold text-green-600 uppercase tracking-wider mb-1.5">{t("newConversation.message.preview")}</p>
                      <p className="text-xs text-gray-700 whitespace-pre-wrap">{renderedTemplate}</p>
                    </div>
                  )}
                </div>
              ) : (
                /* Non-WhatsApp: Free text message */
                <AIComposeScope
                  surface="inbox"
                  channel={selectedChannel}
                  currentValue={messageBody}
                  onApply={(text) => setMessageBody(text)}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm font-medium text-gray-700">
                      {t("newConversation.message.label")}
                    </label>
                    <AIComposeTrigger />
                  </div>
                  <textarea
                    value={messageBody}
                    onChange={(e) => setMessageBody(e.target.value)}
                    placeholder={t("newConversation.message.placeholder")}
                    rows={4}
                    className="w-full px-4 py-3 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition resize-none"
                    autoFocus
                  />
                  <AIComposePanel />
                </AIComposeScope>
              )}

              {/* Error */}
              {error && (
                <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer: Send button (only on message step) */}
        {step === "message" && (
          <div className="px-5 py-4 border-t border-gray-100">
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              className="w-full py-3 bg-primary-500 text-white text-sm font-semibold rounded-xl hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2 shadow-sm"
            >
              {sending ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t("newConversation.sending")}
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                  {t("newConversation.send")}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
