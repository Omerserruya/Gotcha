/**
 * Calendly adapter (Task 3).
 *
 * Calendly's model differs from Google's:
 *   - You don't book arbitrary times. You book a "scheduled event" against
 *     a Calendly Event Type, and Calendly enforces the host's availability
 *     itself (working hours, buffer, etc.) on its scheduling page.
 *   - The API exposes:
 *       GET /scheduled_events           - list booked events (use as busy)
 *       GET /event_types/{uuid}/available_times  - list available slots
 *       POST /scheduling_links          - generate a one-time invite URL
 *
 * Practical contract for this adapter:
 *   - findBusy(): pulls the user's `scheduled_events` in [from, to] and
 *     returns them as BusyInterval[]. resolveAvailability() then layers
 *     the tenant's buffer / working-hours rules on top, same as Google.
 *   - createEvent(): Calendly does NOT allow third-party event creation
 *     directly. We instead create a one-time scheduling link and return
 *     it as `joinUrl`. The customer follows the link, Calendly hosts the
 *     pick-time UI, and webhooks notify us of the actual booking.
 *
 * This is the right shape for a chat-bot integration - most teams already
 * use Calendly for the front door, and the bot's job is to send the link
 * with confidence the customer will see real availability.
 */

import { prisma, encryptCredentials, decryptCredentials } from "@chatcenter/shared";
import type {
  CalendarAdapter,
  BusyInterval,
} from "../scheduling.service";

const API_BASE = "https://api.calendly.com";
const TOKEN_URL = "https://auth.calendly.com/oauth/token";
const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  /** Calendly returns the user URI on the /users/me call; we cache it on the account row. */
  scope?: string;
  tokenType?: string;
}

export interface CalendlyAdapterOpts {
  calendarAccountId: string;
  /** Calendly Event Type URI used to generate scheduling links. */
  eventTypeUri?: string;
}

export class CalendlyAdapter implements CalendarAdapter {
  readonly provider = "calendly" as const;

  constructor(private readonly opts: CalendlyAdapterOpts) {}

  async findBusy(opts: { agentId: string; fromMs: number; toMs: number }): Promise<BusyInterval[]> {
    const { account, creds } = await this.loadAccount();
    const userUri = account.externalAccountId;
    if (!userUri) return [];

    const params = new URLSearchParams({
      user: userUri,
      min_start_time: new Date(opts.fromMs).toISOString(),
      max_start_time: new Date(opts.toMs).toISOString(),
      status: "active",
      count: "100",
    });
    const res = await this.fetchAuthed(`${API_BASE}/scheduled_events?${params.toString()}`, { method: "GET" }, creds);
    const json: any = await res.json();
    const events: any[] = Array.isArray(json?.collection) ? json.collection : [];
    return events.map((e) => ({
      startMs: Date.parse(e.start_time),
      endMs: Date.parse(e.end_time),
      source: "calendly",
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
  }): Promise<{ eventId: string; joinUrl?: string }> {
    const { creds } = await this.loadAccount();
    if (!this.opts.eventTypeUri) {
      throw new Error("CalendlyAdapter requires eventTypeUri to create scheduling links");
    }

    // One-time scheduling link - Calendly invalidates it after first use.
    // 7-day expiry is a sane default; the bot follow-up tool can refresh
    // the link if needed.
    const body = {
      max_event_count: 1,
      owner: this.opts.eventTypeUri,
      owner_type: "EventType",
    };
    const res = await this.fetchAuthed(
      `${API_BASE}/scheduling_links`,
      { method: "POST", body: JSON.stringify(body) },
      creds,
    );
    const json: any = await res.json();
    const link = json?.resource?.booking_url;
    if (!link) throw new Error("Calendly scheduling_links did not return booking_url");
    return {
      eventId: String(json.resource.uri || link),
      joinUrl: link,
    };
  }

  // ─── Internals ─────────────────────────────────────────

  private async loadAccount(): Promise<{ account: any; creds: StoredCredentials }> {
    const account = await (prisma as any).calendarAccount.findUnique({
      where: { id: this.opts.calendarAccountId },
    });
    if (!account) throw new Error(`CalendarAccount ${this.opts.calendarAccountId} not found`);
    if (account.status !== "CONNECTED") throw new Error(`CalendarAccount status=${account.status}`);
    const creds = decryptCredentials(account.credentials) as StoredCredentials;
    if (!creds?.accessToken) throw new Error("CalendarAccount missing accessToken");
    return { account, creds };
  }

  private async fetchAuthed(
    url: string,
    init: RequestInit,
    creds: StoredCredentials,
    retried = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      ...((init.headers as Record<string, string>) || {}),
    };
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && !retried && creds.refreshToken) {
      const fresh = await this.refreshTokens(creds);
      return this.fetchAuthed(url, init, fresh, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Calendly ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  private async refreshTokens(creds: StoredCredentials): Promise<StoredCredentials> {
    const clientId = process.env.CALENDLY_CLIENT_ID;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("CALENDLY_CLIENT_ID/SECRET not configured");

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      await (prisma as any).calendarAccount
        .update({
          where: { id: this.opts.calendarAccountId },
          data: { status: "BROKEN", lastError: `calendly_refresh_failed_${res.status}` },
        })
        .catch(() => undefined);
      throw new Error(`Calendly token refresh failed: ${res.status}`);
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
