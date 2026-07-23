// Legacy Settings routes → their canonical new homes.
//
// The Settings IA cleanup gave every configuration concept ONE canonical
// location (Settings owns workspace/business config; AI Studio owns tool,
// policy and HITL config). Old routes stay alive as redirects so saved
// links, bookmarks and in-product references never break. Persisted
// configuration is untouched - only the UI location moved.
//
// Exported as data (not buried in page files) so tests can assert the map
// and the redirect stubs stay in sync.

export const LEGACY_SETTINGS_REDIRECTS: Record<string, string> = {
  // Users + Departments merged into People & Teams (tabs).
  "/settings/users": "/settings/people?tab=users",
  "/settings/departments": "/settings/people?tab=departments",
  // Generic "Integrations" renamed: this page is the tenant's Source of
  // Truth / business-systems home, not a marketplace.
  "/settings/integrations": "/settings/business-systems",
  // Tool + policy configuration lives with the AI employees that use it.
  "/settings/tools": "/ai-studio?tab=skills&view=permissions",
  "/settings/policy": "/ai-studio?tab=skills&view=policies",
  "/settings/business-rules": "/ai-studio?tab=skills&view=policies",
  // Voice/phone is a communication channel: the list view now lives in
  // Channels (Voice section). Detail/new wizard routes are still real pages.
  "/settings/voice-channels": "/settings/channels",
};
