/**
 * CalendarPort — the concrete calendar surface the CALENDAR capability runs on.
 *
 * This is the ADAPTER boundary (Slice 2, Constraint 1): a port exposes only
 * concrete calendar I/O — read bookings, check if a time is open, compute slots,
 * create/move/cancel events. It contains NO business rules. Every business rule
 * (must have an email, no duplicate, existing booking present, unambiguous,
 * availability verified) lives ONCE in the operation contracts + verifiers
 * (calendar.runtime.ts), never in the port and never in the handlers.
 *
 * The production port (calendar.port.prod.ts) translates these calls to the
 * existing scheduling primitives (resolveAvailability + calendar adapters +
 * booking-store). Tests inject an in-memory fake. The contracts/resolver never
 * import either — the port is passed in.
 */

export interface CalendarOpContext {
  tenantId: string;
  conversationId: string;
  /** Stable customer key (channel external id) for booking-store scoping. */
  customerExternalId?: string;
  /** Email known from CRM/identity, if any (oracle input for attendee_email). */
  customerEmail?: string;
  /** AI agent whose calendar backs this conversation. */
  aiAgentId?: string;
}

export interface MeetingKind {
  slug: string;
  durationMinutes: number;
}

export interface CalendarBookingRef {
  eventId: string;
  startMs: number;
  endMs: number;
  meetingKind?: string;
  joinUrl?: string;
}

/** "ambiguous" = more than one configured kind and the hint didn't snap to one. */
export type ResolvedMeetingKind = MeetingKind | null | "ambiguous";

export interface CalendarPort {
  /** Concrete: ACTIVE bookings for the customer, soonest-first. */
  listActiveBookings(ctx: CalendarOpContext): Promise<CalendarBookingRef[]>;

  /** Concrete: snap the configured meeting types against an optional hint. */
  resolveMeetingKind(ctx: CalendarOpContext, hint?: string): Promise<ResolvedMeetingKind>;

  /** Concrete: is this exact time genuinely open for the kind? (point check) */
  isTimeOpen(ctx: CalendarOpContext, iso: string, kind: MeetingKind): Promise<boolean>;

  /** Concrete: real open slots for a window (read). */
  computeAvailability(
    ctx: CalendarOpContext,
    kind: MeetingKind,
    window?: { fromIso?: string; toIso?: string },
  ): Promise<{ slotsIso: string[] }>;

  /** Concrete: create event + persist booking (book). */
  createEvent(
    ctx: CalendarOpContext,
    input: { iso: string; email: string; kind: MeetingKind },
  ): Promise<CalendarBookingRef>;

  /** Concrete: move an existing event (reschedule). */
  moveEvent(
    ctx: CalendarOpContext,
    input: { booking: CalendarBookingRef; iso: string; kind: MeetingKind },
  ): Promise<CalendarBookingRef>;

  /** Concrete: cancel an existing event. */
  cancelEvent(ctx: CalendarOpContext, input: { booking: CalendarBookingRef }): Promise<void>;
}
