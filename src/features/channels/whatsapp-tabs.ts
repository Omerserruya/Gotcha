/** 13b's tabs, in order. Plain data: the server page and the client tab bar both read it. */
export const WHATSAPP_TABS = ['numbers', 'templates', 'contacts', 'activity'] as const;
export type WhatsAppTab = (typeof WHATSAPP_TABS)[number];

/** `?tab=` as one of the panel's tabs; anything else is Numbers. */
export function tabOf(value: string | undefined): WhatsAppTab {
  return (WHATSAPP_TABS as readonly string[]).includes(value ?? '')
    ? (value as WhatsAppTab)
    : 'numbers';
}
