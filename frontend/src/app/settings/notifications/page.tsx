"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAgents } from "@/lib/api";
import { getDepartments } from "@/lib/api";
import {
  listNotificationPreferences,
  createNotificationPreference,
  updateNotificationPreference,
  deleteNotificationPreference,
  NotificationPreference,
  NotificationPriority,
  NotificationChannel,
  RecipientType,
  NotificationCondition,
} from "@/lib/api-notifications";
import clsx from "clsx";

// ─── Notification sound ping (same AudioContext approach as NotificationBell) ──
function playTestPing() {
  try {
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {
    /* ignore */
  }
}

// ─── Event type catalogue ─────────────────────────────────────
interface EventTypeMeta {
  eventType: string;
  titleKey: string;
  descKey: string;
}

const EVENT_TYPES: EventTypeMeta[] = [
  { eventType: "tool.approval_required",    titleKey: "notifications.events.toolApproval.title",    descKey: "notifications.events.toolApproval.desc" },
  { eventType: "lead.created",              titleKey: "notifications.events.leadCreated.title",      descKey: "notifications.events.leadCreated.desc" },
  { eventType: "meeting.scheduled",         titleKey: "notifications.events.meetingScheduled.title", descKey: "notifications.events.meetingScheduled.desc" },
  { eventType: "discount.applied",          titleKey: "notifications.events.discountApplied.title",  descKey: "notifications.events.discountApplied.desc" },
  { eventType: "refund.issued",             titleKey: "notifications.events.refundIssued.title",     descKey: "notifications.events.refundIssued.desc" },
  { eventType: "conversation.escalated",    titleKey: "notifications.events.conversationEscalated.title", descKey: "notifications.events.conversationEscalated.desc" },
  { eventType: "high_value_lead.detected",  titleKey: "notifications.events.highValueLead.title",   descKey: "notifications.events.highValueLead.desc" },
  { eventType: "payment.failed",            titleKey: "notifications.events.paymentFailed.title",   descKey: "notifications.events.paymentFailed.desc" },
  { eventType: "system.error.critical",     titleKey: "notifications.events.systemError.title",     descKey: "notifications.events.systemError.desc" },
];

const PRIORITIES: NotificationPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PRIORITY_LABELS: Record<NotificationPriority, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

interface Agent {
  id: string;
  name: string;
  email: string;
}

interface Department {
  id: string;
  name: string;
}

// ─── Per-rule state ────────────────────────────────────────────
// One UI rule maps to one NotificationPreference row. Multiple rules per
// (event, department) are allowed since the unique constraint was dropped
// in migration 20260507400000 - that's how per-recipient channel routing
// works (e.g. rule 1: User A → email+in_app; rule 2: User B → in_app).
interface RowState {
  prefId: string | null;
  enabled: boolean;
  channels: NotificationChannel[];
  recipientType: RecipientType;
  recipientUserIds: string[];
  priority: NotificationPriority;
  conditionsJson: string;
  showConditions: boolean;
  saving: boolean;
  dirty: boolean;
}

function buildDefaultRow(enabled = false): RowState {
  return {
    prefId: null,
    enabled,
    channels: ["in_app"],
    recipientType: "tenant_owner",
    recipientUserIds: [],
    priority: "MEDIUM",
    conditionsJson: "",
    showConditions: false,
    saving: false,
    dirty: false,
  };
}

function prefToRow(pref: NotificationPreference): RowState {
  return {
    prefId: pref.id,
    enabled: pref.enabled,
    channels: pref.channels,
    recipientType: pref.recipients.type,
    recipientUserIds: pref.recipients.userIds ?? [],
    priority: pref.priority,
    conditionsJson: pref.conditions ? JSON.stringify(pref.conditions, null, 2) : "",
    showConditions: false,
    saving: false,
    dirty: false,
  };
}

export default function NotificationsSettingsPage() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<string>("__tenant__");
  // Multiple rules per event type. Always at least one entry so the UI
  // has something to render and "the empty default row" stays editable
  // without requiring a click on "Add rule".
  const [rules, setRules] = useState<Record<string, RowState[]>>({});
  const [loadingPrefs, setLoadingPrefs] = useState(false);

  // ── Read sound pref from localStorage ──
  useEffect(() => {
    setSoundEnabled(localStorage.getItem("notificationSound") !== "off");
  }, []);

  function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    localStorage.setItem("notificationSound", checked ? "on" : "off");
    if (checked) playTestPing();
  }

  // ── Load departments + agents ──
  useEffect(() => {
    if (!token) return;
    getDepartments(token)
      .then((r) => setDepartments(r.data))
      .catch(() => {});
    getAgents(token)
      .then((data) => setAgents(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [token]);

  // ── Load prefs when department selection changes ──
  const loadPrefs = useCallback(async () => {
    if (!token) return;
    setLoadingPrefs(true);
    try {
      const res = await listNotificationPreferences(token);
      const deptId = selectedDeptId === "__tenant__" ? null : selectedDeptId;
      const filtered = res.data.filter(
        (p) => (p.departmentId ?? null) === deptId
      );

      const next: Record<string, RowState[]> = {};
      for (const et of EVENT_TYPES) {
        const matching = filtered.filter((p) => p.eventType === et.eventType);
        next[et.eventType] = matching.length > 0
          ? matching.map(prefToRow)
          : [buildDefaultRow()];
      }
      setRules(next);
    } catch {
      // swallow
    } finally {
      setLoadingPrefs(false);
    }
  }, [token, selectedDeptId]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  // ── Mutators ──
  function updateRule(eventType: string, idx: number, patch: Partial<RowState>) {
    setRules((prev) => ({
      ...prev,
      [eventType]: (prev[eventType] || []).map((r, i) =>
        i === idx ? { ...r, ...patch, dirty: true } : r
      ),
    }));
  }

  function addRule(eventType: string) {
    setRules((prev) => ({
      ...prev,
      // New rule starts enabled - the user clicked "Add" so they meant it.
      // dirty=true so the Save button lights up immediately.
      [eventType]: [...(prev[eventType] || []), { ...buildDefaultRow(true), dirty: true }],
    }));
  }

  async function deleteRule(eventType: string, idx: number) {
    const list = rules[eventType] || [];
    const target = list[idx];
    if (!target) return;

    if (target.prefId && token) {
      try {
        await deleteNotificationPreference(token, target.prefId);
      } catch {
        // swallow - leave UI in sync below regardless
      }
    }

    setRules((prev) => {
      const filtered = (prev[eventType] || []).filter((_, i) => i !== idx);
      return {
        ...prev,
        // Always keep at least one row so the UI doesn't collapse to nothing.
        [eventType]: filtered.length > 0 ? filtered : [buildDefaultRow()],
      };
    });
  }

  async function saveRule(eventType: string, idx: number) {
    if (!token) return;
    const list = rules[eventType] || [];
    const rule = list[idx];
    if (!rule) return;

    let parsedConditions: NotificationCondition[] | null = null;
    if (rule.conditionsJson.trim()) {
      try {
        parsedConditions = JSON.parse(rule.conditionsJson) as NotificationCondition[];
      } catch {
        alert(t("notifications.conditionsJsonError"));
        return;
      }
    }

    setRules((prev) => ({
      ...prev,
      [eventType]: (prev[eventType] || []).map((r, i) =>
        i === idx ? { ...r, saving: true } : r
      ),
    }));

    const payload = {
      eventType,
      enabled: rule.enabled,
      channels: rule.channels,
      recipients: {
        type: rule.recipientType,
        ...(rule.recipientType === "users" ? { userIds: rule.recipientUserIds } : {}),
      },
      priority: rule.priority,
      conditions: parsedConditions,
      departmentId: selectedDeptId === "__tenant__" ? null : selectedDeptId,
    };

    try {
      if (rule.prefId) {
        await updateNotificationPreference(token, rule.prefId, payload);
        setRules((prev) => ({
          ...prev,
          [eventType]: (prev[eventType] || []).map((r, i) =>
            i === idx ? { ...r, saving: false, dirty: false } : r
          ),
        }));
      } else {
        const res = await createNotificationPreference(token, payload);
        setRules((prev) => ({
          ...prev,
          [eventType]: (prev[eventType] || []).map((r, i) =>
            i === idx ? { ...r, prefId: res.data.id, saving: false, dirty: false } : r
          ),
        }));
      }
    } catch {
      setRules((prev) => ({
        ...prev,
        [eventType]: (prev[eventType] || []).map((r, i) =>
          i === idx ? { ...r, saving: false } : r
        ),
      }));
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      {/* Page heading */}
      <div>
        <h1 className="text-lg font-semibold text-gray-900">{t("notifications.settings.title")}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t("notifications.settings.subtitle")}</p>
      </div>

      {/* ── Section A: Sound toggle ── */}
      <section className="bg-white rounded-2xl shadow-subtle p-5 space-y-1">
        <h2 className="text-sm font-semibold text-gray-800">{t("notifications.settings.soundSection")}</h2>
        <label className="flex items-center gap-3 cursor-pointer mt-2">
          <div
            onClick={() => handleSoundToggle(!soundEnabled)}
            className={clsx(
              "relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0",
              soundEnabled ? "bg-primary-500" : "bg-gray-200"
            )}
            role="switch"
            aria-checked={soundEnabled}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") handleSoundToggle(!soundEnabled);
            }}
          >
            <span
              className={clsx(
                "absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform",
                soundEnabled ? "translate-x-4" : "translate-x-0"
              )}
            />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800">{t("notifications.settings.soundToggle")}</p>
            <p className="text-xs text-gray-400">{t("notifications.settings.soundHint")}</p>
          </div>
        </label>
      </section>

      {/* ── Section B: Preferences ── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">{t("notifications.settings.prefsSection")}</h2>

          {/* Department picker */}
          <select
            value={selectedDeptId}
            onChange={(e) => setSelectedDeptId(e.target.value)}
            className="text-xs bg-gray-50 border-0 ring-1 ring-gray-200/60 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-200"
            aria-label={t("notifications.settings.departmentPicker")}
          >
            <option value="__tenant__">{t("notifications.settings.tenantDefault")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        {loadingPrefs && (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        )}

        {!loadingPrefs &&
          EVENT_TYPES.map((et) => {
            const eventRules = rules[et.eventType] || [];

            return (
              <div
                key={et.eventType}
                className="bg-white rounded-2xl shadow-subtle p-5 space-y-4"
              >
                {/* Event header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{t(et.titleKey)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{t(et.descKey)}</p>
                  </div>
                </div>

                {/* Rules list */}
                <div className="space-y-3">
                  {eventRules.map((rule, idx) => {
                    const showDelete = eventRules.length > 1 || rule.prefId !== null;
                    return (
                      <div
                        key={rule.prefId ?? `new-${idx}`}
                        className="rounded-xl bg-gray-50/60 ring-1 ring-gray-100 p-4 space-y-3"
                      >
                        {/* Rule header: enabled toggle + delete */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              onClick={() => updateRule(et.eventType, idx, { enabled: !rule.enabled })}
                              className={clsx(
                                "relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0",
                                rule.enabled ? "bg-primary-500" : "bg-gray-200"
                              )}
                              role="switch"
                              aria-checked={rule.enabled}
                              aria-label={t("notifications.settings.enabledToggle")}
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === " " || e.key === "Enter")
                                  updateRule(et.eventType, idx, { enabled: !rule.enabled });
                              }}
                            >
                              <span
                                className={clsx(
                                  "absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform",
                                  rule.enabled ? "translate-x-4" : "translate-x-0"
                                )}
                              />
                            </div>
                            <span className="text-xs text-gray-500">
                              {eventRules.length > 1
                                ? t("notifications.settings.ruleN").replace("{n}", String(idx + 1))
                                : t("notifications.settings.rule")}
                            </span>
                          </div>

                          {showDelete && (
                            <button
                              type="button"
                              onClick={() => deleteRule(et.eventType, idx)}
                              className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
                              aria-label={t("notifications.settings.deleteRule")}
                            >
                              {t("notifications.settings.deleteRule")}
                            </button>
                          )}
                        </div>

                        {rule.enabled && (
                          <div className="space-y-3 pt-1 border-t border-gray-100">
                            {/* Channels */}
                            <div className="flex items-center gap-4">
                              <span className="text-xs text-gray-500 w-24 shrink-0">{t("notifications.settings.channels")}</span>
                              <div className="flex items-center gap-4">
                                {(["in_app", "email"] as NotificationChannel[]).map((ch) => (
                                  <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={rule.channels.includes(ch)}
                                      onChange={(e) => {
                                        const next = e.target.checked
                                          ? [...rule.channels, ch]
                                          : rule.channels.filter((c) => c !== ch);
                                        updateRule(et.eventType, idx, { channels: next });
                                      }}
                                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-400"
                                    />
                                    <span className="text-xs text-gray-700 capitalize">{ch.replace("_", " ")}</span>
                                  </label>
                                ))}
                              </div>
                            </div>

                            {/* Priority */}
                            <div className="flex items-center gap-4">
                              <span className="text-xs text-gray-500 w-24 shrink-0">{t("notifications.settings.priority")}</span>
                              <select
                                value={rule.priority}
                                onChange={(e) =>
                                  updateRule(et.eventType, idx, { priority: e.target.value as NotificationPriority })
                                }
                                className="text-xs bg-white border-0 ring-1 ring-gray-200/60 rounded-lg px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-200"
                              >
                                {PRIORITIES.map((p) => (
                                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                                ))}
                              </select>
                            </div>

                            {/* Recipients */}
                            <div className="flex items-start gap-4">
                              <span className="text-xs text-gray-500 w-24 shrink-0 pt-1.5">{t("notifications.settings.recipients")}</span>
                              <div className="flex-1 space-y-2">
                                <select
                                  value={rule.recipientType}
                                  onChange={(e) =>
                                    updateRule(et.eventType, idx, { recipientType: e.target.value as RecipientType })
                                  }
                                  className="w-full text-xs bg-white border-0 ring-1 ring-gray-200/60 rounded-lg px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-200"
                                >
                                  <option value="tenant_owner">{t("notifications.settings.recipientTenantOwner")}</option>
                                  <option value="department_manager">{t("notifications.settings.recipientDeptManager")}</option>
                                  <option value="users">{t("notifications.settings.recipientSpecificUsers")}</option>
                                </select>

                                {rule.recipientType === "users" && (
                                  <div className="space-y-1">
                                    <p className="text-[10px] text-gray-400">{t("notifications.settings.selectUsers")}</p>
                                    <div className="max-h-32 overflow-y-auto space-y-1 border border-gray-100 rounded-xl p-2 bg-white">
                                      {agents.map((a) => (
                                        <label key={a.id} className="flex items-center gap-2 cursor-pointer">
                                          <input
                                            type="checkbox"
                                            checked={rule.recipientUserIds.includes(a.id)}
                                            onChange={(e) => {
                                              const next = e.target.checked
                                                ? [...rule.recipientUserIds, a.id]
                                                : rule.recipientUserIds.filter((id) => id !== a.id);
                                              updateRule(et.eventType, idx, { recipientUserIds: next });
                                            }}
                                            className="rounded border-gray-300 text-primary-600 focus:ring-primary-400"
                                          />
                                          <span className="text-xs text-gray-700">{a.name}</span>
                                          <span className="text-[10px] text-gray-400">{a.email}</span>
                                        </label>
                                      ))}
                                      {agents.length === 0 && (
                                        <p className="text-xs text-gray-400 text-center py-2">{t("notifications.settings.noAgents")}</p>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Conditions (advanced, collapsed) */}
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  updateRule(et.eventType, idx, { showConditions: !rule.showConditions, dirty: rule.dirty })
                                }
                                className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
                              >
                                <svg
                                  className={clsx("w-3 h-3 transition-transform", rule.showConditions ? "rotate-90" : "")}
                                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                                {t("notifications.settings.advancedConditions")}
                              </button>

                              {rule.showConditions && (
                                <div className="mt-2 space-y-1">
                                  <p className="text-[10px] text-gray-400">
                                    {t("notifications.settings.conditionsHint")}
                                  </p>
                                  <textarea
                                    value={rule.conditionsJson}
                                    onChange={(e) =>
                                      updateRule(et.eventType, idx, { conditionsJson: e.target.value })
                                    }
                                    rows={4}
                                    placeholder='[{"field":"priority","op":"eq","value":"HIGH"}]'
                                    className="w-full text-xs font-mono bg-white border-0 ring-1 ring-gray-200 rounded-xl px-3 py-2 text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-200 resize-y"
                                    aria-label={t("notifications.settings.conditionsLabel")}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Save button */}
                        <div className="flex justify-end pt-1">
                          <button
                            type="button"
                            disabled={!rule.dirty || rule.saving}
                            onClick={() => saveRule(et.eventType, idx)}
                            className={clsx(
                              "px-4 py-1.5 rounded-xl text-xs font-medium transition-all",
                              rule.dirty && !rule.saving
                                ? "bg-primary-500 text-white hover:bg-primary-600 shadow-sm"
                                : "bg-gray-100 text-gray-400 cursor-not-allowed"
                            )}
                          >
                            {rule.saving ? t("notifications.settings.saving") : t("notifications.settings.save")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Add rule */}
                <div>
                  <button
                    type="button"
                    onClick={() => addRule(et.eventType)}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium transition-colors"
                  >
                    + {t("notifications.settings.addRule")}
                  </button>
                </div>
              </div>
            );
          })}
      </section>
    </div>
  );
}
