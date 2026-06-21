/**
 * Google Calendar adapter (Task 3).
 *
 * Implements `CalendarAdapter` from scheduling.service.ts using Google's
 * Calendar v3 REST API:
 *   - findBusy   → POST https://www.googleapis.com/calendar/v3/freeBusy
 *   - createEvent → POST https://www.googleapis.com/calendar/v3/calendars/{id}/events
 *
 * Token handling:
 *   - Loads `CalendarAccount.credentials` (encrypted JSON).
 *   - Refreshes the access token if it's expired or about to be (60s buffer).
 *   - On 401 from Google, refreshes once + retries; if refresh fails, marks
 *     the CalendarAccount status=BROKEN so the tool surface drops the tool.
 *
 * The adapter is deliberately small. The constraints layer (resolveAvailability)
 * does all the policy thinking - this file is just a network shim.
 */

import { prisma, encryptCredentials, decryptCredentials } from "@chatcenter/shared";
import type {
  CalendarAdapter,
  BusyInterval,
} from "../scheduling.service";
import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const EVENTS_URL = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  scope?: string;
  tokenType?: string;
}

export interface GoogleCalendarAdapterOpts {
  /** CalendarAccount.id - used to load + persist credentials. */
  calendarAccountId: string;
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly provider = "google" as const;

  constructor(private readonly opts: GoogleCalendarAdapterOpts) {}

  async findBusy(opts: { agentId: string; fromMs: number; toMs: number }): Promise<BusyInterval[]> {
    const { account, creds } = await this.loadAccount();
    const calendarId = account.defaultCalendarId || "primary";
    const body = {
      timeMin: new Date(opts.fromMs).toISOString(),
      timeMax: new Date(opts.toMs).toISOString(),
      items: [{ id: calendarId }],
    };
    console.log(
      `[gcal-adapter] freeBusy.POST calendar=${calendarId} ` +
        `from=${body.timeMin} to=${body.timeMax}`,
    );
    const t = Date.now();
    const res = await this.fetchAuthed(FREEBUSY_URL, { method: "POST", body: JSON.stringify(body) }, creds);
    const json: any = await res.json();
    const blocks: Array<{ start: string; end: string }> = json?.calendars?.[calendarId]?.busy ?? [];
    console.log(`[gcal-adapter] freeBusy.OK busy=${blocks.length} dt_ms=${Date.now() - t}`);
    return blocks.map((b) => ({
      startMs: Date.parse(b.start),
      endMs: Date.parse(b.end),
      source: "google",
    }));
  }

