/**
 * Scheduler API helpers - meeting types + calendar account status.
 *
 * Mirrors the contract exposed by services/ai/src/routes/scheduler-admin.ts.
 * Token is the user's session token from AuthContext; the backend enforces
 * ADMIN role + active tenant.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function authedFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ─── Types ────────────────────────────────────────────────

export interface DayWindow {
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  start: string; // HH:MM
  end: string;   // HH:MM
}

export interface MeetingTypeRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: 15 | 30 | 45 | 60;
  agentTimezone: string;
  workingHours: DayWindow[];
  meetingTypeWindows: DayWindow[] | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  maxHorizonDays: number;
  slotResolutionMinutes: number;
  /** Emails always added to the calendar invite (e.g. account manager). */
  autoGuests: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarAccountRow {
  id: string;
  provider: "GOOGLE_CALENDAR" | "CALENDLY";
  status: "CONNECTED" | "BROKEN" | "DISCONNECTED";
  accountEmail: string | null;
  defaultCalendarId: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Meeting Types ────────────────────────────────────────

export function listMeetingTypes(token: string) {
  return authedFetch<{ data: MeetingTypeRow[] }>("/api/scheduler/meeting-types", token);
}

export function createMeetingType(token: string, body: Partial<MeetingTypeRow>) {
  return authedFetch<{ data: MeetingTypeRow }>("/api/scheduler/meeting-types", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateMeetingType(token: string, id: string, body: Partial<MeetingTypeRow>) {
  return authedFetch<{ data: MeetingTypeRow }>(`/api/scheduler/meeting-types/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteMeetingType(token: string, id: string) {
  return authedFetch<{ ok: true }>(`/api/scheduler/meeting-types/${id}`, token, { method: "DELETE" });
}

// ─── Calendar accounts ────────────────────────────────────

export function listCalendarAccounts(token: string, aiAgentId: string) {
  return authedFetch<{ data: CalendarAccountRow[] }>(
    `/api/scheduler/calendar-accounts?aiAgentId=${encodeURIComponent(aiAgentId)}`,
    token,
  );
}

export function getGoogleCalendarConnectUrl(token: string, aiAgentId: string) {
  // Marketplace catalog slug is `google_calendar` (underscore). The route
  // also accepts `google-calendar` for backward compat.
  return authedFetch<{ url: string }>(
    `/api/integrations/oauth/google_calendar/init?aiAgentId=${encodeURIComponent(aiAgentId)}`,
    token,
  );
}

export function getCalendlyConnectUrl(token: string, aiAgentId: string) {
  return authedFetch<{ url: string }>(
    `/api/integrations/oauth/calendly/init?aiAgentId=${encodeURIComponent(aiAgentId)}`,
    token,
  );
}

export function disconnectCalendar(token: string, aiAgentId: string, provider: "GOOGLE_CALENDAR" | "CALENDLY") {
  return authedFetch<{ ok: true }>("/api/integrations/calendar/disconnect", token, {
    method: "POST",
    body: JSON.stringify({ aiAgentId, provider }),
  });
}
