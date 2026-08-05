"use client";

// Sub-page of /settings/channels, alongside twilio and shopify-live-chat.
//
// Deliberately NO <AppLayout> wrapper: SettingsLayout already supplies the app
// chrome and the settings nav to everything under /settings. Adding it here
// would render the shell twice and drop the user out of the settings context.

import { WhatsAppNumbersContent } from "./content";

export default function WhatsAppNumbersPage() {
  return <WhatsAppNumbersContent />;
}
