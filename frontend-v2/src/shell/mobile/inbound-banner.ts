/**
 * Which incoming message gets a banner inside the app (Omer, 2026-11-04):
 * a customer's message, in a conversation that is the viewer's or nobody's,
 * that is not the one already on screen. Pure, so the rule is tested alone.
 */
export interface BannerGlance {
  readonly access: 'visible' | 'refused' | 'failed';
  readonly assignedAgentId: string | null;
}

export function wantsBanner({
  direction,
  conversationId,
  openId,
  glance,
  meId,
}: {
  readonly direction: 'INBOUND' | 'OUTBOUND' | null | undefined;
  readonly conversationId: string;
  readonly openId: string | null;
  readonly glance: BannerGlance;
  readonly meId: string | null;
}): boolean {
  if (direction !== 'INBOUND') return false;
  if (conversationId === openId) return false;
  if (glance.access !== 'visible') return false;
  if (glance.assignedAgentId === null) return true;
  return meId !== null && glance.assignedAgentId === meId;
}

/** The conversation open on the phone: `/m/inbox/<id>` (with or without a locale), else null. */
export function openPhoneConversation(pathname: string): string | null {
  const match = /\/m\/inbox\/([^/?#]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}
