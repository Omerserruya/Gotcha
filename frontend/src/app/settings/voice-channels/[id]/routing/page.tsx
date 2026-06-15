"use client";

/**
 * Voice channel call routing.
 *
 * Two top-level sections - Inbound (when customers call you) and
 * Outbound (when you call customers) - each with its own mode picker
 * and the sub-settings relevant to that mode. Saves to
 * `voice_channels` via `PUT /api/voice-channels/:id/routing`.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getVoiceChannelRouting,
  updateVoiceChannelRouting,
  getAgents,
  getDepartments,
  type VoiceChannelRouting,
} from "@/lib/api";
import clsx from "clsx";

interface AgentOption { id: string; name?: string; email?: string; phoneNumber?: string | null }
interface DeptOption  { id: string; name: string }

const EMPTY: VoiceChannelRouting = {
  defaultAgentId: null,
  fallbackDepartmentId: null,
  ringTimeoutSeconds: 20,
  autoHangupSeconds: null,
  inboundMode: "IN_PLATFORM",
  outboundMode: "IN_PLATFORM",
  agentFirstAgentId: null,
  openWorkspaceOnAgentFirst: true,
};

function agentLabel(a: AgentOption): string {
  return a.name || a.email || a.id;
}
function findAgent(agents: AgentOption[], id: string | null): AgentOption | null {
  if (!id) return null;
  return agents.find((a) => a.id === id) ?? null;
}

export default function VoiceChannelRoutingPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const channelId = params?.id;

  const [routing, setRouting] = useState<VoiceChannelRouting>(EMPTY);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !channelId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getVoiceChannelRouting(token, channelId),
      getAgents(token),
      getDepartments(token),
    ])
      .then(([r, a, d]) => {
        if (cancelled) return;
        setRouting(r.data);
        setAgents((Array.isArray(a) ? a : []) as AgentOption[]);
        const depts = (d as { data?: DeptOption[] } | DeptOption[]);
        setDepartments(Array.isArray(depts) ? depts : (depts?.data ?? []));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed_to_load");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, channelId]);

  async function handleSave() {
    if (!token || !channelId) return;
    setSaving(true);
    setError(null);
    try {
      await updateVoiceChannelRouting(token, channelId, routing);
      setToast(t("settings.voiceChannelRouting.saved"));
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed_to_save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-4 text-sm text-gray-500">
        {t("settings.voiceChannelRouting.loading")}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      <div className="mb-6">
        <Link href={`/settings/voice-channels/${channelId}`} className="text-xs text-primary-600 hover:underline">
          ← {t("settings.voiceChannelRouting.backToChannel")}
        </Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">
          {t("settings.voiceChannelRouting.title")}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {t("settings.voiceChannelRouting.subtitle")}
        </p>
      </div>

      {error && (
        <div className="mb-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {toast}
        </div>
      )}

      <InboundSection
        routing={routing}
        setRouting={setRouting}
        agents={agents}
        departments={departments}
        t={t}
      />

      <OutboundSection
        routing={routing}
        setRouting={setRouting}
        agents={agents}
        t={t}
      />

      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => router.push(`/settings/voice-channels/${channelId}`)}
          className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
        >
          {t("settings.voiceChannelRouting.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={clsx(
            "px-4 py-2 text-sm font-semibold rounded-lg transition",
            saving ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-primary-600 text-white hover:bg-primary-700",
          )}
        >
          {saving ? t("settings.voiceChannelRouting.saving") : t("settings.voiceChannelRouting.save")}
        </button>
      </div>
    </div>
  );
}

/* ─── Inbound (when customers call you) ──────────────────────── */