  async createEvent(opts: {
    agentId: string;
    startMs: number;
    endMs: number;
    customerEmail: string;
    customerTimezone?: string;
    title: string;
    notes?: string;
    additionalGuests?: string[];
  }): Promise<{ eventId: string; joinUrl?: string }> {
    const { account, creds } = await this.loadAccount();
    const calendarId = account.defaultCalendarId || "primary";
    const tz = opts.customerTimezone || "UTC";
    // Dedupe attendees + drop empties; the primary customer always first.
    const attendeeEmails = [opts.customerEmail, ...(opts.additionalGuests ?? [])]
      .map((e) => (e || "").trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const attendees = attendeeEmails
      .filter((e) => {
        const key = e.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((email) => ({ email }));
    const body: any = {
      summary: opts.title,
      description: opts.notes ?? "",
      start: { dateTime: new Date(opts.startMs).toISOString(), timeZone: tz },
      end: { dateTime: new Date(opts.endMs).toISOString(), timeZone: tz },
      attendees,
      conferenceData: {
        createRequest: {
          requestId: `gotcha-${opts.agentId}-${opts.startMs}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      reminders: { useDefault: true },
    };
    const url = `${EVENTS_URL(calendarId)}?conferenceDataVersion=1&sendUpdates=all`;
    console.log(
      `[gcal-adapter] events.insert.POST calendar=${calendarId} ` +
        `start=${body.start.dateTime} attendees=${attendees.length} (${attendees.map((a) => a.email).join(",") || "none"})`,
    );
    const t = Date.now();
    const res = await this.fetchAuthed(url, { method: "POST", body: JSON.stringify(body) }, creds);
    const json: any = await res.json();
    const joinUrl = json?.hangoutLink ?? json?.conferenceData?.entryPoints?.[0]?.uri;
    console.log(
      `[gcal-adapter] events.insert.OK eventId=${json?.id} ` +
        `meet=${joinUrl ? "yes" : "no"} dt_ms=${Date.now() - t}`,
    );
    return {
      eventId: String(json?.id ?? ""),
      joinUrl,
    };
  }

  /**
   * Read-only: list upcoming events in the window. Backs the
   * `google_calendar.list_events` tool surfaced via the adapter framework.
   */
  async listEvents(opts: { fromMs: number; toMs: number; max?: number }): Promise<
    Array<{ id: string; summary: string | null; start: string | null; end: string | null; attendees: string[] }>
  > {
    const { account, creds } = await this.loadAccount();
    const calendarId = account.defaultCalendarId || "primary";
    const params = new URLSearchParams({
      timeMin: new Date(opts.fromMs).toISOString(),
      timeMax: new Date(opts.toMs).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(Math.max(1, Number(opts.max) || 10), 50)),
    });
    const url = `${EVENTS_URL(calendarId)}?${params.toString()}`;
    const res = await this.fetchAuthed(url, { method: "GET" }, creds);
    const json: any = await res.json();
    const items: any[] = json?.items ?? [];
    return items.map((e) => ({
      id: String(e.id ?? ""),
      summary: e.summary ?? null,
      start: e.start?.dateTime ?? e.start?.date ?? null,
      end: e.end?.dateTime ?? e.end?.date ?? null,
      attendees: (e.attendees ?? []).map((a: any) => a.email).filter(Boolean),
    }));
  }

  // ─── Internals ─────────────────────────────────────────

  private async loadAccount(): Promise<{ account: any; creds: StoredCredentials }> {
    const account = await (prisma as any).calendarAccount.findUnique({
      where: { id: this.opts.calendarAccountId },
    });
    if (!account) throw new Error(`CalendarAccount ${this.opts.calendarAccountId} not found`);
    if (account.status !== "CONNECTED") throw new Error(`CalendarAccount status=${account.status}`);
    const creds = decryptCredentials(account.credentials) as StoredCredentials;
    if (!creds?.refreshToken) throw new Error("CalendarAccount missing refreshToken");
    return { account, creds };
  }

  private async fetchAuthed(
    url: string,
    init: RequestInit,
    creds: StoredCredentials,
    retried = false,
  ): Promise<Response> {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      ...(init.headers || {}),
    };
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && !retried) {
      const fresh = await this.refreshTokens(creds);
      return this.fetchAuthed(url, init, fresh, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google Calendar ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  private async refreshTokens(creds: StoredCredentials): Promise<StoredCredentials> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID/SECRET not configured");

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      // Permanent refresh failure → mark account broken so the tool surface drops.
      await (prisma as any).calendarAccount
        .update({
          where: { id: this.opts.calendarAccountId },
          data: { status: "BROKEN", lastError: `refresh_failed_${res.status}` },
        })
        .catch(() => undefined);
      throw new Error(`Google token refresh failed: ${res.status}`);
    }
    const json: any = await res.json();
    const next: StoredCredentials = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || creds.refreshToken,
      scope: json.scope,
      tokenType: json.token_type,
    };
    const expiresAt = new Date(Date.now() + (Number(json.expires_in || 3600) * 1000) - TOKEN_REFRESH_BUFFER_MS);
    await (prisma as any).calendarAccount.update({
      where: { id: this.opts.calendarAccountId },
      data: {
        credentials: encryptCredentials(next as any),
        tokenExpiresAt: expiresAt,
        lastError: null,
      },
    });
    return next;
  }
}

// ─── Provider-framework registration ─────────────────────────
//
// Makes Google Calendar a FIRST-CLASS adapter-framework provider (like Stripe,
// Airtable, HubSpot) so its READ tools surface + execute through the SAME
// connected-AND-allowed pipeline as every other integration — no calendar
// special-casing in the surface/dispatch layers. WRITES are intentionally NOT
// exposed here: booking goes through the validated `schedule_meeting` path
// (working hours / buffers / conflicts), so `create_event` is never surfaced to
// the model. The concrete per-agent calendar is resolved here (calendar
// capability is per-agent), keeping the framework contract unchanged.

const GCAL_READ_TOOLS: ToolDefinition[] = [
  {
    name: "google_calendar.check_availability",
    description: "Check the assigned agent's calendar for busy/free time in a window.",
    whenToUse: "You need to know when the agent is free before proposing or confirming times.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        from_iso: { type: "string", description: "Window start, ISO8601 with timezone offset." },
        to_iso: { type: "string", description: "Window end, ISO8601 with timezone offset." },
      },
      required: ["from_iso", "to_iso"],
    },
  },
  {
    name: "google_calendar.list_events",
    description: "List the assigned agent's upcoming calendar events in a window.",
    whenToUse: "You need to see existing events (e.g. to reference or avoid a clash) — read only.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        from_iso: { type: "string", description: "Window start, ISO8601 with timezone offset." },
        to_iso: { type: "string", description: "Window end, ISO8601 with timezone offset." },
        max: { type: "number", description: "Max events to return (default 10, max 50)." },
      },
      required: ["from_iso", "to_iso"],
    },
  },
];

/**
 * Resolve the per-agent CONNECTED Google calendar account for this conversation.
 * Calendar capability is per-agent (an agent books into a SPECIFIC calendar), so
 * the agent is taken from the conversation's assignment. Throws a clear error
 * (never a crash) when the agent has no connected calendar — the dispatcher
 * surfaces it as a structured failure.
 */
async function resolveAgentCalendarAccountId(tenantId: string, conversationId?: string): Promise<string> {
  if (!conversationId) throw new Error("calendar tools require a conversation context");
  const conv = await (prisma as any).conversation.findUnique({
    where: { id: conversationId },
    select: { assignedAiAgentId: true },
  });
  const aiAgentId = conv?.assignedAiAgentId;
  if (!aiAgentId) throw new Error("no_agent_assigned_to_conversation");
  const account = await (prisma as any).calendarAccount.findFirst({
    where: { tenantId, aiAgentId, provider: "GOOGLE_CALENDAR", status: "CONNECTED" },
    select: { id: true },
  });
  if (!account) throw new Error("no_connected_calendar_for_agent");
  return account.id;
}

export const GoogleCalendarProviderAdapter: ProviderAdapter = {
  slug: "google_calendar",
  tools: () => GCAL_READ_TOOLS,
  async execute({ ctx, toolName, args }) {
    const accountId = await resolveAgentCalendarAccountId(ctx.tenantId, ctx.conversationId);
    const cal = new GoogleCalendarAdapter({ calendarAccountId: accountId });
    const fromMs = Date.parse(String(args.from_iso ?? ""));
    const toMs = Date.parse(String(args.to_iso ?? ""));
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error("from_iso and to_iso must be valid ISO8601 timestamps");
    }
    const tool = toolName.includes(".") ? toolName.slice(toolName.indexOf(".") + 1) : toolName;
    if (tool === "check_availability") {
      const busy = await cal.findBusy({ agentId: "", fromMs, toMs });
      return { busy: busy.map((b) => ({ start: new Date(b.startMs).toISOString(), end: new Date(b.endMs).toISOString() })) };
    }
    if (tool === "list_events") {
      return { events: await cal.listEvents({ fromMs, toMs, max: Number(args.max) || 10 }) };
    }
    throw new Error(`unsupported google_calendar tool: ${tool}`);
  },
};

registerAdapter(GoogleCalendarProviderAdapter);
