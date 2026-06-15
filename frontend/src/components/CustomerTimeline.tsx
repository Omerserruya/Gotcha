"use client";

import { useEffect, useState } from "react";
import { getCustomerTimeline } from "@/lib/gotcha-api";

interface Props {
  token: string;
  contactId: string;
}

interface TimelineEvent {
  type: "message";
  channel: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  createdAt: string;
}

/**
 * F1.5 - Minimal Unified Customer Timeline.
 * Renders the cross-channel event stream returned by
 * GET /api/identity/:id/timeline.
 */
export default function CustomerTimeline({ token, contactId }: Props) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [contactName, setContactName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res: any = await getCustomerTimeline(token, contactId);
        setContactName(res.contact?.displayName ?? null);
        setEvents(res.events ?? []);
      } catch (e: any) {
        setError(e?.message ?? "failed to load timeline");
      }
    })();
  }, [token, contactId]);

  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
      <strong>Timeline{contactName ? ` - ${contactName}` : ""}</strong>
      {error && <div style={{ color: "crimson" }}>{error}</div>}
      {events.length === 0 && !error && (
        <div style={{ color: "#888" }}>No events yet.</div>
      )}
      <ol style={{ listStyle: "none", padding: 0 }}>
        {events.map((e, i) => (
          <li key={i} style={{ borderBottom: "1px solid #eee", padding: "6px 0" }}>
            <span style={{ fontSize: 11, color: "#888" }}>
              {new Date(e.createdAt).toLocaleString()} • {e.channel} •{" "}
              {e.direction === "INBOUND" ? "→" : "←"}
            </span>
            <div style={{ fontSize: 13 }}>{e.body ?? "(no body)"}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