function InboundSection({
  routing, setRouting, agents, departments, t,
}: {
  routing: VoiceChannelRouting;
  setRouting: (fn: (r: VoiceChannelRouting) => VoiceChannelRouting) => void;
  agents: AgentOption[];
  departments: DeptOption[];
  t: (k: string) => string;
}) {
  const isForward = routing.inboundMode === "FORWARD_TO_AGENT";
  const inboundAgent = findAgent(agents, routing.defaultAgentId);
  const warning = useMemo(() => {
    if (!isForward) return null;
    if (!inboundAgent) return t("settings.voiceChannelRouting.inbound.forwardMissingAgent");
    if (!inboundAgent.phoneNumber) return t("settings.voiceChannelRouting.inbound.forwardMissingPhone");
    return null;
  }, [isForward, inboundAgent, t]);

  return (
    <Section
      title={t("settings.voiceChannelRouting.inbound.title")}
      subtitle={t("settings.voiceChannelRouting.inbound.subtitle")}
    >
      <ModePicker
        options={[
          {
            value: "IN_PLATFORM",
            title: t("settings.voiceChannelRouting.inbound.modeInPlatform"),
            hint: t("settings.voiceChannelRouting.inbound.modeInPlatformHint"),
          },
          {
            value: "FORWARD_TO_AGENT",
            title: t("settings.voiceChannelRouting.inbound.modeForward"),
            hint: t("settings.voiceChannelRouting.inbound.modeForwardHint"),
          },
        ]}
        value={routing.inboundMode}
        onChange={(v) => setRouting((r) => ({ ...r, inboundMode: v as VoiceChannelRouting["inboundMode"] }))}
      />

      <Field label={t("settings.voiceChannelRouting.inbound.agentLabel")} hint={t("settings.voiceChannelRouting.inbound.agentHint")}>
        <AgentSelect
          agents={agents}
          value={routing.defaultAgentId}
          onChange={(id) => setRouting((r) => ({ ...r, defaultAgentId: id }))}
          placeholder={t("settings.voiceChannelRouting.inbound.agentPlaceholder")}
        />
      </Field>

      {!isForward && (
        <>
          <Field label={t("settings.voiceChannelRouting.inbound.ringTimeoutLabel")} hint={t("settings.voiceChannelRouting.inbound.ringTimeoutHint")}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={120}
                value={routing.ringTimeoutSeconds}
                onChange={(e) => setRouting((r) => ({ ...r, ringTimeoutSeconds: Number(e.target.value) || 20 }))}
                className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              />
              <span className="text-xs text-gray-500">{t("settings.voiceChannelRouting.seconds")}</span>
            </div>
          </Field>

          <Field label={t("settings.voiceChannelRouting.inbound.fallbackDeptLabel")} hint={t("settings.voiceChannelRouting.inbound.fallbackDeptHint")}>
            <select
              value={routing.fallbackDepartmentId ?? ""}
              onChange={(e) => setRouting((r) => ({ ...r, fallbackDepartmentId: e.target.value || null }))}
              className="w-full md:w-80 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            >
              <option value="">{t("settings.voiceChannelRouting.inbound.fallbackDeptAll")}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>

          <Field
            label={t("settings.voiceChannelRouting.inbound.autoHangupLabel")}
            hint={t("settings.voiceChannelRouting.inbound.autoHangupHint")}
          >
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={routing.autoHangupSeconds != null}
                  onChange={(e) =>
                    setRouting((r) => ({
                      ...r,
                      autoHangupSeconds: e.target.checked ? Math.max(10, r.ringTimeoutSeconds + 30) : null,
                    }))
                  }
                />
                <span className="text-xs text-gray-700">
                  {t("settings.voiceChannelRouting.inbound.autoHangupEnable")}
                </span>
              </label>
              {routing.autoHangupSeconds != null && (
                <>
                  <input
                    type="number"
                    min={10}
                    max={120}
                    value={routing.autoHangupSeconds}
                    onChange={(e) =>
                      setRouting((r) => ({
                        ...r,
                        autoHangupSeconds: Number(e.target.value) || 10,
                      }))
                    }
                    className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                  />
                  <span className="text-xs text-gray-500">
                    {t("settings.voiceChannelRouting.seconds")}
                  </span>
                </>
              )}
            </div>
          </Field>
        </>
      )}

      {warning && <Warning>{warning}</Warning>}
    </Section>
  );
}

/* ─── Outbound (when you call customers) ─────────────────────── */

