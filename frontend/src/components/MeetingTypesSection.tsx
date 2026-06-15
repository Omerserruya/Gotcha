"use client";

/**
 * Meeting Types editor - embedded inside the marketplace integration page
 * for calendar providers (google_calendar, calendly).
 *
 * Tenant-scoped: meeting types live at the tenant level, not per AI agent.
 * Per-agent permissions for `schedule_meeting` are handled by the existing
 * AgentToolPermission system (Tools tab on the agent detail page).
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  listMeetingTypes,
  createMeetingType,
  updateMeetingType,
  deleteMeetingType,
  type MeetingTypeRow,
  type DayWindow,
} from "@/lib/api-scheduler";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DEFAULT_HOURS: DayWindow[] = [0, 1, 2, 3, 4].map((d) => ({
  weekday: d as 0 | 1 | 2 | 3 | 4,
  start: "09:00",
  end: "18:00",
}));

export default function MeetingTypesSection() {
  const { token } = useAuth();
  const [rows, setRows] = useState<MeetingTypeRow[]>([]);
  const [editing, setEditing] = useState<MeetingTypeRow | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!token) return;
    try {
      const r = await listMeetingTypes(token);
      setRows(r.data);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">Meeting types</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Tenant-wide. The bot picks meeting type by slug. Each type owns its working hours, buffers,
            min-notice, max-horizon, and auto-invited guests.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Per-AI-employee access to the <code className="font-mono">schedule_meeting</code> tool is
            controlled in the agent's Permissions / Tools section.
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-sm shrink-0"
          onClick={() => setEditing("new")}
        >
          + New
        </button>
      </header>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>
      )}

      <div className="divide-y">
        {rows.length === 0 && (
          <div className="text-sm text-gray-500 py-3">No meeting types yet.</div>
        )}
        {rows.map((m) => (
          <div key={m.id} className="flex items-center justify-between py-3">
            <div className="min-w-0 pr-3">
              <div className="font-medium text-gray-900 truncate">
                {m.name}
                <span className="ml-2 text-xs font-mono text-gray-500">{m.slug}</span>
                {!m.isActive && <span className="ml-2 text-xs text-red-600">(inactive)</span>}
              </div>
              <div className="text-xs text-gray-600 truncate">
                {m.durationMinutes}min · {m.agentTimezone} · buffer {m.bufferBeforeMinutes}/{m.bufferAfterMinutes}min ·
                {" "}min notice {m.minNoticeHours}h · horizon {m.maxHorizonDays}d
                {m.autoGuests?.length > 0 && (
                  <> · auto-guests {m.autoGuests.length}</>
                )}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="text-sm text-blue-600" onClick={() => setEditing(m)}>Edit</button>
              <button
                className="text-sm text-red-600"
                onClick={async () => {
                  if (!token) return;
                  if (confirm(`Delete ${m.name}?`)) {
                    await deleteMeetingType(token, m.id);
                    await refresh();
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Editor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (!token) return;
            if (editing === "new") await createMeetingType(token, body);
            else await updateMeetingType(token, editing.id, body);
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Editor(props: {
  initial: MeetingTypeRow | null;
  onClose: () => void;
  onSave: (body: Partial<MeetingTypeRow>) => Promise<void>;
}) {
  const [slug, setSlug] = useState(props.initial?.slug || "");
  const [name, setName] = useState(props.initial?.name || "");
  const [duration, setDuration] = useState<15 | 30 | 45 | 60>(props.initial?.durationMinutes || 30);
  const [tz, setTz] = useState(props.initial?.agentTimezone || "Asia/Jerusalem");
  const [hours, setHours] = useState<DayWindow[]>(props.initial?.workingHours || DEFAULT_HOURS);
  const [bufBefore, setBufBefore] = useState(props.initial?.bufferBeforeMinutes ?? 15);
  const [bufAfter, setBufAfter] = useState(props.initial?.bufferAfterMinutes ?? 15);
  const [minNotice, setMinNotice] = useState(props.initial?.minNoticeHours ?? 4);
  const [maxHorizon, setMaxHorizon] = useState(props.initial?.maxHorizonDays ?? 30);
  const [isActive, setIsActive] = useState(props.initial?.isActive ?? true);
  const [autoGuests, setAutoGuests] = useState<string[]>(props.initial?.autoGuests ?? []);
  const [autoGuestDraft, setAutoGuestDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleDay(d: number) {
    setHours((prev) => {
      const has = prev.find((x) => x.weekday === d);
      if (has) return prev.filter((x) => x.weekday !== d);
      return [...prev, { weekday: d as 0 | 1 | 2 | 3 | 4 | 5 | 6, start: "09:00", end: "18:00" }];
    });
  }
  function setDayTime(d: number, key: "start" | "end", value: string) {
    setHours((prev) => prev.map((x) => (x.weekday === d ? { ...x, [key]: value } : x)));
  }
  function addAutoGuest() {
    const v = autoGuestDraft.trim();
    if (!v) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return;
    if (autoGuests.includes(v)) return;
    setAutoGuests((prev) => [...prev, v]);
    setAutoGuestDraft("");
  }
  function removeAutoGuest(email: string) {
    setAutoGuests((prev) => prev.filter((e) => e !== email));
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-end md:items-center justify-center p-2">
      <div className="bg-white w-full md:max-w-lg rounded-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-medium">{props.initial ? "Edit meeting type" : "New meeting type"}</h3>

        {err && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>
        )}

        <Field label="Slug (used by the bot)">
          <input
            disabled={!!props.initial}
            className="w-full border rounded px-2 py-1 text-sm font-mono"
            placeholder="discovery_call"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field label="Display name">
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Discovery Call"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duration">
            <select
              className="w-full border rounded px-2 py-1 text-sm"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) as 15 | 30 | 45 | 60)}
            >
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={45}>45 min</option>
              <option value={60}>60 min</option>
            </select>
          </Field>
          <Field label="Timezone (IANA)">
            <input
              className="w-full border rounded px-2 py-1 text-sm font-mono"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
            />
          </Field>
        </div>

        <fieldset className="border rounded p-3">
          <legend className="text-sm font-medium px-1">Working hours</legend>
          <div className="space-y-1">
            {WEEKDAYS.map((wname, i) => {
              const row = hours.find((x) => x.weekday === i);
              return (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!row} onChange={() => toggleDay(i)} />
                  <span className="w-12 font-mono">{wname}</span>
                  {row ? (
                    <>
                      <input type="time" value={row.start}
                        onChange={(e) => setDayTime(i, "start", e.target.value)}
                        className="border rounded px-1 py-0.5" />
                      <span>-</span>
                      <input type="time" value={row.end}
                        onChange={(e) => setDayTime(i, "end", e.target.value)}
                        className="border rounded px-1 py-0.5" />
                    </>
                  ) : (
                    <span className="text-gray-400">closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Buffer before (min)">
            <input type="number" className="w-full border rounded px-2 py-1 text-sm"
              value={bufBefore} onChange={(e) => setBufBefore(Number(e.target.value))} />
          </Field>
          <Field label="Buffer after (min)">
            <input type="number" className="w-full border rounded px-2 py-1 text-sm"
              value={bufAfter} onChange={(e) => setBufAfter(Number(e.target.value))} />
          </Field>
          <Field label="Min notice (h)">
            <input type="number" className="w-full border rounded px-2 py-1 text-sm"
              value={minNotice} onChange={(e) => setMinNotice(Number(e.target.value))} />
          </Field>
          <Field label="Max horizon (days)">
            <input type="number" className="w-full border rounded px-2 py-1 text-sm"
              value={maxHorizon} onChange={(e) => setMaxHorizon(Number(e.target.value))} />
          </Field>
        </div>

        <fieldset className="border rounded p-3 space-y-2">
          <legend className="text-sm font-medium px-1">Auto-invited guests</legend>
          <p className="text-xs text-gray-600">
            Emails added to every booked meeting (account manager, sales engineer…).
          </p>
          <div className="flex flex-wrap gap-1.5">
            {autoGuests.map((email) => (
              <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-xs">
                {email}
                <button type="button" className="text-gray-500 hover:text-red-600 ml-0.5"
                  onClick={() => removeAutoGuest(email)}>×</button>
              </span>
            ))}
            {autoGuests.length === 0 && <span className="text-xs text-gray-400 italic">none</span>}
          </div>
          <div className="flex gap-2">
            <input type="email" placeholder="account-manager@yourco.com"
              className="flex-1 border rounded px-2 py-1 text-sm"
              value={autoGuestDraft}
              onChange={(e) => setAutoGuestDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAutoGuest(); } }} />
            <button type="button" className="px-3 py-1 rounded border text-sm" onClick={addAutoGuest}>Add</button>
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (bot can use this meeting type)
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-1.5 rounded border text-sm" onClick={props.onClose}>Cancel</button>
          <button
            disabled={busy || !slug || !name}
            className="px-3 py-1.5 rounded bg-gray-900 text-white text-sm disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await props.onSave({
                  slug, name, durationMinutes: duration, agentTimezone: tz,
                  workingHours: hours, bufferBeforeMinutes: bufBefore,
                  bufferAfterMinutes: bufAfter, minNoticeHours: minNotice,
                  maxHorizonDays: maxHorizon, autoGuests, isActive,
                });
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700 block mb-1">{label}</span>
      {children}
    </label>
  );
}