function OutboundSection({
  routing, setRouting, agents, t,
}: {
  routing: VoiceChannelRouting;
  setRouting: (fn: (r: VoiceChannelRouting) => VoiceChannelRouting) => void;
  agents: AgentOption[];
  t: (k: string) => string;
}) {
  const isAgentFirst = routing.outboundMode === "AGENT_FIRST";
  // Effective AGENT_FIRST agent - explicit slot, with defaultAgent as
  // legacy fallback. The UI surfaces the fallback transparently so
  // admins know what will actually ring even if they never picked.
  const explicitAgent = findAgent(agents, routing.agentFirstAgentId);
  const fallbackAgent = findAgent(agents, routing.defaultAgentId);
  const effectiveAgent = explicitAgent ?? fallbackAgent;
  const warning = useMemo(() => {
    if (!isAgentFirst) return null;
    if (!effectiveAgent) return t("settings.voiceChannelRouting.outbound.agentFirstMissingAgent");
    if (!effectiveAgent.phoneNumber) return t("settings.voiceChannelRouting.outbound.agentFirstMissingPhone");
    return null;
  }, [isAgentFirst, effectiveAgent, t]);

  return (
    <Section
      title={t("settings.voiceChannelRouting.outbound.title")}
      subtitle={t("settings.voiceChannelRouting.outbound.subtitle")}
    >
      <ModePicker
        options={[
          {
            value: "IN_PLATFORM",
            title: t("settings.voiceChannelRouting.outbound.modeInPlatform"),
            hint: t("settings.voiceChannelRouting.outbound.modeInPlatformHint"),
          },
          {
            value: "AGENT_FIRST",
            title: t("settings.voiceChannelRouting.outbound.modeAgentFirst"),
            hint: t("settings.voiceChannelRouting.outbound.modeAgentFirstHint"),
          },
        ]}
        value={routing.outboundMode}
        onChange={(v) => setRouting((r) => ({ ...r, outboundMode: v as VoiceChannelRouting["outboundMode"] }))}
      />

      {isAgentFirst && (
        <>
          <Field
            label={t("settings.voiceChannelRouting.outbound.agentLabel")}
            hint={t("settings.voiceChannelRouting.outbound.agentHint")}
          >
            <AgentSelect
              agents={agents}
              value={routing.agentFirstAgentId}
              onChange={(id) => setRouting((r) => ({ ...r, agentFirstAgentId: id }))}
              placeholder={
                fallbackAgent
                  ? t("settings.voiceChannelRouting.outbound.agentInheritsInbound").replace("{name}", agentLabel(fallbackAgent))
                  : t("settings.voiceChannelRouting.outbound.agentPlaceholder")
              }
            />
            {!explicitAgent && fallbackAgent && (
              <p className="mt-1.5 text-[11px] text-gray-500">
                {t("settings.voiceChannelRouting.outbound.fallbackHint").replace("{name}", agentLabel(fallbackAgent))}
              </p>
            )}
          </Field>

          <Field label={t("settings.voiceChannelRouting.outbound.openWorkspaceLabel")}>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={routing.openWorkspaceOnAgentFirst}
                onChange={(e) => setRouting((r) => ({ ...r, openWorkspaceOnAgentFirst: e.target.checked }))}
              />
              <span className="text-xs text-gray-600">
                {t("settings.voiceChannelRouting.outbound.openWorkspaceHint")}
              </span>
            </label>
          </Field>
        </>
      )}

      {warning && <Warning>{warning}</Warning>}
    </Section>
  );
}

/* ─── Generic building blocks ─────────────────────────────── */

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <h2 className="text-base font-semibold text-gray-900 leading-tight">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      {hint && <div className="text-[11px] text-gray-500 mb-1.5">{hint}</div>}
      <div className={hint ? "" : "mt-1.5"}>{children}</div>
    </div>
  );
}

function ModePicker({
  options, value, onChange,
}: {
  options: { value: string; title: string; hint: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={clsx(
              "text-left p-3 rounded-lg border transition focus:outline-none focus:ring-2 focus:ring-primary-300",
              selected
                ? "border-primary-500 bg-primary-50/50 ring-1 ring-primary-200"
                : "border-gray-200 bg-white hover:border-gray-300",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  "inline-block w-3 h-3 rounded-full ring-1",
                  selected ? "bg-primary-500 ring-primary-300" : "bg-white ring-gray-300",
                )}
              />
              <span className="text-sm font-semibold text-gray-900">{o.title}</span>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">{o.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

function AgentSelect({
  agents, value, onChange, placeholder,
}: {
  agents: AgentOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full md:w-80 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
    >
      <option value="">{placeholder}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {agentLabel(a)}{a.phoneNumber ? "" : " - ⚠ no phone"}
        </option>
      ))}
    </select>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}
