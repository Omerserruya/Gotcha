import { resolveTourMock } from "./tour-mock";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function apiFetch<T = any>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers: extraHeaders, ...rest } = options;

  // Guided-tour demo mode: while the tour walks an empty inbox, the inbox /
  // copilot endpoints answer from local fixtures (see lib/tour-mock.ts).
  const mocked = resolveTourMock(path, String(rest.method || "GET").toUpperCase());
  if (mocked !== undefined) return JSON.parse(JSON.stringify(mocked)) as T;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((extraHeaders as Record<string, string>) || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, { headers, ...rest });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // Additive: the message is unchanged for existing callers, but the status
    // and structured code are attached so a caller can branch on WHICH failure
    // it was rather than pattern-matching prose.
    const err = new Error(body.error || `Request failed: ${res.status}`) as Error & {
      status?: number; code?: string; body?: unknown;
    };
    err.status = res.status;
    err.code = body.code ?? body.error;
    err.body = body;
    throw err;
  }

  return res.json();
}

// ─── Waitlist (public, no auth) ──────────────────────────────

export function submitWaitlistEntry(data: {
  firstName: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  companySize?: string;
  companyDomain?: string;
  frustration?: string;
  source?: string;
}) {
  return apiFetch<{ data: { id: string } }>("/api/waitlist", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ─── Auth ───────────────────────────────────────────────────
//
// Only the profile lookup lives here. Login, refresh, and every password
// operation are Authentik's - see @/lib/oidc. There is no GOTCHA endpoint that
// accepts a credential.

export function getMe(token: string) {
  return apiFetch<{
    user: any;
    tenantStatus?: string;
    tenantName?: string | null;
    memberships?: any[];
  }>("/api/auth/me", { token });
}

/** Every workspace this identity belongs to (for the tenant picker). */
export function getMemberships(token: string) {
  return apiFetch<{ memberships: any[]; lastTenantId: string | null; activeTenantId: string | null }>(
    "/api/auth/me/memberships",
    { token },
  );
}

/** Validate + stamp a workspace switch; the caller then reloads with the new X-Tenant-Id. */
export function postSwitchTenant(token: string, tenantId: string) {
  return apiFetch<{ userId: string; role: string; tenant: any }>("/api/auth/me/switch-tenant", {
    token,
    method: "POST",
    body: JSON.stringify({ tenantId }),
  });
}

// ─── Conversations ──────────────────────────────────────────

export function getConversations(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; meta: any }>(`/api/conversations${qs}`, { token });
}

export function getConversation(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}`, { token });
}

export function claimConversation(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}/claim`, {
    token,
    method: "POST",
  });
}

export function releaseConversation(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}/release`, {
    token,
    method: "POST",
  });
}

export function returnConversationToAi(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}/return-to-ai`, {
    token,
    method: "POST",
  });
}

export function reassignConversation(token: string, id: string, agentId: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}/reassign`, {
    token,
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
}

export function closeConversation(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${id}/close`, {
    token,
    method: "POST",
  });
}

// ─── Conversation History ────────────────────────────────────

export function getConversationHistory(token: string, customerExternalId: string, conversationId?: string) {
  // Passing the anchor `conversationId` lets the backend hit the linked CRM
  // record and pull cross-platform identifiers (phone, email, every
  // gotcha_psid_*) so the returned history spans WhatsApp + Instagram +
  // Messenger + voice + email for the same person.
  const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  return apiFetch<{ data: any[] }>(`/api/conversations/history/${encodeURIComponent(customerExternalId)}${qs}`, { token });
}

// ─── Messages ───────────────────────────────────────────────

export function getMessages(token: string, conversationId: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; meta: any }>(
    `/api/conversations/${conversationId}/messages${qs}`,
    { token }
  );
}

export function sendMessage(token: string, conversationId: string, body: string) {
  return apiFetch<{ data: any }>(
    `/api/conversations/${conversationId}/messages`,
    { token, method: "POST", body: JSON.stringify({ body }) }
  );
}

export async function sendMediaMessage(token: string, conversationId: string, file: File, caption?: string) {
  const formData = new FormData();
  formData.append("file", file);
  if (caption) formData.append("body", caption);

  const res = await fetch(`${API_URL}/api/conversations/${conversationId}/messages/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }

  return res.json() as Promise<{ data: any }>;
}

// ─── Analytics ──────────────────────────────────────────────

export function getDashboardStats(token: string) {
  return apiFetch<{ data: any }>("/api/analytics/dashboard", { token });
}

export function getAgentStats(token: string) {
  return apiFetch<{ data: any[] }>("/api/analytics/agents", { token });
}

export function getHourlyVolume(token: string, date?: string) {
  const qs = date ? `?date=${date}` : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/hourly${qs}`, { token });
}

export function getDailyVolume(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/daily${qs}`, { token });
}

export function getQueueStats(token: string) {
  return apiFetch<{ data: any }>("/api/analytics/queue", { token });
}

// ─── Chatbot Flows ──────────────────────────────────────────

export function getChatbotFlows(token: string, channel?: string | null) {
  const params = channel !== undefined ? `?channel=${channel === null ? "null" : channel}` : "";
  return apiFetch<any[]>(`/api/chatbot-flows${params}`, { token });
}

export function getChatbotFlow(token: string, id: string) {
  return apiFetch<any>(`/api/chatbot-flows/${id}`, { token });
}

export function createChatbotFlow(token: string, data: any) {
  return apiFetch<any>("/api/chatbot-flows", {
    token,
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateChatbotFlow(token: string, id: string, data: any) {
  return apiFetch<any>(`/api/chatbot-flows/${id}`, {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteChatbotFlow(token: string, id: string) {
  return apiFetch<any>(`/api/chatbot-flows/${id}`, { token, method: "DELETE" });
}

export function activateChatbotFlow(token: string, id: string) {
  return apiFetch<any>(`/api/chatbot-flows/${id}/activate`, {
    token,
    method: "POST",
  });
}

export function deactivateChatbotFlow(token: string, id: string) {
  return apiFetch<any>(`/api/chatbot-flows/${id}`, {
    token,
    method: "PUT",
    body: JSON.stringify({ isActive: false }),
  });
}

// ─── Agents ─────────────────────────────────────────────────

export function getAgents(token: string) {
  return apiFetch<any[]>("/api/agents", { token });
}

// Inviting an agent takes no password: the invitee sets their own inside
// Authentik via the returned setupLink.
export function createAgent(token: string, data: { name: string; email: string; departmentIds?: string[] }) {
  return apiFetch<any>("/api/agents", {
    token,
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateAgent(
  token: string,
  id: string,
  data: { name?: string; isActive?: boolean; phoneNumber?: string | null },
) {
  return apiFetch<any>(`/api/agents/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteAgent(token: string, id: string) {
  return apiFetch<any>(`/api/agents/${id}`, { token, method: "DELETE" });
}

// Issues a fresh Authentik password-setup link for an agent. An admin can
// restore access without ever choosing or seeing someone else's credential.
export function resetAgentPassword(token: string, id: string) {
  return apiFetch<{ success: boolean; setupLink: string }>(`/api/agents/${id}/reset-password`, { token, method: "POST" });
}

export function assignAgentToDepartment(token: string, departmentId: string, userId: string, departmentRole?: string) {
  return apiFetch<any>(`/api/departments/${departmentId}/members`, { token, method: "POST", body: JSON.stringify({ userId, departmentRole }) });
}

export function removeAgentFromDepartment(token: string, departmentId: string, userId: string) {
  return apiFetch<any>(`/api/departments/${departmentId}/members/${userId}`, { token, method: "DELETE" });
}

// ─── Channel Accounts (legacy) ─────────────────────────────

export function getChannelAccounts(token: string) {
  return apiFetch<{ data: any[] }>("/api/channels", { token });
}

export function createChannelAccount(token: string, data: { channel: string; externalId: string; displayName: string; credentials: any }) {
  return apiFetch<{ data: any }>("/api/agents/settings/channels", {
    token,
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateChannelAccount(token: string, id: string, data: any) {
  return apiFetch<{ data: any }>(`/api/agents/settings/channels/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteChannelAccount(token: string, id: string) {
  return apiFetch<any>(`/api/agents/settings/channels/${id}`, { token, method: "DELETE" });
}

// ─── Channel Connection (OAuth / Embedded Signup) ───────────

export function getChannels(token: string) {
  return apiFetch<{ data: any[] }>("/api/channels", { token });
}

// Health counts only (no tokens/ids), readable by EVERY tenant member - the
// Inbox/History empty states use it to explain WHY a list is empty.
export interface ChannelsSummary {
  total: number;
  connected: number;
  unhealthy: number;
  pending: number;
}

export function getChannelsSummary(token: string) {
  return apiFetch<{ data: ChannelsSummary }>("/api/channels/summary", { token });
}

// Provider OAuth/app configuration state (which providers CAN be connected
// in this environment) - drives honest "Requires setup" cards.
export function getChannelsOauthConfig(token: string) {
  return apiFetch<{ data: { metaAppId?: string; oauthConfigured: boolean; whatsappConfigured: boolean; providers?: Record<string, boolean> } }>(
    "/api/channels/config",
    { token },
  );
}

// Completes a WhatsApp connection whose OAuth callback could not auto-detect
// the WABA (redirected back with ?connected=whatsapp&pending=true).
export function connectWhatsappSession(token: string, data: { wabaId: string; phoneNumberId?: string }) {
  return apiFetch<{ data: any[] }>("/api/channels/connect/whatsapp-session", {
    token,
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Recent posts for a Facebook/Instagram channel - used by the Comment
// Trigger inspector to let users pick a post by clicking instead of
// pasting an ID. Group posts are not supported (Meta Groups API was
// deprecated April 2024); the inspector exposes a manual URL field for
// those.
export interface ChannelPost {
  id: string;
  caption: string;
  thumbnailUrl: string | null;
  permalink: string | null;
  createdAt: string | null;
  source: "page";
}
export function getChannelPosts(token: string, channelId: string, limit = 20) {
  return apiFetch<{ data: ChannelPost[] }>(`/api/channels/${channelId}/posts?limit=${limit}`, { token });
}

export function getChannelConfig2(token: string) {
  return apiFetch<{ data: any }>("/api/channels/config", { token });
}

export function connectWhatsApp(
  token: string,
  code: string,
  sessionInfo?: { wabaId?: string; phoneNumberId?: string },
) {
  return apiFetch<{ data: any[] }>("/api/channels/connect/whatsapp", {
    token,
    method: "POST",
    body: JSON.stringify({
      code,
      wabaId: sessionInfo?.wabaId,
      phoneNumberId: sessionInfo?.phoneNumberId,
    }),
  });
}

export function connectEmail(token: string, data: {
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPass?: string;
}) {
  return apiFetch<{ data: any[] }>("/api/channels/connect/email", {
    token,
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function disconnectChannel(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/channels/${id}/disconnect`, {
    token,
    method: "POST",
  });
}

export function getChannelStatus(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/channels/${id}/status`, { token });
}

export function createWebchatWidget(token: string, name?: string) {
  return apiFetch<{ data: any }>("/api/channels/webchat/create", {
    token, method: "POST", body: JSON.stringify({ name })
  });
}

export function getWebchatSettings(token: string, accountId: string) {
  return apiFetch<{ data: any }>(`/api/channels/webchat/${accountId}/settings`, { token });
}

/**
 * The website widget's configuration.
 *
 * Accepts the canonical shape (the same experience block the storefront
 * widget uses) and, for anything not yet updated, the old flat fields —
 * the server migrates those on the way in.
 */
export function updateWebchatSettings(token: string, accountId: string, settings: Record<string, unknown>) {
  return apiFetch<{ data: any }>(`/api/channels/webchat/${accountId}/settings`, {
    token, method: "PUT", body: JSON.stringify(settings)
  });
}

// ─── Shopify Live Chat ─────────────────────────────────────
//
// Merchant-facing surface only. The storefront widget talks to
// /api/shopify-chat with a signed visitor session and never uses any of
// these — nothing here should ever be reachable without a staff token.

export interface ShopifyLiveChatChannel {
  id: string;
  publicKey: string;
  displayName: string;
  connectionStatus: string;
  config: any;
  createdAt: string;
  updatedAt: string;
}

export function getShopifyStore(token: string) {
  return apiFetch<{ data: any }>("/api/shopify-live-chat/store", { token });
}

export function listShopifyLiveChatChannels(token: string) {
  return apiFetch<{ data: ShopifyLiveChatChannel[] }>("/api/shopify-live-chat/channels", { token });
}

export function createShopifyLiveChatChannel(token: string, displayName?: string) {
  return apiFetch<{ data: ShopifyLiveChatChannel }>("/api/shopify-live-chat/channels", {
    token,
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
}

export function updateShopifyLiveChatChannel(
  token: string,
  channelId: string,
  payload: { config?: any; displayName?: string },
) {
  return apiFetch<{ data: ShopifyLiveChatChannel }>(
    `/api/shopify-live-chat/channels/${channelId}`,
    { token, method: "PUT", body: JSON.stringify(payload) },
  );
}

export function deleteShopifyLiveChatChannel(token: string, channelId: string) {
  return apiFetch<{ data: { deleted: boolean } }>(
    `/api/shopify-live-chat/channels/${channelId}`,
    { token, method: "DELETE" },
  );
}

export function getShopifyLiveChatDiagnostics(token: string, channelId: string) {
  return apiFetch<{ data: any }>(
    `/api/shopify-live-chat/channels/${channelId}/diagnostics`,
    { token },
  );
}

export function getShopifyLiveChatInstall(token: string, channelId: string) {
  return apiFetch<{ data: any }>(`/api/shopify-live-chat/channels/${channelId}/install`, { token });
}

export function searchShopifyProducts(
  token: string,
  query: string,
  opts: { limit?: number; includeUnpublished?: boolean } = {},
) {
  const params = new URLSearchParams({ q: query });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.includeUnpublished) params.set("includeUnpublished", "true");
  return apiFetch<{ data: { shopDomain: string; currency: string; products: any[] } }>(
    `/api/shopify-live-chat/products?${params.toString()}`,
    { token },
  );
}

export function sendShopifyProductMessage(
  token: string,
  conversationId: string,
  payload: {
    products: Array<{ productId?: string; handle?: string; variantId?: string; reason?: string }>;
    text?: string;
  },
) {
  return apiFetch<{ data: { messageId: string; productCount: number } }>(
    `/api/shopify-live-chat/conversations/${conversationId}/products`,
    { token, method: "POST", body: JSON.stringify(payload) },
  );
}

// ─── Shopify CHAT app install (App Store flow) ─────────────
//
// Distinct from the Shopify Live Chat channel calls above: those configure
// a channel that already exists, these turn a verified Shopify install into
// one. The install itself is identified by an HttpOnly cookie set by the
// OAuth callback; `session` is the fallback for browsers that dropped it.

export type ShopifyChatActivationState =
  | "APP_NOT_INSTALLED"
  | "INSTALLATION_UNBOUND"
  | "CHANNEL_NOT_CREATED"
  | "TENANT_INACTIVE"
  | "ENTITLEMENT_DISABLED"
  | "EMBED_NOT_ENABLED"
  | "EMBED_ENABLED_NOT_SEEN"
  | "STALE"
  | "UNINSTALLED"
  | "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"
  | "LIVE";

export interface ShopifyChatActivation {
  state: ShopifyChatActivationState;
  shopDomain: string;
  channelId: string | null;
  channelEnabled: boolean;
  productMessaging: boolean;
  coreConnected: boolean;
  verifiedDomains: string[];
  themeEditorDeepLink: string | null;
  lastHeartbeatAt: string | null;
}

export interface ShopifyChatInstallContext {
  shopDomain: string;
  status: "PENDING" | "ACTIVE" | "UNINSTALLED";
  alreadyBound: boolean;
  boundToThisOrganization: boolean;
  claimedByAnotherOrganization: boolean;
  appAdminLink: string | null;
}

function installQuery(session?: string | null): string {
  return session ? `?session=${encodeURIComponent(session)}` : "";
}

export function getShopifyChatInstallContext(token: string, session?: string | null) {
  return apiFetch<{ data: ShopifyChatInstallContext }>(
    `/api/shopify-chat-install/context${installQuery(session)}`,
    { token },
  );
}

export function bindShopifyChatInstall(token: string, session?: string | null) {
  return apiFetch<{
    data: {
      channelId: string;
      channelCreated: boolean;
      shopDomain: string;
      activation: ShopifyChatActivation;
    };
  }>("/api/shopify-chat-install/bind", {
    token,
    method: "POST",
    body: JSON.stringify({ session: session ?? undefined }),
  });
}

export function getShopifyChatActivation(token: string, opts: { shop?: string; session?: string | null } = {}) {
  const params = new URLSearchParams();
  if (opts.shop) params.set("shop", opts.shop);
  if (opts.session) params.set("session", opts.session);
  const qs = params.toString();
  return apiFetch<{ data: ShopifyChatActivation }>(
    `/api/shopify-chat-install/activation${qs ? `?${qs}` : ""}`,
    { token },
  );
}

export function refreshShopifyChatDomains(token: string, shop: string) {
  return apiFetch<{ data: { verifiedDomains: string[] } }>(
    "/api/shopify-chat-install/refresh-domains",
    { token, method: "POST", body: JSON.stringify({ shop }) },
  );
}

// ─── Tenant Channel Config ─────────────────────────────────

export function getChannelConfig(token: string) {
  return apiFetch<{ data: any }>("/api/agents/settings/channel-config", { token });
}

export function updateChannelConfig(token: string, data: { botFlowMode: string }) {
  return apiFetch<{ data: any }>("/api/agents/settings/channel-config", {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ─── Auto-Greeting Settings ────────────────────────────────

export function getAutoGreeting(token: string) {
  return apiFetch<{ template: string }>("/api/agents/settings/auto-greeting", { token });
}

export function updateAutoGreeting(token: string, template: string) {
  return apiFetch<{ template: string }>("/api/agents/settings/auto-greeting", {
    token,
    method: "PUT",
    body: JSON.stringify({ template }),
  });
}

// ─── SLA Settings ───────────────────────────────────────────

export function getSlaSettings(token: string) {
  return apiFetch<any>("/api/agents/settings/sla", { token });
}

export function updateSlaSettings(token: string, data: any) {
  return apiFetch<any>("/api/agents/settings/sla", {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function getDepartmentSla(token: string, departmentId: string) {
  return apiFetch<any>(`/api/agents/settings/sla/department/${departmentId}`, { token });
}

export function updateDepartmentSla(token: string, departmentId: string, data: any) {
  return apiFetch<any>(`/api/agents/settings/sla/department/${departmentId}`, {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ─── Idle Automation Settings ───────────────────────────────

export function getIdleAutomation(token: string) {
  return apiFetch<any>("/api/agents/settings/idle-automation", { token });
}

export function updateIdleAutomation(token: string, data: any) {
  return apiFetch<any>("/api/agents/settings/idle-automation", {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ─── Copilot Settings ───────────────────────────────────────

export function getCopilotSettings(token: string) {
  return apiFetch<any>("/api/agents/settings/copilot", { token });
}

export function updateCopilotSettings(token: string, data: any) {
  return apiFetch<any>("/api/agents/settings/copilot", {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ─── Departments ────────────────────────────────────────────

export function getDepartments(token: string) {
  return apiFetch<{ data: any[] }>("/api/departments", { token });
}

export function createDepartment(token: string, data: { name: string; description?: string; queueMode?: string }) {
  return apiFetch<{ data: any }>("/api/departments", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function updateDepartment(token: string, id: string, data: { name?: string; description?: string; queueMode?: string; isActive?: boolean }) {
  return apiFetch<{ data: any }>(`/api/departments/${id}`, {
    token, method: "PATCH", body: JSON.stringify(data),
  });
}

export function deleteDepartment(token: string, id: string) {
  return apiFetch<any>(`/api/departments/${id}`, { token, method: "DELETE" });
}

export function getDepartmentMembers(token: string, departmentId: string) {
  return apiFetch<{ data: any[] }>(`/api/departments/${departmentId}/members`, { token });
}

export function addDepartmentMember(token: string, departmentId: string, data: { userId: string; departmentRole?: string }) {
  return apiFetch<{ data: any }>(`/api/departments/${departmentId}/members`, {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function updateDepartmentMember(token: string, departmentId: string, userId: string, data: { departmentRole: string }) {
  return apiFetch<{ data: any }>(`/api/departments/${departmentId}/members/${userId}`, {
    token, method: "PATCH", body: JSON.stringify(data),
  });
}

export function removeDepartmentMember(token: string, departmentId: string, userId: string) {
  return apiFetch<any>(`/api/departments/${departmentId}/members/${userId}`, { token, method: "DELETE" });
}

export function getDepartmentCopilot(token: string, departmentId: string) {
  return apiFetch<{ data: any; source: string }>(`/api/departments/${departmentId}/copilot`, { token });
}

export function updateDepartmentCopilot(token: string, departmentId: string, data: any) {
  return apiFetch<{ data: any }>(`/api/departments/${departmentId}/copilot`, {
    token, method: "PUT", body: JSON.stringify(data),
  });
}

export function transferToDepartment(token: string, conversationId: string, departmentId: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${conversationId}/reassign`, {
    token, method: "POST", body: JSON.stringify({ departmentId }),
  });
}

// ─── AI Assist ──────────────────────────────────────────────

export function getAISuggestions(
  token: string,
  conversationId: string,
  locale?: string,
  signal?: AbortSignal,
  // Per-invocation idempotency key - the backend dedup layer collapses
  // repeated requests with the same id into one execution and short-
  // circuits retries. Callers SHOULD generate a fresh id per
  // user-meaningful trigger (new inbound message, manual refresh click)
  // and reuse it across automatic retries.
  requestInstanceId?: string,
) {
  const params = locale ? `?locale=${locale}` : "";
  const extraHeaders: Record<string, string> = {};
  if (requestInstanceId) extraHeaders["X-Request-Instance-Id"] = requestInstanceId;
  return apiFetch<{ data: any[]; copilotMode?: string }>(
    `/api/ai-assist/${conversationId}/suggestions${params}`,
    { token, signal, headers: extraHeaders },
  );
}

export function getAIPrompt(token: string, departmentId: string) {
  return apiFetch<{ data: any }>(`/api/ai-assist/prompt/${departmentId}`, { token });
}

export function getAISummary(token: string, conversationId: string, locale?: string, signal?: AbortSignal) {
  const params = locale ? `?locale=${locale}` : "";
  return apiFetch<{ data: { summary: string }; copilotMode?: string }>(`/api/ai-assist/${conversationId}/summary${params}`, { token, signal });
}

export function sendCopilotChat(token: string, conversationId: string, data: { message: string; history?: Array<{ role: string; content: string }>; locale?: string }) {
  return apiFetch<{ data: { reply: string } }>(`/api/ai-assist/${conversationId}/chat`, {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function composeAIMessage(
  token: string,
  params: {
    instruction: string;
    surface: "template" | "scheduled" | "inbox" | "command-center";
    conversationId?: string;
    channel?: string;
    locale?: string;
    currentDraft?: string;
    asTemplate?: boolean;
  },
) {
  return apiFetch<{ data: { text: string; surface: string } }>(`/api/ai-assist/compose`, {
    token, method: "POST", body: JSON.stringify(params),
  });
}

// ─── Business Hours Settings ────────────────────────────────

export function getBusinessHours(token: string) {
  return apiFetch<any>("/api/agents/settings/business-hours", { token });
}

export function updateBusinessHours(token: string, data: any) {
  return apiFetch<any>("/api/agents/settings/business-hours", {
    token,
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ─── Tenant Settings (default phone country, etc.) ──────────

export function getTenantSettings(token: string) {
  return apiFetch<{
    data: {
      defaultCountryCode: string;
      supportedCountries: Array<{ code: string; callingCode: string }>;
      // Phase 1 - Live Call CoPilot feature flags. Optional for back-compat
      // with older API revisions that don't ship them yet.
      voiceCopilotEnabled?: boolean;
      voiceInboxUiEnabled?: boolean;
      voiceIncomingEnabled?: boolean;
    };
  }>("/api/tenant-settings", { token });
}

export function updateTenantSettings(token: string, data: { defaultCountryCode: string }) {
  return apiFetch<{ data: { defaultCountryCode: string } }>("/api/tenant-settings", {
    token,
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ─── Workload ───────────────────────────────────────────────

export function getAgentWorkload(token: string) {
  return apiFetch<{ data: any[] }>("/api/conversations/stats/workload", { token });
}

// ─── System Admin ───────────────────────────────────────────

export function getSystemStats(token: string) {
  return apiFetch<{ data: any }>("/api/system/stats", { token });
}

export function getSystemTenants(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; meta: any }>(`/api/system/tenants${qs}`, { token });
}

export function getSystemTenant(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${id}`, { token });
}

/**
 * Billing is REQUIRED, and is one of exactly two shapes.
 *
 * Typed as a union rather than a bag of optional fields so that omitting the
 * commercial decision - or sending a POC budget on a paid plan - does not
 * compile. The server refuses both anyway; this is so nobody writes it.
 */
export type CreateTenantBilling =
  | {
      mode: "PAID_PLAN";
      planVersionId: string;
      chatVolumeOptionKey?: string | null;
      voiceVolumeOptionKey?: string | null;
      paymentRequiredBeforeAccess?: boolean;
      commercialNote?: string;
    }
  | {
      mode: "POC";
      pocCredits: number;
      pocExpiresAt: string;
      pocFeatureAreas: string[];
      commercialNote?: string;
    };

export function createTenant(
  token: string,
  data: { name: string; slug: string; adminEmail: string; adminName: string; billing: CreateTenantBilling },
) {
  return apiFetch<{ data: any }>("/api/system/tenants", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateTenant(token: string, id: string, data: { name?: string; isActive?: boolean }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function createTenantUser(token: string, tenantId: string, data: { email: string; name: string; role?: string }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/users`, { token, method: "POST", body: JSON.stringify(data) });
}

export function updateTenantUser(token: string, tenantId: string, userId: string, data: { isActive?: boolean; role?: string; name?: string; email?: string }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/users/${userId}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteTenantUser(token: string, tenantId: string, userId: string) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/users/${userId}`, { token, method: "DELETE" });
}

// ─── System Admin: Onboarding Console + Reset + Nudge ───────
export interface OnboardingConsoleRow {
  tenantId: string;
  company: string;
  slug: string;
  status: string;
  createdAt: string;
  discoveryComplete: boolean;
  reviewComplete: boolean;
  goalSelected: boolean;
  crmConnected: boolean;
  crmSlug: string | null;
  channelsConnected: number;
  integrationsConnected: number;
  knowledgeCount: number;
  knowledgeStatus: "none" | "detected" | "imported";
  aiEmployeeCreated: boolean;
  aiEmployeeName: string | null;
  currentStage: string;
  progressPct: number;
  health: "activated" | "on_track" | "at_risk" | "stuck";
  nextRecommendedAction: string;
  lastActivity: string;
  lastNudgeSentAt: string | null;
  gaps: string[];
  primaryGoal: string | null;
  assignedCsm: string | null;
}
export function getOnboardingConsole(token: string) {
  return apiFetch<{ data: { rows: OnboardingConsoleRow[]; generatedAt: string } }>("/api/system/onboarding-console", { token });
}
export function resetTenantOnboarding(token: string, tenantId: string) {
  return apiFetch<{ data: { reset: boolean; removed: Record<string, number>; status: string } }>(
    `/api/system/tenants/${tenantId}/reset-onboarding`,
    { token, method: "POST" },
  );
}
export function sendTenantNudge(token: string, tenantId: string) {
  return apiFetch<{ data: { outcome: "sent" | "skipped" | "failed" | "no_admin"; reason?: string } }>(
    `/api/system/tenants/${tenantId}/nudge`,
    { token, method: "POST" },
  );
}

export function resendOnboardingLink(token: string, tenantId: string) {
  return apiFetch<{ data: { message: string; sentTo: string } }>(`/api/system/tenants/${tenantId}/resend-onboarding`, {
    token, method: "POST",
  });
}

// ─── System Admin Chat (RAG) ────────────────────────────────

export function getSystemKnowledgeBases(token: string) {
  return apiFetch<{ data: any[] }>("/api/system-chat/knowledge-bases", { token });
}

export function createSystemKnowledgeBase(token: string, data: { name: string; description?: string }) {
  return apiFetch<{ data: any }>("/api/system-chat/knowledge-bases", { token, method: "POST", body: JSON.stringify(data) });
}

export function deleteSystemKnowledgeBase(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/system-chat/knowledge-bases/${id}`, { token, method: "DELETE" });
}

export function uploadSystemDocument(token: string, kbId: string, data: { title: string; content: string }) {
  return apiFetch<{ data: any }>(`/api/system-chat/knowledge-bases/${kbId}/documents`, { token, method: "POST", body: JSON.stringify(data) });
}

export async function uploadSystemFile(token: string, kbId: string, file: File, title: string) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", title);

  const res = await fetch(`${API_URL}/api/system-chat/knowledge-bases/${kbId}/documents/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }

  return res.json();
}

export function processSystemDocument(token: string, kbId: string, docId: string) {
  return apiFetch<{ data: any }>(`/api/system-chat/knowledge-bases/${kbId}/documents/${docId}/process`, { token, method: "POST" });
}

export function deleteSystemDocument(token: string, kbId: string, docId: string) {
  return apiFetch<{ data: any }>(`/api/system-chat/knowledge-bases/${kbId}/documents/${docId}`, { token, method: "DELETE" });
}

export function askSystemChat(token: string, data: { question: string; history: { role: string; content: string }[] }) {
  return apiFetch<{ answer: string; sources: { documentTitle: string; score: number }[] }>("/api/system-chat/ask", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function getTokenUsage(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{
    totals: { promptTokens: number; completionTokens: number; totalTokens: number; count: number };
    breakdown: any[];
  }>(`/api/system-chat/token-usage${qs}`, { token });
}

export function getTokenUsageByTenants(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/system-chat/token-usage/tenants${qs}`, { token });
}

// ─── Onboarding ────────────────────────────────────────────

export function getOnboardingStatus(token: string) {
  return apiFetch<{ data: any }>("/api/onboarding/status", { token });
}

export function saveBusinessProfile(token: string, data: {
  organizationName: string;
  businessDescription: string;
  locale?: string;
  // Onboarding v2 - multi-select goals + the original domain the user
  // typed so we can re-run the analysis later from settings.
  businessGoals?: string[];
  websiteDomain?: string;
  // Onboarding refactor - structured understanding confirmed in Gate 1.
  industry?: string;
  country?: string;
  primaryLanguage?: string;
  // Legacy fields - kept optional so callers outside the flow
  // (e.g. settings) can still patch them; onboarding ignores them.
  businessPriority?: string;
  estimatedDailyConversations?: number;
  numberOfAgents?: number;
}) {
  return apiFetch<{ data: any }>("/api/onboarding/business-profile", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

// Onboarding refactor - analyze a domain to AI-understand the business.
export interface BusinessUnderstanding {
  name: string;
  industry: string;
  country: string;
  language: string;
  description: string;
  /** Best-matching Industry Intelligence Pack slug, or "" if none. */
  packSlug?: string;
}
export interface AnalyzeDomainResult {
  ok: boolean;
  domain?: string;
  description?: string;
  understanding?: BusinessUnderstanding;
  reason?: "invalid_domain" | "fetch_failed" | "ai_unavailable" | "no_summary";
}
// ─── Onboarding Intelligence Engine (Business Discovery) ─────
// The deep 5-domain scan + report + health + first recommendation. Powers
// Movements 1-5 of the onboarding experience.
export type FindingConfidence = "confirmed" | "likely" | "low" | "needs_verification" | "unknown";
export interface DiscoveryChannel { type: string; identifier?: string; purpose?: string; confidence: FindingConfidence; provider?: string }
export interface DiscoveryTechItem { slug: string; name: string; category?: string; confidence?: FindingConfidence }
export interface DiscoveryTech {
  platform: { slug: string; name: string; confidence: FindingConfidence } | null;
  legacy: Array<{ slug: string; name: string }>;
  tracking: Array<{ slug: string; name: string }>;
  tools: DiscoveryTechItem[];
}
export interface PolicyFinding { found: boolean | null; confidence: FindingConfidence; url?: string }
export interface DiscoveryBrand {
  personality?: string; voice?: string; tone?: string; style?: string; audience?: string; positioning?: string;
  vocabulary?: string[]; preferredTerminology?: string[]; forbiddenWords?: string[]; ctaStyle?: string;
  greetingExample?: string; languages?: string[]; confidence?: FindingConfidence;
}
export interface DiscoveryGap {
  id: string;
  domain: "brand" | "business" | "knowledge" | "communication" | "technology" | "customers";
  label: string;
  severity: "high" | "medium" | "low";
  ask: string;
  confidence?: FindingConfidence;
}
export interface DiscoveryRecommendation {
  employeeRole: "customer_support" | "sales" | "reception" | "conversation_intelligence";
  employeeName: string;
  reason: string;
  systems: Array<{ slug: string; reason: string; alreadyDetected?: boolean }>;
  knowledge: Array<{ label: string; reason: string }>;
  channel?: string;
}
export interface BusinessDiscoveryRecord {
  status: "PENDING" | "SCANNING" | "COMPLETE" | "FAILED";
  websiteDomain?: string | null;
  brand?: DiscoveryBrand | null;
  business?: {
    name?: string; country?: string; industry?: string; icp?: string; personas?: string[];
    products?: string[]; services?: string[]; pricingModel?: string; valueProp?: string;
    businessModel?: string; summary?: string; confidence?: FindingConfidence;
  } | null;
  knowledge?: {
    hasFaq?: boolean; hasHelpCenter?: boolean; hasDocs?: boolean;
    policies?: Record<string, PolicyFinding>; articleCountEstimate?: number | null; topics?: string[];
  } | null;
  communication?: { channels: DiscoveryChannel[] } | null;
  technology?: DiscoveryTech | null;
  gaps?: DiscoveryGap[] | null;
  recommendation?: DiscoveryRecommendation | null;
  health?: HealthReport | null;
  confidence?: Record<string, number> | null;
  report?: string | null;
  primaryGoal?: string | null;
  scannedAt?: string | null;
  // Live scan phase written at REAL boundaries by /discover
  // (homepage → pages → synthesis → done|failed). Polled by the ceremony.
  scanPhase?: string | null;
  // Resume checkpoint (P0): last movement reached (review..ready).
  progress?: string | null;
  // Movement 8 tune-chat transcript (bounded), so a reload resumes the chat.
  tuneTranscript?: Array<{ role: "user" | "assistant"; content: string }> | null;
}
export interface HealthItem { label: string; ok: boolean }
export interface HealthReport { knowledge: HealthItem[]; communication: HealthItem[]; tools: HealthItem[] }

// Persistent recommendation backlog (living AI backlog).
export interface RecommendationRow {
  id: string; kind: string; title: string; reason?: string | null; action?: string | null;
  targetSlug?: string | null; confidence: string; priority: number; status: string;
  payload?: Record<string, any> | null; completedAt?: string | null;
}
export function getRecommendations(token: string, status = "OPEN") {
  return apiFetch<{ data: { recommendations: RecommendationRow[] } }>(`/api/onboarding/recommendations?status=${encodeURIComponent(status)}`, { token });
}
export function resolveRecommendation(token: string, id: string, decision: "complete" | "dismiss" | "reopen") {
  return apiFetch<{ data: { id: string; status: string } }>(`/api/onboarding/recommendations/${id}/${decision}`, { token, method: "POST" });
}
export function teachGap(token: string, label: string, method: "text" | "url" | "file", value: string) {
  return apiFetch<{ data: { ok: boolean; reason?: string; knowledgeDocumentId?: string; documentId?: string } }>("/api/onboarding/teach", {
    token, method: "POST", body: JSON.stringify({ label, method, value }),
  });
}

/** Per-document outcome of a knowledge sync. Mirrors SyncReport in services/auth. */
export interface KnowledgeSyncReport {
  ok: boolean;
  knowledgeBaseId: string | null;
  added: number;
  updated: number;
  unchanged: number;
  preserved: number;
  removed: number;
  failed: number;
  details: Array<{
    dedupeKey: string;
    title?: string;
    action: "create" | "update" | "unchanged" | "preserved" | "remove" | "failed";
    documentId?: string;
    reason?: string;
  }>;
}

export function discoverBusiness(token: string, domain: string, locale?: string) {
  return apiFetch<{ data: {
    ok: boolean; domain?: string; reason?: string;
    discovery?: BusinessDiscoveryRecord;
    signals?: { channels: string[]; technology: string[] };
    // Honest ingestion outcome. `null` means the projection threw: the UI must
    // say the knowledge sync failed rather than imply the KB is populated.
    knowledge?: KnowledgeSyncReport | null;
  } }>(
    "/api/onboarding/discover",
    { token, method: "POST", body: JSON.stringify({ domain, locale }) },
  );
}
// Fast, LLM-free plan for the discovery ceremony: business-typed steps that
// reflect the real work the scan will do (Movement 1 - dynamic loader).
export function discoverPlan(token: string, domain: string, locale?: string) {
  return apiFetch<{ data: { ok: boolean; businessType: string; steps: Array<{ key: string; label: string }> } }>(
    "/api/onboarding/discover/plan",
    { token, method: "POST", body: JSON.stringify({ domain, locale }) },
  );
}
export function getBusinessDiscovery(token: string) {
  return apiFetch<{ data: { discovery: BusinessDiscoveryRecord | null } }>("/api/onboarding/discovery", { token });
}
export function patchBusinessDiscovery(token: string, patch: { business?: Record<string, unknown>; brand?: Record<string, unknown>; communication?: { channels: Array<Record<string, unknown>> }; progress?: string; employeeName?: string }) {
  return apiFetch<{ data: { discovery: BusinessDiscoveryRecord } }>("/api/onboarding/discovery", {
    token, method: "PATCH", body: JSON.stringify(patch),
  });
}
export function getBusinessHealth(token: string) {
  return apiFetch<{ data: { health: HealthReport | null; gaps?: DiscoveryGap[] } }>("/api/onboarding/health", { token });
}
// Per-item correction on the reflected-back portrait (Movement 2): remove /
// mark-incorrect / ignore a detected channel, tool, platform, or gap. Persists
// immediately so the AI never re-surfaces it.
export function correctDiscovery(token: string, target: "channel" | "tool" | "platform" | "gap", action: "remove" | "incorrect" | "ignore", key: string) {
  return apiFetch<{ data: { ok: boolean; discovery: BusinessDiscoveryRecord } }>("/api/onboarding/discovery/correct", {
    token, method: "POST", body: JSON.stringify({ target, action, key }),
  });
}
// Movement 8 - chat with the recommended employee before deploy; the returned
// persona reflects any tuning the owner asked for ("be friendlier", …).
export interface EmployeePersona { tone?: string; personality?: string; focus?: string; goal?: string; successCriteria?: string[]; instructions?: string[] }
export function employeeChat(token: string, messages: Array<{ role: "user" | "assistant"; content: string }>, persona?: EmployeePersona, locale?: string) {
  return apiFetch<{ data: { ok: boolean; reply?: string; persona?: EmployeePersona } }>("/api/onboarding/employee-chat", {
    token, method: "POST", body: JSON.stringify({ messages, persona, locale }),
  });
}
// Persist the tuned persona WITHOUT a chat turn - used when the owner adds a
// standing rule via a quick-tune chip (rules land in the rules row, never in
// the transcript).
export function saveTunedPersona(token: string, persona: EmployeePersona) {
  return apiFetch<{ data: { ok: boolean; persona?: EmployeePersona } }>("/api/onboarding/employee-chat", {
    token, method: "POST", body: JSON.stringify({ personaOnly: true, persona }),
  });
}
// Tell the GOTCHA team about an integration we don't support yet (the owner
// flagged it during onboarding). Best-effort - resolves ok even if mail isn't
// configured server-side, so the UI can always confirm the click.
export function notifyIntegrationRequest(token: string, integration: string, opts?: { note?: string; source?: string }) {
  const body: Record<string, unknown> = { integration };
  if (opts?.note?.trim()) body.note = opts.note.trim();
  if (opts?.source) body.source = opts.source;
  return apiFetch<{ data: { ok: boolean; notified: boolean } }>("/api/onboarding/notify-integration", {
    token, method: "POST", body: JSON.stringify(body),
  });
}

export function saveOnboardingGoal(token: string, goals: string | string[], detail?: string) {
  // Accepts a single goal (legacy) or multiple selected use-cases.
  const list = Array.isArray(goals) ? goals : [goals];
  const body: Record<string, unknown> = { goals: list };
  if (detail?.trim()) body.detail = detail.trim();
  return apiFetch<{ data: { primaryGoal: string; goals: string[] } }>("/api/onboarding/goal", {
    token, method: "POST", body: JSON.stringify(body),
  });
}

// Onboarding refactor - record the chosen system of truth (Gate 2).
export type CoreSystemSlug = "hubspot" | "salesforce" | "zoho_crm" | "shopify" | "fireberry" | "airtable";
export function setCoreSystem(token: string, slug: CoreSystemSlug) {
  return apiFetch<{ data: { primarySystem: string; connectedSlug: string | null; connected: boolean } }>(
    "/api/onboarding/core-system",
    { token, method: "POST", body: JSON.stringify({ slug }) },
  );
}

// API-key style connect (Fireberry tokenid, and other API_KEY integrations).
export function connectApiKeyIntegration(token: string, slug: string, credentials: Record<string, string>, config?: Record<string, unknown>) {
  return apiFetch<{ ok: boolean }>(`/api/connectors/${slug}/connect`, {
    token, method: "POST", body: JSON.stringify({ credentials, config: config || {} }),
  });
}

// ─── Airtable as CRM source - base/table/column mapping (post-OAuth) ──
export type AirtableMeta = { id: string; name: string };
export type AirtableField = { id: string; name: string; type: string };
export function airtableListBasesOnboarding(token: string) {
  return apiFetch<{ data: AirtableMeta[] }>("/api/connectors/airtable/oauth/bases", { token });
}
export function airtableListTablesOnboarding(token: string, baseId: string) {
  return apiFetch<{ data: AirtableMeta[] }>(`/api/connectors/airtable/oauth/tables?baseId=${encodeURIComponent(baseId)}`, { token });
}
export function airtableListFieldsOnboarding(token: string, baseId: string, tableId: string) {
  return apiFetch<{ data: AirtableField[] }>(`/api/connectors/airtable/oauth/fields?baseId=${encodeURIComponent(baseId)}&tableId=${encodeURIComponent(tableId)}`, { token });
}
export interface AirtableMappingPayload {
  baseId: string;
  tableId: string;
  fieldMap: { email?: string; phone?: string; display_name?: string; stage?: string };
  notesField?: string;
  idempotencyField?: string;
  createMissing?: boolean;
}
export function saveAirtableMapping(token: string, payload: AirtableMappingPayload) {
  return apiFetch<{ data: { id: string; config: Record<string, unknown> } | null; warning?: string }>(
    "/api/connectors/airtable/mapping",
    { token, method: "POST", body: JSON.stringify(payload) },
  );
}

// Setup Hub - non-linear setup map tiles + done flags.
export type SetupTileId = "knowledge_base" | "ai_employees" | "workflows" | "settings" | "channels" | "integrations";
export interface SetupTile {
  id: SetupTileId;
  done: boolean;
  deepLink: string;
  stage: "core" | "later";
  meta?: { slug?: string | null };
}
// Persistent guidance layer - per-feature first-time state.
export type GuideState = "unseen" | "snoozed" | "done";
export function getOnboardingGuides(token: string) {
  return apiFetch<{ data: { guides: Record<string, GuideState> } }>("/api/onboarding/guides", { token });
}
export function patchOnboardingGuide(token: string, feature: string, state: GuideState) {
  return apiFetch<{ data: { guides: Record<string, GuideState> } }>("/api/onboarding/guides", {
    token, method: "PATCH", body: JSON.stringify({ feature, state }),
  });
}

// Onboarding v2 - invite teammates by email (magic-link based).
export interface InviteTeamResult {
  email: string;
  status: "sent" | "exists" | "failed";
  error?: string;
}
export function inviteTeam(token: string, emails: string[], role?: "ADMIN" | "AGENT") {
  return apiFetch<{ data: { results: InviteTeamResult[] } }>("/api/onboarding/invite-team", {
    token, method: "POST", body: JSON.stringify({ emails, role: role || "AGENT" }),
  });
}

// Onboarding v2 - generate a shareable tenant invite link.
export function createInviteLink(token: string, role?: "ADMIN" | "AGENT") {
  return apiFetch<{ data: { url: string; token: string; expiresAt: string } }>("/api/onboarding/invite-link", {
    token, method: "POST", body: JSON.stringify({ role: role || "AGENT" }),
  });
}

// Public - fetch invite details by token (used by /join page).
export function getPublicInvite(inviteToken: string) {
  return apiFetch<{ data: { tenant: { name: string; slug: string }; email: string | null; role: string } }>(`/api/public/onboarding/invite/${encodeURIComponent(inviteToken)}`, {});
}

// Public - accept an invite (creates the user / sets their password).
// No password: accepting an invite links the person to the tenant and returns
// the one-time Authentik link where they set their own credential.
export function acceptPublicInvite(payload: { token: string; name: string; email?: string }) {
  return apiFetch<{ data: { ok: true; tenantId: string; setupLink: string } }>("/api/public/onboarding/invite/accept", {
    method: "POST", body: JSON.stringify(payload),
  });
}

export type OnboardingMissionId =
  | "connect_source_of_truth"
  | "connect_channel"
  | "add_webchat"
  | "teach_knowledge";

export interface OnboardingMission {
  id: OnboardingMissionId;
  status: "done" | "active" | "pending";
  deepLink: string;
  /** Live detail - e.g. detected channel identifiers or an open-gaps count. */
  hint?: string;
}

export function getOnboardingMissions(token: string) {
  return apiFetch<{ data: { missions: OnboardingMission[] } }>("/api/onboarding/missions", { token });
}

// Setup readiness (GET /onboarding/journey) - THE canonical five-action
// checklist. Every milestone is live-derived server-side from persisted
// state; the page, the sidebar panel, and the nav badge all read this.
export type JourneyMilestoneId =
  | "connect_source_of_truth"
  | "connect_channel"
  | "connect_knowledge"
  | "create_ai_employee"
  | "create_process";

export type JourneyMilestoneState = "done" | "in_progress" | "attention" | "not_started";

export interface JourneyMilestone {
  id: JourneyMilestoneId;
  done: boolean;
  state: JourneyMilestoneState;
  /** Legacy tri-state: done / first-incomplete / rest. */
  status: "done" | "active" | "pending";
  deepLink: string;
  manageLink?: string;
  hint?: string;
}

export interface JourneyData {
  complete: boolean;
  summary: { done: number; total: number };
  employee: { id: string; name: string; role: string | null; status: string } | null;
  business: { name: string | null; industry: string | null };
  context: {
    coreSystem: string | null;
    kbCount: number;
    channelHint: string | null;
    detectedChannelCount: number;
  };
  milestones: JourneyMilestone[];
}

export function getOnboardingJourney(token: string) {
  return apiFetch<{ data: JourneyData }>("/api/onboarding/journey", { token });
}

export function saveOnboardingDepartments(token: string, data: { departments: any[] }) {
  return apiFetch<{ data: any[] }>("/api/onboarding/departments", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function getOnboardingDepartments(token: string) {
  return apiFetch<{ data: any[] }>("/api/onboarding/departments", { token });
}

export function completeOnboarding(token: string, opts?: { skipCoreSystem?: boolean; skipEmployee?: boolean }) {
  return apiFetch<{ data: any }>("/api/onboarding/complete", {
    token, method: "POST",
    body: JSON.stringify({ skipCoreSystem: opts?.skipCoreSystem === true, skipEmployee: opts?.skipEmployee === true }),
  });
}

// ─── First-Take-Care AI Agent ──────────────────────────────

export function getFirstTakeCareSettings(token: string) {
  return apiFetch<{ data: any; enabled: boolean }>("/api/agents/settings/first-take-care", { token });
}

export function updateFirstTakeCareSettings(token: string, data: any) {
  return apiFetch<{ data: any }>("/api/agents/settings/first-take-care", {
    token, method: "PUT", body: JSON.stringify(data),
  });
}

// ─── Bot Config ─────────────────────────────────────────────

export function getBotConfig(token: string) {
  return apiFetch<{ data: { botEnabled: boolean; botType: string | null } }>("/api/agents/settings/bot-config", { token });
}

export function updateBotConfig(token: string, tenantId: string, data: { botEnabled: boolean; botType?: string }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/bot-config`, {
    token, method: "PATCH", body: JSON.stringify(data),
  });
}

export function toggleFirstTakeCare(token: string, tenantId: string, enabled: boolean) {
  return apiFetch<{ data: { enabled: boolean } }>(`/api/system/tenants/${tenantId}/first-take-care`, {
    token, method: "PATCH", body: JSON.stringify({ enabled }),
  });
}

// ─── Onboarding AI Chat ────────────────────────────────────

export function sendOnboardingChatMessage(token: string, data: { message: string; context?: any }) {
  return apiFetch<{ data: { reply: string; readyToGenerate?: boolean } }>("/api/onboarding/ai-chat", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function generateOnboardingConfigs(token: string) {
  return apiFetch<{ data: any }>("/api/onboarding/generate-configs", {
    token, method: "POST",
  });
}

// ─── Knowledge Base ─────────────────────────────────────────

export function getKnowledgeBases(token: string) {
  return apiFetch<{ data: any[] }>("/api/knowledge-bases", { token });
}

export function createKnowledgeBase(token: string, data: { name: string; description?: string }) {
  return apiFetch<{ data: any }>("/api/knowledge-bases", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateKnowledgeBase(token: string, id: string, data: { name?: string; description?: string; isActive?: boolean }) {
  return apiFetch<{ data: any }>(`/api/knowledge-bases/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteKnowledgeBase(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/knowledge-bases/${id}`, { token, method: "DELETE" });
}

export function uploadKnowledgeDocument(token: string, kbId: string, data: { title: string; content: string; sourceType?: string; sourceUrl?: string }) {
  return apiFetch<{ data: any }>(`/api/knowledge-bases/${kbId}/documents`, { token, method: "POST", body: JSON.stringify(data) });
}

export function deleteKnowledgeDocument(token: string, kbId: string, docId: string) {
  return apiFetch<{ data: any }>(`/api/knowledge-bases/${kbId}/documents/${docId}`, { token, method: "DELETE" });
}

export function processKnowledgeDocument(token: string, kbId: string, docId: string) {
  return apiFetch<{ data: any }>(`/api/knowledge-bases/${kbId}/documents/${docId}/process`, { token, method: "POST" });
}

export async function uploadKnowledgeFile(token: string, kbId: string, file: File, title: string) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", title);

  const res = await fetch(`${API_URL}/api/knowledge-bases/${kbId}/documents/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }

  return res.json();
}

// ─── Knowledge Integrations ─────────────────────────────────

export function getKnowledgeIntegrations(token: string, kbId: string) {
  return apiFetch<{ data: any[] }>(`/api/knowledge/kb/${kbId}/integrations`, { token });
}

export function deleteKnowledgeIntegration(token: string, intId: string) {
  return apiFetch<{ data: any }>(`/api/knowledge/integrations/${intId}`, { token, method: "DELETE" });
}

export function initConfluenceOAuth(token: string, kbId: string) {
  return apiFetch<{ url: string }>(`/api/knowledge/oauth/confluence/init?kbId=${kbId}`, { token });
}

export function initGoogleDriveOAuth(token: string, kbId: string, flow?: "onboarding") {
  return apiFetch<{ url: string }>(`/api/knowledge/oauth/google-drive/init?kbId=${kbId}${flow ? `&flow=${flow}` : ""}`, { token });
}

export function getConfluenceSpaces(token: string, intId: string) {
  return apiFetch<{ data: any[] }>(`/api/knowledge/integrations/${intId}/confluence/spaces`, { token });
}

export function getConfluencePages(token: string, intId: string, spaceKey: string, parentId?: string) {
  const qs = parentId ? `?parentId=${parentId}` : "";
  return apiFetch<{ data: any[] }>(`/api/knowledge/integrations/${intId}/confluence/spaces/${spaceKey}/pages${qs}`, { token });
}

export function syncConfluenceSpaces(token: string, intId: string, spaceKeys: string[]) {
  return apiFetch<{ data: any }>(`/api/knowledge/integrations/${intId}/confluence/sync`, {
    token, method: "POST", body: JSON.stringify({ spaceKeys }),
  });
}

export function getDriveFiles(token: string, intId: string, folderId?: string, driveId?: string) {
  const params = new URLSearchParams();
  if (folderId) params.set("folderId", folderId);
  if (driveId) params.set("driveId", driveId);
  const qs = params.toString() ? `?${params}` : "";
  return apiFetch<{ data: any[] }>(`/api/knowledge/integrations/${intId}/drive/files${qs}`, { token });
}

export function getDriveSharedDrives(token: string, intId: string) {
  return apiFetch<{ data: any[] }>(`/api/knowledge/integrations/${intId}/drive/shared-drives`, { token });
}

export function syncDriveFiles(token: string, intId: string, fileIds: string[]) {
  return apiFetch<{ data: any }>(`/api/knowledge/integrations/${intId}/drive/sync`, {
    token, method: "POST", body: JSON.stringify({ fileIds }),
  });
}

// Enable/disable hourly background auto-sync for a connected source.
export function setKnowledgeIntegrationAutoSync(token: string, intId: string, enabled: boolean) {
  return apiFetch<{ data: { autoSync: boolean } }>(`/api/knowledge/integrations/${intId}/auto-sync`, {
    token, method: "PATCH", body: JSON.stringify({ enabled }),
  });
}

// ─── Delete Operations ──────────────────────────────────────

export function deleteTenant(token: string, id: string, force?: boolean) {
  const qs = force ? "?force=true" : "";
  return apiFetch<{ data: any }>(`/api/system/tenants/${id}${qs}`, { token, method: "DELETE" });
}

export function deleteConversation(token: string, id: string, force?: boolean) {
  const qs = force ? "?force=true" : "";
  return apiFetch<{ data: any }>(`/api/conversations/${id}${qs}`, { token, method: "DELETE" });
}

export function deleteMessage(token: string, conversationId: string, messageId: string) {
  return apiFetch<{ data: any }>(`/api/conversations/${conversationId}/messages/${messageId}`, { token, method: "DELETE" });
}

// ─── Leads CRM (System Admin) ───────────────────────────────

export function getLeads(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(
    `/api/waitlist/leads${qs}`, { token }
  );
}

export function getLeadStats(token: string) {
  return apiFetch<{ data: { total: number; new: number; contacted: number; approved: number; rejected: number; recentWeek: number } }>(
    "/api/waitlist/leads/stats", { token }
  );
}

export function updateLead(token: string, id: string, data: { status?: string; notes?: string; leadScore?: number }) {
  return apiFetch<{ data: any }>(`/api/waitlist/leads/${id}`, {
    token, method: "PATCH", body: JSON.stringify(data),
  });
}

export function deleteLead(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/waitlist/leads/${id}`, { token, method: "DELETE" });
}

export function exportLeadsCsv(token: string, status?: string) {
  const qs = status ? `?status=${status}` : "";
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
  return fetch(`${API_BASE}/api/waitlist/leads/export${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Analytics - Advanced ───────────────────────────────────

export function getAnalyticsOverview(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any }>(`/api/analytics/overview${qs}`, { token });
}

export function getTopQuestions(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/top-questions${qs}`, { token });
}

export function getToolUsageStats(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/tool-usage${qs}`, { token });
}

export function getChannelPerformance(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/channel-performance${qs}`, { token });
}

export function getDepartmentPerformance(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/analytics/department-performance${qs}`, { token });
}

export function getAIInsights(token: string) {
  return apiFetch<{ data: any[] }>("/api/analytics/insights", { token });
}

export function getAIPerformance(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any }>(`/api/analytics/ai-performance${qs}`, { token });
}

export function getConversationIntelligence(token: string, conversationId: string, signal?: AbortSignal) {
  return apiFetch<{ data: any }>(`/api/ai-assist/${conversationId}/intelligence`, { token, signal });
}

export function getConversationReplay(token: string, conversationId: string) {
  return apiFetch<{ data: any }>(`/api/ai-assist/${conversationId}/replay`, { token });
}

export function executeToolInConversation(token: string, conversationId: string, tenantToolId: string, input?: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/ai-assist/${conversationId}/tools/execute`, {
    token, method: "POST", body: JSON.stringify({ tenantToolId, input: input || {} }),
  });
}

// ─── Integrations Marketplace ────────────────────────────────

export function getMarketplaceIntegrations(token: string) {
  return apiFetch<{ data: any[] }>("/api/integrations", { token });
}

export function getMarketplaceIntegration(token: string, slug: string) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}`, { token });
}

export function connectIntegration(token: string, slug: string, credentials: Record<string, any>, config?: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/connect`, {
    token, method: "POST", body: JSON.stringify({ credentials, config }),
  });
}

export function testIntegration(token: string, slug: string) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/test`, { token, method: "POST" });
}

export function disconnectIntegration(token: string, slug: string) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/disconnect`, { token, method: "POST" });
}

export function updateIntegrationCredentials(token: string, slug: string, credentials: Record<string, any>, config?: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/credentials`, {
    token, method: "PUT", body: JSON.stringify({ credentials, ...(config ? { config } : {}) }),
  });
}

export function getIntegrationTools(token: string, slug: string, opts?: { aiAgentId?: string }) {
  const qs = opts?.aiAgentId ? `?aiAgentId=${encodeURIComponent(opts.aiAgentId)}` : "";
  return apiFetch<{ data: any[] }>(`/api/integrations/${slug}/tools${qs}`, { token });
}

export function toggleIntegrationTool(token: string, slug: string, toolSlug: string, isEnabled: boolean) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/tools/${toolSlug}`, {
    token, method: "PUT", body: JSON.stringify({ isEnabled }),
  });
}

/**
 * Opt an integration in/out as the tenant's CRM source of truth. Today only
 * Shopify supports this - when on, the bot reads customer context (and writes
 * notes/tags) from Shopify instead of any CRM-category integration.
 */
export function setIntegrationCrmSource(token: string, slug: string, useAsCrm: boolean) {
  return apiFetch<{ data: { id: string; useAsCrm: boolean } }>(`/api/integrations/${slug}/crm-source`, {
    token, method: "PUT", body: JSON.stringify({ useAsCrm }),
  });
}

/** The tenant's elected customer system of record, as the AI-side resolver
 *  sees it, with the provider's truthful capability set. */
export interface SourceOfTruthStatus {
  configured: boolean;
  vendor: string | null;
  capabilities: string[];
  unsupported?: string[];
  writesEnabled?: boolean;
}
export function getSourceOfTruthStatus(token: string) {
  return apiFetch<{ data: SourceOfTruthStatus }>(`/api/integrations/source-of-truth`, { token });
}

/**
 * Toggle a single tool for one AI agent. Writes `AgentToolPermission`.
 * Use after `toggleIntegrationTool` so the underlying `TenantTool` is
 * also enabled - both layers must be true for the bot to see the tool.
 */
export function toggleAgentTool(
  token: string,
  agentId: string,
  tenantToolId: string,
  isAllowed: boolean,
  requireApproval?: boolean,
) {
  return apiFetch<{ data: any }>(`/api/ai-agents/${agentId}/tools/${tenantToolId}`, {
    token,
    method: "PUT",
    body: JSON.stringify({ isAllowed, ...(typeof requireApproval === "boolean" ? { requireApproval } : {}) }),
  });
}

/**
 * Kick off the OAuth flow for an integration. Routes by slug:
 *   - zoho_crm / google_calendar / calendly → legacy /api/integrations/oauth/:slug/init
 *     (handlers in services/ai/src/routes/calendar-oauth.ts + crm-oauth.ts)
 *   - everything else                       → unified /api/connectors/:slug/oauth/init
 *     (stripe, hubspot, shopify, square, salesforce, monday, …)
 *
 * Some providers expect extra query params on init (e.g. shopify needs `shop`,
 * salesforce needs `loginHost`, square needs `environment`). Pass them via
 * `extraParams` and they'll be forwarded as a query string. Empty values are
 * filtered so the backend can apply its own defaults.
 *
 * Returns the provider's authorize URL - caller should window.location = url.
 */
// ─── Custom API tools ────────────────────────────────────────────
//
// Tenant-defined HTTP tools the AI can invoke as `custom.<slug>`. The bot
// surfaces them automatically (see ai-bot.service.ts).

export interface CustomApiTool {
  id: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse?: string | null;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  urlTemplate: string;
  headers: Record<string, string>;
  auth: { kind: "none" | "bearer" | "api_key" | "basic"; in?: "header" | "query"; name?: string };
  parameters: any;
  bodyTemplate?: string | null;
  responseFields?: string[] | null;
  allowedHosts: string[];
  category: "READ" | "WRITE" | "DELETE" | "ACTION";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  isActive: boolean;
  timeoutMs: number;
  hasSecrets: boolean;
}

export type CustomApiToolInput = Omit<CustomApiTool, "id" | "hasSecrets"> & {
  secrets?: Record<string, string>;
};

export function listCustomApiTools(token: string) {
  return apiFetch<{ data: CustomApiTool[] }>(`/api/custom-api-tools`, { token });
}

export function createCustomApiTool(token: string, body: Partial<CustomApiToolInput>) {
  return apiFetch<{ data: CustomApiTool }>(`/api/custom-api-tools`, {
    token, method: "POST", body: JSON.stringify(body),
  });
}

export function updateCustomApiTool(token: string, id: string, body: Partial<CustomApiToolInput>) {
  return apiFetch<{ data: CustomApiTool }>(`/api/custom-api-tools/${id}`, {
    token, method: "PATCH", body: JSON.stringify(body),
  });
}

export function deleteCustomApiTool(token: string, id: string) {
  return apiFetch<{ ok: true }>(`/api/custom-api-tools/${id}`, { token, method: "DELETE" });
}

export function testCustomApiTool(token: string, id: string, args: Record<string, any>) {
  return apiFetch<{ ok: boolean; result?: any; reason?: string; meta?: { status?: number; durationMs?: number } }>(
    `/api/custom-api-tools/${id}/test`,
    { token, method: "POST", body: JSON.stringify({ args }) },
  );
}

// ─── Custom DB query tools ──────────────────────────────────────
//
// Per-tenant pre-canned SQL/Mongo queries the AI invokes as `custom_db.<slug>`.
// Safer than generic CRUD because the admin defines the exact query shape.

export interface CustomDbQueryTool {
  id: string;
  providerSlug: "postgresql" | "mongodb" | "aws_rds";
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse?: string | null;
  queryTemplate: string;
  parameterSchema: any;
  parameterOrder: string[];
  category: "READ" | "WRITE" | "DELETE" | "ACTION";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  isActive: boolean;
  maxRows: number;
  timeoutMs: number;
}

export type CustomDbQueryToolInput = Omit<CustomDbQueryTool, "id">;

export function listCustomDbTools(token: string, opts?: { provider?: string }) {
  const qs = opts?.provider ? `?provider=${encodeURIComponent(opts.provider)}` : "";
  return apiFetch<{ data: CustomDbQueryTool[] }>(`/api/custom-db-tools${qs}`, { token });
}

export function createCustomDbTool(token: string, body: Partial<CustomDbQueryToolInput>) {
  return apiFetch<{ data: CustomDbQueryTool }>(`/api/custom-db-tools`, {
    token, method: "POST", body: JSON.stringify(body),
  });
}

export function updateCustomDbTool(token: string, id: string, body: Partial<CustomDbQueryToolInput>) {
  return apiFetch<{ data: CustomDbQueryTool }>(`/api/custom-db-tools/${id}`, {
    token, method: "PATCH", body: JSON.stringify(body),
  });
}

export function deleteCustomDbTool(token: string, id: string) {
  return apiFetch<{ ok: true }>(`/api/custom-db-tools/${id}`, { token, method: "DELETE" });
}

export function testCustomDbTool(token: string, id: string, args: Record<string, any>) {
  return apiFetch<{ ok: boolean; result?: any; reason?: string }>(
    `/api/custom-db-tools/${id}/test`,
    { token, method: "POST", body: JSON.stringify({ args }) },
  );
}

// ─── DB schema introspection (Postgres / MongoDB / AWS RDS) ─────────
//
// `connectionString` is sent in the BODY (not query) so it stays out of
// access logs. If omitted, the backend reuses the credentials already saved
// on the tenant's CONNECTED integration row.

export type DbTable = { name: string; schema?: string; qualified: string };
export type DbCollection = { name: string };
export type DbDatabase = { name: string };

export function listPostgresTables(token: string, opts?: { connectionString?: string }) {
  return apiFetch<{ data: DbTable[] }>(`/api/connectors/postgres/meta/tables`, {
    token, method: "POST",
    body: JSON.stringify({ connectionString: opts?.connectionString }),
  });
}

export function listMongoDatabases(token: string, opts?: { connectionString?: string }) {
  return apiFetch<{ data: DbDatabase[] }>(`/api/connectors/mongodb/meta/databases`, {
    token, method: "POST",
    body: JSON.stringify({ connectionString: opts?.connectionString }),
  });
}

export function listMongoCollections(token: string, opts: { dbName: string; connectionString?: string }) {
  return apiFetch<{ data: DbCollection[] }>(`/api/connectors/mongodb/meta/collections`, {
    token, method: "POST",
    body: JSON.stringify(opts),
  });
}

export function listRdsTables(token: string, opts: { engine: "postgres" | "mysql" | "mariadb"; connectionString?: string }) {
  return apiFetch<{ data: DbTable[] }>(`/api/connectors/aws_rds/meta/tables`, {
    token, method: "POST",
    body: JSON.stringify(opts),
  });
}

export function initIntegrationOAuth(token: string, slug: string, extraParams?: Record<string, string>) {
  const LEGACY_SLUGS = new Set(["zoho_crm", "google_calendar", "calendly"]);
  const path = LEGACY_SLUGS.has(slug)
    ? `/api/integrations/oauth/${slug}/init`
    : `/api/connectors/${slug}/oauth/init`;
  const filtered = Object.fromEntries(
    Object.entries(extraParams || {}).filter(([, v]) => v != null && v !== ""),
  );
  const qs = Object.keys(filtered).length
    ? `?${new URLSearchParams(filtered as Record<string, string>).toString()}`
    : "";
  return apiFetch<{ url: string }>(`${path}${qs}`, { token });
}

// ─── Tools (Active tenant tools) ────────────────────────────

export function getActiveTenantTools(token: string) {
  return apiFetch<{ data: any[] }>("/api/tools", { token });
}

export function getDepartmentToolPermissions(token: string, departmentId: string) {
  return apiFetch<{ data: any[] }>(`/api/tools/permissions/${departmentId}`, { token });
}

export function updateDepartmentToolPermissions(token: string, departmentId: string, permissions: Array<{ tenantToolId: string; isAllowed: boolean; requireApproval: boolean }>) {
  return apiFetch<{ data: any }>(`/api/tools/permissions/${departmentId}`, {
    token, method: "PUT", body: JSON.stringify({ permissions }),
  });
}

export function getAgentScores(token: string, agentId: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any }>(`/api/agent-scores/${agentId}${qs}`, { token });
}

export function getConversationScore(token: string, conversationId: string) {
  return apiFetch<{ data: any }>(`/api/ai-assist/${conversationId}/score`, { token });
}

// ─── AI Agents (AI Studio Team Members) ──────────────────────

export function getAIAgents(token: string) {
  return apiFetch<{ data: any[] }>("/api/ai-agents", { token });
}

export function getAIAgent(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/ai-agents/${id}`, { token });
}

export function createAIAgent(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/ai-agents", { token, method: "POST", body: JSON.stringify(data) });
}

export function getAIAgentReachability(token: string, id: string) {
  return apiFetch<{ data: { hasCanvas: boolean; reachable: boolean } }>(`/api/ai-agents/${id}/reachability`, { token });
}

export interface EffectivePermissions {
  governed: boolean;
  allowedToolSlugs: string[];
  effectiveOperations: string[];
  capabilities: Array<{
    capability: string;
    summary: string;
    live: boolean;
    operations: Array<{ name: string; effective: boolean }>;
  }>;
}

export function getAIAgentEffectivePermissions(token: string, id: string) {
  return apiFetch<{ data: EffectivePermissions }>(`/api/ai-agents/${id}/effective-permissions`, { token });
}

export function updateAIAgent(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/ai-agents/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteAIAgent(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/ai-agents/${id}`, { token, method: "DELETE" });
}

/** "Why did it answer this way?" - derived from what the turn actually did. */
export interface SandboxDiagnostics {
  employee: { id: string; name: string; role: string | null };
  department: { id: string; name: string } | null;
  knowledgeUsed: Array<{ title: string; sourceType: string | null }>;
  toolsConsidered: string[];
  simulatedActions: Array<{ tool: string; arguments: Record<string, unknown> }>;
  awaitingApproval: { tool: string; reason: string } | null;
  escalated: { reason: string } | null;
  writeMode: "safe" | "real";
  routing: string;
  conversationId: string;
  turnCount: number;
}

/**
 * Talk to the real employee in a sandbox conversation.
 *
 * No `history` argument: memory comes from the sandbox conversation on the
 * server, exactly as it does for a live customer. Passing a client-side
 * transcript meant "does it remember?" only ever tested the array we sent.
 */
export function testAgentChat(
  token: string,
  agentId: string,
  message: string,
  opts?: { writes?: "safe" | "real"; reset?: boolean },
) {
  return apiFetch<{ data: { reply: string; diagnostics: SandboxDiagnostics } }>(
    `/api/ai-agents/${agentId}/test-chat`,
    {
      token,
      method: "POST",
      body: JSON.stringify({ message, writes: opts?.writes ?? "safe", reset: opts?.reset === true }),
    },
  );
}

// ─── Router Rules (Main Playbook) ────────────────────────────

export function getRouterRules(token: string) {
  return apiFetch<{ data: any[] }>("/api/router-rules", { token });
}

export function getRouterRule(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/router-rules/${id}`, { token });
}

export function createRouterRule(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/router-rules", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateRouterRule(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/router-rules/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function reorderRouterRules(token: string, ruleIds: string[]) {
  return apiFetch<{ success: boolean }>("/api/router-rules/reorder", { token, method: "PUT", body: JSON.stringify({ ruleIds }) });
}

export function deleteRouterRule(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/router-rules/${id}`, { token, method: "DELETE" });
}

// ─── Templates ──────────────────────────────────────────────

export function getTemplates(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; total: number }>(`/api/templates${qs}`, { token });
}

export function getTemplate(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/templates/${id}`, { token });
}

export function createTemplate(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/templates", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateTemplate(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/templates/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteTemplate(token: string, id: string, force?: boolean) {
  const qs = force ? "?force=true" : "";
  return apiFetch<{ success: boolean }>(`/api/templates/${id}${qs}`, { token, method: "DELETE" });
}

export function duplicateTemplate(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/templates/${id}/duplicate`, { token, method: "POST" });
}

export function submitTemplateToMeta(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/templates/${id}/submit-to-meta`, { token, method: "POST" });
}

// ─── Broadcasts ─────────────────────────────────────────────

export function getBroadcasts(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[] }>(`/api/broadcasts${qs}`, { token });
}

export function getBroadcast(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}`, { token });
}

export function getBroadcastRecipients(token: string, id: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; total: number }>(`/api/broadcasts/${id}/recipients${qs}`, { token });
}

export function createBroadcast(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/broadcasts", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateBroadcast(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteBroadcast(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/broadcasts/${id}`, { token, method: "DELETE" });
}

export function addBroadcastRecipients(token: string, id: string, recipients: { externalId: string; contactId?: string }[]) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}/recipients`, { token, method: "POST", body: JSON.stringify({ recipients }) });
}

export function sendBroadcast(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}/send`, { token, method: "POST" });
}

export function validateBroadcast(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}/validate`, { token, method: "POST" });
}

export function cancelBroadcast(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}/cancel`, { token, method: "POST" });
}

export function resendBroadcast(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/broadcasts/${id}/resend`, { token, method: "POST" });
}

// ─── Audiences ──────────────────────────────────────────────

export function previewAudience(token: string, audience: any) {
  return apiFetch<{
    data: {
      recipients: Array<{ id: string; source: "local" | "crm"; displayName?: string; phone?: string; email?: string; channel?: string }>;
      total: number;
      truncated: boolean;
      reasoning: string[];
    };
  }>("/api/audiences/preview", { token, method: "POST", body: JSON.stringify({ audience }) });
}

export function getAudienceSchema(token: string, module: "leads" | "contacts" | "accounts" | "deals" = "leads") {
  return apiFetch<{
    data: {
      module: string;
      local: { fields: Array<{ name: string; label: string; type: string; picklist?: string[] }>; scope: string };
      crm:
        | { connected: false }
        | {
            connected: true;
            provider: { slug: string; name: string };
            schema: { module: string; providerModule: string; fields: Array<{ name: string; label: string; type: string; picklist?: string[] }> } | null;
          };
    };
  }>(`/api/audiences/schema?module=${encodeURIComponent(module)}`, { token });
}

// ─── Scheduled Messages ─────────────────────────────────────

export function getScheduledMessages(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; total: number }>(`/api/scheduled-messages${qs}`, { token });
}

export function getScheduledMessage(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/scheduled-messages/${id}`, { token });
}

export function createScheduledMessage(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/scheduled-messages", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateScheduledMessage(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/scheduled-messages/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function cancelScheduledMessage(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/scheduled-messages/${id}`, { token, method: "DELETE" });
}

// ─── Contact Segments ──────────────────────────────────────
export function queryContactSegment(token: string, data: { rules?: any[]; channel?: string }) {
  return apiFetch<{ data: any[]; total: number }>("/api/contacts/segment", { token, method: "POST", body: JSON.stringify(data) });
}

// ─── Contacts ───────────────────────────────────────────────

export function getContacts(token: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch<{ data: any[]; total: number }>(`/api/contacts${qs}`, { token });
}

export function getContact(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/contacts/${id}`, { token });
}

export function createContact(token: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>("/api/contacts", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateContact(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/contacts/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function initiateConversation(token: string, data: { contactId?: string; externalId?: string; channel?: string; channelAccountId: string; body: string; messageType?: string; templateId?: string; variables?: Record<string, string> }) {
  return apiFetch<{ data: any }>("/api/contacts/initiate-conversation", { token, method: "POST", body: JSON.stringify(data) });
}

// ─── Flow Canvas ────────────────────────────────────────────

export function getFlowCanvas(token: string) {
  return apiFetch<{ data: any }>("/api/flow-canvas", { token });
}

export function saveFlowCanvas(token: string, data: { nodes: any[]; edges: any[]; viewport?: any }) {
  return apiFetch<{ data: any }>("/api/flow-canvas", { token, method: "PUT", body: JSON.stringify(data) });
}

export function autoGenerateFlowCanvas(token: string) {
  return apiFetch<{ data: any }>("/api/flow-canvas/auto-generate", { token, method: "POST" });
}

// ─── Webhook Triggers ───────────────────────────────────────
// Management API for the Main Playbook's Webhook trigger node. The returned
// `data` carries { id, workflowId, token, secret, enabled, path }; the browser
// builds the full URL as `${location.origin}${path}`.
// "flow" runs the associated ChatbotFlow; "connected" walks the nodes wired to
// the webhook trigger node on the Main Playbook canvas.
export type WebhookTargetMode = "flow" | "connected";

// The declarable type of a single expected body field. Drives the field-type
// picker in the Webhook trigger Inspector; the mapper (Card 5) reads these to
// offer real source choices. Keep in sync with the backend WebhookFieldType.
export type WebhookFieldType = "string" | "number" | "boolean";

// One user-declared field expected in the inbound request body.
export interface WebhookBodyField {
  key: string;
  type: WebhookFieldType;
}

export interface WebhookTriggerDto {
  id: string;
  workflowId: string;
  token: string;
  secret: string;
  enabled: boolean;
  targetMode: WebhookTargetMode;
  // User-declared shape of the request body. Source fields for the mapper.
  // Declaration only - inbound payloads are not validated against it.
  bodySchema: WebhookBodyField[];
  path: string;
}

export function getWebhookTrigger(token: string, workflowId: string) {
  return apiFetch<{ data: WebhookTriggerDto | null }>(
    `/api/webhook-triggers?workflowId=${encodeURIComponent(workflowId)}`,
    { token },
  );
}

export function createWebhookTrigger(
  token: string,
  workflowId: string,
  targetMode?: WebhookTargetMode,
) {
  return apiFetch<{ data: WebhookTriggerDto }>("/api/webhook-triggers", {
    token,
    method: "POST",
    body: JSON.stringify(targetMode ? { workflowId, targetMode } : { workflowId }),
  });
}

export function regenerateWebhookSecret(token: string, id: string) {
  return apiFetch<{ data: WebhookTriggerDto }>(
    `/api/webhook-triggers/${id}/regenerate-secret`,
    { token, method: "POST" },
  );
}

export function setWebhookTriggerEnabled(token: string, id: string, enabled: boolean) {
  return apiFetch<{ data: WebhookTriggerDto }>(`/api/webhook-triggers/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function setWebhookTriggerMode(token: string, id: string, targetMode: WebhookTargetMode) {
  return apiFetch<{ data: WebhookTriggerDto }>(`/api/webhook-triggers/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify({ targetMode }),
  });
}

// Persist the user-declared body schema (the expected request-body fields the
// mapper will bind from). Declaration only - not enforced on inbound payloads.
export function setWebhookTriggerBodySchema(
  token: string,
  id: string,
  bodySchema: WebhookBodyField[],
) {
  return apiFetch<{ data: WebhookTriggerDto }>(`/api/webhook-triggers/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify({ bodySchema }),
  });
}

// ─── Department Tree ────────────────────────────────────────

export function getDepartmentTree(token: string) {
  return apiFetch<{ data: { tree: any[]; aiAgents: any[] } }>("/api/departments/tree", { token });
}

// ─── Department AI Employee Assignment ──────────────────────

export function getDepartmentAIEmployee(token: string, departmentId: string) {
  return apiFetch<{ data: any; ruleId?: string }>(`/api/departments/${departmentId}/ai-employee`, { token });
}

export function assignDepartmentAIEmployee(token: string, departmentId: string, aiAgentId: string | null) {
  return apiFetch<{ data: any; ruleId?: string }>(`/api/departments/${departmentId}/ai-employee`, {
    token, method: "PUT", body: JSON.stringify({ aiAgentId }),
  });
}

// A department can have MANY AI employees. These operate on the full roster and
// leave the other attachments untouched.
export function getDepartmentAIEmployees(token: string, departmentId: string) {
  return apiFetch<{ data: any[] }>(`/api/departments/${departmentId}/ai-employees`, { token });
}

export function addDepartmentAIEmployee(token: string, departmentId: string, aiAgentId: string) {
  return apiFetch<{ data: any; ruleId?: string }>(`/api/departments/${departmentId}/ai-employees`, {
    token, method: "POST", body: JSON.stringify({ aiAgentId }),
  });
}

export function removeDepartmentAIEmployee(token: string, departmentId: string, aiAgentId: string) {
  return apiFetch<{ data: any[] }>(`/api/departments/${departmentId}/ai-employees/${aiAgentId}`, {
    token, method: "DELETE",
  });
}

// ─── AI Employee Creation Wizard ────────────────────────────

export function generateAIEmployeeConfig(token: string, data: { answers: Record<string, string>; departmentId?: string }) {
  return apiFetch<{ data: any }>("/api/ai-agents/generate", { token, method: "POST", body: JSON.stringify(data) });
}

// ─── Usage Tracking ─────────────────────────────────────────

export function getUsageStats(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: { stats: Record<string, { total: number; count: number }>; period: number } }>(`/api/usage/stats${qs}`, { token });
}

export function getUsageDaily(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: Array<{ date: string; type: string; total: number; count: number }> }>(`/api/usage/daily${qs}`, { token });
}

export function getUsageLogs(token: string, params?: { limit?: number; offset?: number; type?: string }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : "";
  return apiFetch<{ data: any[]; total: number }>(`/api/usage/logs${qs}`, { token });
}

// ─── Voice Sessions (Phase 1 - Live Call CoPilot) ───────────
//
// Tenant-wide RINGING + live VoiceCallSession snapshot. All endpoints
// 404 unless tenant.voiceCopilotEnabled is true (per backend gate in
// services/conversation/src/routes/voice-sessions.ts).

export interface VoiceCallSession {
  id: string;
  callSid: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  state:
    | "RINGING"
    | "CONNECTING"
    | "ACTIVE"
    | "HOLD"
    | "ENDED"
    | "FAILED"
    | "MISSED"
    | null;
  status: string;
  customerNumber: string;
  agentId: string | null;
  assignedAgentId: string | null;
  claimedAt: string | null;
  startedAt: string;
  answeredAt: string | null;
  channelId: string | null;
  meta?: Record<string, unknown> | null;
}

export interface VoiceSessionContext {
  contact: {
    id: string;
    displayName?: string | null;
    externalId?: string | null;
    phone?: string | null;
    email?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  priorConversations: Array<{
    id: string;
    channel: string;
    status: string;
    customerName?: string | null;
    lastMessageAt?: string | null;
    aiSummary?: string | null;
  }>;
  callAnalysis: {
    rollingSummary?: string | null;
    finalSummary?: string | null;
    status?: string | null;
  } | null;
}

export interface VoiceTranscriptMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  messageType: string;
  senderName?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

export function getActiveVoiceSessions(token: string) {
  return apiFetch<{ data: VoiceCallSession[] }>("/api/voice-sessions/active", { token });
}

export function getVoiceSession(token: string, id: string) {
  return apiFetch<{ data: VoiceCallSession }>(`/api/voice-sessions/${id}`, { token });
}

export function getVoiceSessionTranscript(token: string, id: string, cursor?: string, limit?: number) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch<{ data: VoiceTranscriptMessage[]; nextCursor: string | null }>(
    `/api/voice-sessions/${id}/transcript${qs}`,
    { token },
  );
}

export function getVoiceSessionContext(token: string, id: string) {
  return apiFetch<{ data: VoiceSessionContext }>(`/api/voice-sessions/${id}/context`, { token });
}

export function answerVoiceSession(token: string, id: string) {
  return apiFetch<{ data: VoiceCallSession }>(`/api/voice-sessions/${id}/answer`, {
    token, method: "POST",
  });
}

export function declineVoiceSession(token: string, id: string) {
  return apiFetch<{ data: VoiceCallSession }>(`/api/voice-sessions/${id}/decline`, {
    token, method: "POST",
  });
}

export function hangupVoiceSession(token: string, id: string) {
  return apiFetch<{ data: VoiceCallSession }>(`/api/voice-sessions/${id}/hangup`, {
    token, method: "POST",
  });
}

// ─── System Admin: All Tenants Usage ────────────────────────

export function getSystemUsageStats(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: any }>(`/api/system/usage/stats${qs}`, { token });
}

export function getSystemUsageByTenant(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: any[] }>(`/api/system/usage/by-tenant${qs}`, { token });
}

// ─── System Admin: Pricing-Model Analytics ──────────────────

export type PricingCategoryKey =
  | "autonomous_agent"
  | "copilot_inbox"
  | "call_pilot"
  | "embedded_chat"
  | "system_copilot"
  | "background_ai"
  | "embeddings"
  | "other";

export interface PricingCategoryRow {
  category: PricingCategoryKey;
  label: string;
  description: string;
  color: string;
  /** True when this category is naturally priced per customer thread. */
  perConversation: boolean;
  calls: number;
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  totalTokens: number;
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  /** Blended input rate over the actual model mix (USD per 1K). */
  blendedInputUsdPer1K: number | null;
  blendedOutputUsdPer1K: number | null;
  avgCostPerCall: number;
  avgCostPerConversation: number | null;
  avgTokensPerCall: number;
  avgTokensPerConversation: number | null;
  cacheHitPct: number | null;
  modelMix: Array<{
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    inputCostUsd: number;
    outputCostUsd: number;
  }>;
}

export interface PricingUnitCosts {
  period: number;
  categories: PricingCategoryRow[];
  totals: {
    calls: number;
    conversations: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    totalTokens: number;
    costUsd: number;
    inputCostUsd: number;
    outputCostUsd: number;
  };
  pricing: Record<string, { prompt: number; completion: number }>;
}

export interface PricingTrends {
  period: number;
  days: string[];
  series: Array<{
    category: PricingCategoryKey;
    label: string;
    color: string;
    cost: number[];
    calls: number[];
  }>;
}

export function getPricingUnitCosts(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: PricingUnitCosts }>(`/api/system/pricing/unit-costs${qs}`, { token });
}

export function getPricingTrends(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: PricingTrends }>(`/api/system/pricing/trends${qs}`, { token });
}

// ─── Voice Channels (Phase 2 - Twilio onboarding) ───────────
//
// Tenant-owned Twilio accounts (BYO). `authToken` is write-only - the
// backend never echoes it back; `accountSidFingerprint` is the truncated
// SID for display.

export type VoiceChannelAuthType = "BYO";
export type VoiceChannelStatus = "PENDING" | "ACTIVE" | "DISABLED" | "ERROR";

export interface VoiceChannelPhoneNumber {
  id: string;
  e164: string;
  twilioSid?: string;
  friendlyName?: string;
  isActive: boolean;
  createdAt: string;
}

export interface VoiceChannel {
  id: string;
  friendlyName: string;
  status: VoiceChannelStatus;
  authType: VoiceChannelAuthType;
  accountSidFingerprint: string;
  hasAuthToken: boolean;
  createdAt: string;
  numbers: VoiceChannelPhoneNumber[];
  config?: Record<string, unknown>;
  /**
   * Phase 6: AI Employee bound to this channel via FK column (was in
   * copilot_config JSONB). Null = no employee assigned; the live runner
   * falls back to legacy per-channel copilot config.
   */
  aiAgentId?: string | null;
  /**
   * Per-channel pipeline funnel override. Stored inside the copilot_config
   * JSONB blob today (pending Phase 7 promotion to a real FK column).
   * Null = use the department-scoped funnel resolution.
   */
  funnelId?: string | null;
}

export interface CreateVoiceChannelInput {
  friendlyName: string;
  accountSid: string;
  authToken: string;
}

export function listVoiceChannels(token: string) {
  return apiFetch<{ data: VoiceChannel[] }>("/api/voice-channels", { token });
}

// Unified customer search across the tenant's resolved source of truth
// (dedicated CRM or Shopify-as-CRM) - the outbound dialer's search mode.
// List rows carry MASKED identifiers only; full data comes from
// getSotCustomerDetail after the agent explicitly selects a candidate.
export interface SotCustomer {
  id: string;
  kind: string;
  name: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  company: string | null;
  stage: string | null;
  vendor: string;
  callable: boolean;
  ordersCount: number | null;
  totalSpent: string | null;
  currency: string | null;
}

export function searchSotCustomers(token: string, q: string, limit = 8) {
  return apiFetch<{ data: SotCustomer[]; meta: { configured: boolean; vendor: string | null; missingScope?: boolean } }>(
    `/api/integrations/source-of-truth/customers?q=${encodeURIComponent(q)}&limit=${limit}`,
    { token },
  );
}

export interface SotCustomerDetail {
  id: string;
  kind: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  stage: string | null;
  vendor: string;
}

export function getSotCustomerDetail(token: string, id: string, kind: string) {
  return apiFetch<{ data: SotCustomerDetail }>(
    `/api/integrations/source-of-truth/customers/detail?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}`,
    { token },
  );
}

export function getVoiceChannel(token: string, id: string) {
  return apiFetch<{ data: VoiceChannel }>(`/api/voice-channels/${id}`, { token });
}

// ─── Live Call Copilot config (per voice channel) ─────────────
export interface CopilotQuestion {
  id: string;
  text: string;
  required: boolean;
}

export interface CopilotDataField {
  field: string;
  label: string;
  required: boolean;
}

export interface CopilotConfig {
  language?: string;          // "he" | "en" | …
  persona?: string;
  goals?: string;
  questions: CopilotQuestion[];
  dataFields: CopilotDataField[];
  /**
   * TenantFunnel.id (cuid) - pins this voice channel to a specific funnel
   * for stage resolution. Overrides the department-scoped funnel lookup.
   * Lets a tenant run different pipelines per phone number.
   */
  funnelId?: string;
  /**
   * AIAgent.id - the AI Employee that drives call-pilot turns on this
   * channel. Same employee record used for chat/copilot; mode=callpilot
   * is selected at call time. Phase 6 migrates this to a real FK on
   * `voice_channels.ai_agent_id`.
   */
  aiAgentId?: string;
}

// ─── AI Employees (AIAgent) ──────────────────────────────────

export interface AIAgentSummary {
  id: string;
  name: string;
  role?: string | null;
  status?: string | null;
}

export function listAIAgents(token: string) {
  return apiFetch<{ data: AIAgentSummary[] }>(`/api/ai-agents`, { token });
}

// ─── AI Skills catalog ───────────────────────────────────────
// System skills (operational / language / execution) registered at module
// load in services/ai/src/worker/skills/. The wizard / agent editor
// renders these as checkboxes so operators compose agents from the same
// vocabulary the runtime uses.
export interface AISkillMetadata {
  id: string;
  kind: "operational" | "language" | "execution";
  name: string;
  description?: string;
  whenToUse?: string;
}

export function listAISkills(token: string) {
  return apiFetch<{
    data: {
      skills: AISkillMetadata[];
      grouped: Record<"operational" | "language" | "execution", AISkillMetadata[]>;
      count: number;
    };
  }>(`/api/ai-skills`, { token });
}

export function getVoiceChannelCopilotConfig(token: string, id: string) {
  return apiFetch<{ data: Partial<CopilotConfig> }>(`/api/voice-channels/${id}/copilot-config`, { token });
}

export function updateVoiceChannelCopilotConfig(token: string, id: string, config: CopilotConfig) {
  return apiFetch<{ data: CopilotConfig }>(`/api/voice-channels/${id}/copilot-config`, {
    token,
    method: "PUT",
    body: JSON.stringify(config),
  });
}

// ─── Voice channel ↔ AI Employee (Phase 6) ────────────────────
// Reads/writes `voice_channels.ai_agent_id`. Replaces the legacy
// `copilot_config.aiAgentId` JSONB field which was promoted to a real
// FK column. The detail page calls these directly so the picker is a
// first-class control on the channel, not buried in the copilot config.
export function getVoiceChannelAIAgent(token: string, id: string) {
  return apiFetch<{ data: { aiAgentId: string | null } }>(
    `/api/voice-channels/${id}/ai-agent`,
    { token },
  );
}

export function updateVoiceChannelAIAgent(token: string, id: string, aiAgentId: string | null) {
  return apiFetch<{ data: { aiAgentId: string | null } }>(
    `/api/voice-channels/${id}/ai-agent`,
    { token, method: "PUT", body: JSON.stringify({ aiAgentId }) },
  );
}

// ─── Voice channel ↔ Pipeline funnel ──────────────────────────
// Per-channel funnel override (calls answered on this number use this
// funnel for stage resolution instead of the department default).
// Backed by copilot_config.funnelId today; Phase 7 promotes to FK column.
export function getVoiceChannelFunnel(token: string, id: string) {
  return apiFetch<{ data: { funnelId: string | null } }>(
    `/api/voice-channels/${id}/funnel`,
    { token },
  );
}

export function updateVoiceChannelFunnel(token: string, id: string, funnelId: string | null) {
  return apiFetch<{ data: { funnelId: string | null } }>(
    `/api/voice-channels/${id}/funnel`,
    { token, method: "PUT", body: JSON.stringify({ funnelId }) },
  );
}

// ─── Voice channel inbound routing ────────────────────────────
export type VoiceInboundMode = "IN_PLATFORM" | "FORWARD_TO_AGENT";
export type VoiceOutboundMode = "IN_PLATFORM" | "AGENT_FIRST";

export interface VoiceChannelRouting {
  /** Inbound: who rings first when a customer calls in. */
  defaultAgentId: string | null;
  /** Inbound fallback department when defaultAgent doesn't pick up. */
  fallbackDepartmentId: string | null;
  /** Inbound: ring duration before fallback kicks in. */
  ringTimeoutSeconds: number;
  /**
   * Inbound: opt-in hard cap on how long an unanswered call rings before
   * the platform hangs up and marks it MISSED. Null = no auto-hangup
   * (legacy behavior - the call rings until Twilio's own timeout or
   * the customer hangs up).
   */
  autoHangupSeconds: number | null;
  inboundMode: VoiceInboundMode;
  outboundMode: VoiceOutboundMode;
  /**
   * Outbound (AGENT_FIRST): whose mobile rings when an outbound call
   * is placed. Null → falls back to defaultAgent for backward compat.
   * Independent of defaultAgentId so inbound/outbound can route to
   * different people.
   */
  agentFirstAgentId: string | null;
  /**
   * When `outboundMode = AGENT_FIRST`, controls whether the UI opens
   * the workspace page on click-to-call. Default true. Set false for
   * "fire and forget" - agent walks away from the computer, mobile rings.
   */
  openWorkspaceOnAgentFirst: boolean;
}

// ─── Missed voice calls inbox ─────────────────────────────────
export interface MissedVoiceSession {
  id: string;
  callSid: string | null;
  conversationId: string;
  channelId: string | null;
  customerNumber: string | null;
  customerId: string | null;
  agentId: string | null;
  assignedAgentId: string | null;
  startedAt: string;
  meta?: Record<string, unknown> | null;
  contact: {
    id: string;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    tags: string[] | null;
  } | null;
}

export function getMissedVoiceSessions(token: string, limit = 50) {
  return apiFetch<{ data: MissedVoiceSession[] }>(
    `/api/voice-sessions/missed?limit=${limit}`,
    { token },
  );
}

export function callbackMissedVoiceSession(token: string, sessionId: string) {
  return apiFetch<{ data: { sessionId: string; conversationId: string; agentCallSid: string } }>(
    `/api/voice-sessions/missed/${sessionId}/callback`,
    { token, method: "POST" },
  );
}

export function handleMissedVoiceSession(token: string, sessionId: string) {
  return apiFetch<{ data: { handledCount: number; customerNumber: string | null } }>(
    `/api/voice-sessions/missed/${sessionId}/handle`,
    { token, method: "POST" },
  );
}

export interface MissedVoiceSessionDetail {
  session: {
    id: string;
    conversationId: string;
    customerNumber: string | null;
    startedAt: string;
  };
  contact: {
    id: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    personId: string | null;
    lastInteractionAt: string | null;
  } | null;
  brief: {
    brief: string;
    signals: string[];
    tone: string | null;
    mood: string | null;
    recommendedBehaviors: string[];
    conversationCount: number;
    generatedAt: string;
    locale: string;
  } | null;
  priorConversations: Array<{
    id: string;
    channel: string;
    status: string;
    aiSummary: string | null;
    lastMessageAt: string | null;
    customerName: string | null;
  }>;
}

export function getMissedVoiceSessionDetail(token: string, sessionId: string) {
  return apiFetch<{ data: MissedVoiceSessionDetail }>(
    `/api/voice-sessions/missed/${sessionId}/detail`,
    { token },
  );
}

export function setVoiceSessionCustomerHold(token: string, sessionId: string, hold: boolean) {
  return apiFetch<{ data: { hold: boolean; conferenceSid: string } }>(
    `/api/voice-sessions/${sessionId}/customer-hold`,
    { token, method: "POST", body: JSON.stringify({ hold }) },
  );
}

export function voiceSessionAgentLeave(token: string, sessionId: string) {
  return apiFetch<{ data: { agentDropped: boolean } }>(
    `/api/voice-sessions/${sessionId}/agent-leave`,
    { token, method: "POST" },
  );
}

export function addVoiceSessionParticipant(token: string, sessionId: string, to: string, label?: string) {
  return apiFetch<{ data: { id: string; to: string; label: string; conferenceSid: string } }>(
    `/api/voice-sessions/${sessionId}/add-participant`,
    {
      token,
      method: "POST",
      body: JSON.stringify({ to, label }),
    },
  );
}

export type VoiceParticipantRole = "CUSTOMER" | "AGENT" | "ADDED";
export type VoiceParticipantStatus = "DIALING" | "JOINED" | "LEFT" | "FAILED";

export interface VoiceSessionParticipant {
  id: string;
  role: VoiceParticipantRole;
  status: VoiceParticipantStatus;
  callSid: string | null;
  label: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  contactId: string | null;
  onHold: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  endReason: string | null;
  contact: {
    id: string;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    tags: unknown;
  } | null;
}

export function getVoiceSessionParticipants(token: string, sessionId: string) {
  return apiFetch<{ data: VoiceSessionParticipant[] }>(
    `/api/voice-sessions/${sessionId}/participants`,
    { token },
  );
}

export function setVoiceParticipantHold(
  token: string,
  sessionId: string,
  participantId: string,
  hold: boolean,
) {
  return apiFetch<{ data: { id: string; onHold: boolean } }>(
    `/api/voice-sessions/${sessionId}/participants/${participantId}/hold`,
    { token, method: "POST", body: JSON.stringify({ hold }) },
  );
}

export type StartOutboundResult =
  | { mode: "IN_PLATFORM" }
  | {
      mode: "AGENT_FIRST";
      sessionId: string | null;
      conversationId: string | null;
      /**
       * Per-channel preference: when false the UI should NOT navigate
       * to the workspace page (mobile-only outbound, hands-off).
       */
      openWorkspace: boolean;
    };

export function startOutboundVoiceCall(
  token: string,
  to: string,
  opts?: { conversationId?: string; notes?: string },
) {
  return apiFetch<{ data: StartOutboundResult }>(
    `/api/voice-sessions/start-outbound`,
    {
      token,
      method: "POST",
      body: JSON.stringify({
        to,
        conversationId: opts?.conversationId,
        notes: opts?.notes,
      }),
    },
  );
}

export function kickVoiceParticipant(
  token: string,
  sessionId: string,
  participantId: string,
) {
  return apiFetch<{ data: { id: string; kicked: boolean; alreadyLeft?: boolean } }>(
    `/api/voice-sessions/${sessionId}/participants/${participantId}/kick`,
    { token, method: "POST" },
  );
}

export function getVoiceChannelRouting(token: string, id: string) {
  return apiFetch<{ data: VoiceChannelRouting }>(`/api/voice-channels/${id}/routing`, { token });
}

export function updateVoiceChannelRouting(token: string, id: string, routing: VoiceChannelRouting) {
  return apiFetch<{ data: VoiceChannelRouting }>(`/api/voice-channels/${id}/routing`, {
    token,
    method: "PUT",
    body: JSON.stringify(routing),
  });
}

export function createVoiceChannelBYO(token: string, input: CreateVoiceChannelInput) {
  return apiFetch<{ data: VoiceChannel }>("/api/voice-channels", {
    token,
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getVoiceChannelNumbers(token: string, id: string) {
  return apiFetch<{ data: VoiceChannelPhoneNumber[] }>(`/api/voice-channels/${id}/numbers`, { token });
}

export function refreshVoiceChannelNumbers(token: string, id: string) {
  return apiFetch<{ data: VoiceChannelPhoneNumber[] }>(`/api/voice-channels/${id}/numbers/refresh`, {
    token,
    method: "POST",
  });
}

export function activateVoiceChannelNumber(token: string, id: string, numberId: string) {
  return apiFetch<{ data: VoiceChannelPhoneNumber }>(
    `/api/voice-channels/${id}/numbers/${numberId}/activate`,
    { token, method: "POST" },
  );
}

export function deactivateVoiceChannelNumber(token: string, id: string, numberId: string) {
  return apiFetch<{ data: VoiceChannelPhoneNumber }>(
    `/api/voice-channels/${id}/numbers/${numberId}/deactivate`,
    { token, method: "POST" },
  );
}

export function deleteVoiceChannel(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/voice-channels/${id}`, {
    token,
    method: "DELETE",
  });
}

// ─── Permissions & Feature Flags ────────────────────────────

export interface FeatureMetadata {
  key: string;
  displayName: string;
  description: string;
  category:
    | "messaging"
    | "voice"
    | "ai"
    | "knowledge"
    | "crm"
    | "automation"
    | "commerce"
    | "integrations"
    | "analytics"
    | "notifications"
    | "admin";
  defaultEnabled: boolean;
  defaultAgentAccess: "none" | "all";
  legacyColumn?: string;
}

export interface TenantFeatureView {
  feature: string;
  displayName: string;
  description: string;
  category: FeatureMetadata["category"];
  enabled: boolean;
  config: Record<string, unknown> | null;
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface TenantRole {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  builtinKey: string | null;
  defaultScope: "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE";
  createdAt: string;
  updatedAt: string;
  features: { roleId: string; feature: string; createdAt: string }[];
  _count?: { assignments: number };
}

// Hierarchical permission catalog (single source of truth, served by backend).
export interface PermissionDef {
  key: string;
  domain: string;
  feature: string;
  subFeature: string;
  action: string;
  kind: "runtime" | "configuration";
  scoped: boolean;
  displayName: string;
  description: string;
}

export interface BuiltinRoleDef {
  key: string;
  name: string;
  description: string;
  defaultScope: "own" | "team" | "department" | "workspace";
  permissions: string[];
}

export interface PermissionCatalog {
  permissions: PermissionDef[];
  byDomain: Record<string, PermissionDef[]>;
  builtinRoles: BuiltinRoleDef[];
  scopes: PermissionScope[];
}

export interface UserFeatureGrantRow {
  id: string;
  userId: string;
  feature: string;
  granted: boolean;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

// SYSTEM_ADMIN - feature registry + tenant feature toggles

export function getFeatureRegistry(token: string) {
  return apiFetch<{ data: FeatureMetadata[] }>("/api/system/features", { token });
}

export function getSystemTenantFeatures(token: string, tenantId: string) {
  return apiFetch<{ data: TenantFeatureView[] }>(
    `/api/system/tenants/${tenantId}/features`,
    { token },
  );
}

export function updateSystemTenantFeature(
  token: string,
  tenantId: string,
  feature: string,
  body: { enabled: boolean; config?: Record<string, unknown> | null },
) {
  return apiFetch<{ data: TenantFeatureView }>(
    `/api/system/tenants/${tenantId}/features/${feature}`,
    { token, method: "PUT", body: JSON.stringify(body) },
  );
}

// SYSTEM_ADMIN - entitlements (feature licensing), credits & POC provisioning.
export interface LicenseDomainRow { key: string; enabled: boolean; source?: string | null; expiresAt?: string | null }
export interface TenantBillingSummary {
  error?: string;
  subscription?: { planKey: string; status: string; enforcementEnabled: boolean; currentPeriodEnd?: string | null; trialEndsAt?: string | null } | null;
  balance?: { includedRemaining: number; purchasedRemaining: number; includedAllowance: number; total: number; periodKey: string | null } | null;
}
export function getSystemTenantEntitlements(token: string, tenantId: string) {
  return apiFetch<{ data: { domains: LicenseDomainRow[]; billing: TenantBillingSummary } }>(
    `/api/system/tenants/${tenantId}/entitlements`,
    { token },
  );
}
export function updateSystemTenantEntitlement(token: string, tenantId: string, key: string, enabled: boolean) {
  return apiFetch<{ data: { key: string; enabled: boolean } }>(
    `/api/system/tenants/${tenantId}/entitlements/${encodeURIComponent(key)}`,
    { token, method: "PUT", body: JSON.stringify({ enabled }) },
  );
}
export function setupSystemTenantPoc(token: string, tenantId: string, body: { credits: number; expiresAt?: string; features?: string[] }) {
  return apiFetch<{ data: { ok: boolean; credits: number; expiresAt: string | null; features: string[]; balance: TenantBillingSummary["balance"] } }>(
    `/api/system/tenants/${tenantId}/poc`,
    { token, method: "POST", body: JSON.stringify(body) },
  );
}
export function grantSystemTenantCredits(token: string, tenantId: string, units: number) {
  return apiFetch<{ data: { ok: boolean; balance: TenantBillingSummary["balance"] } }>(
    `/api/system/tenants/${tenantId}/credits`,
    { token, method: "POST", body: JSON.stringify({ units }) },
  );
}

// Tenant ADMIN - roles + grants

export function getMyFeatures(token: string) {
  return apiFetch<{ data: { features: string[]; role: string } }>(
    "/api/permissions/me",
    { token },
  );
}

/** Canonical RBAC surface: the caller's effective permission keys + scope. */
export type PermissionScope = "own" | "team" | "department" | "workspace";
export function getMyAccess(token: string) {
  return apiFetch<{
    data: {
      role: string;
      roleKey: string | null; // effective built-in role (owner|admin|department_manager|agent|system_admin)
      permissions: string[];
      scope: PermissionScope;
      features: string[];
    };
  }>("/api/permissions/me", { token });
}

export function getPermissionsFeatureRegistry(token: string) {
  return apiFetch<{ data: FeatureMetadata[] }>("/api/permissions/features", { token });
}

export function getUserResolvedFeatures(token: string, userId: string) {
  return apiFetch<{
    data: { user: { id: string; role: string; email: string; name: string }; features: string[] };
  }>(`/api/permissions/users/${userId}`, { token });
}

export function getUserGrants(token: string, userId: string) {
  return apiFetch<{ data: UserFeatureGrantRow[] }>(
    `/api/permissions/users/${userId}/grants`,
    { token },
  );
}

export function setUserGrant(
  token: string,
  userId: string,
  feature: string,
  body: { granted: boolean; reason?: string },
) {
  return apiFetch<{ data: UserFeatureGrantRow }>(
    `/api/permissions/users/${userId}/grants/${feature}`,
    { token, method: "PUT", body: JSON.stringify(body) },
  );
}

export function deleteUserGrant(token: string, userId: string, feature: string) {
  return apiFetch<void>(
    `/api/permissions/users/${userId}/grants/${feature}`,
    { token, method: "DELETE" },
  );
}

export function getTenantRoles(token: string) {
  return apiFetch<{ data: TenantRole[] }>("/api/permissions/roles", { token });
}

export function createTenantRole(
  token: string,
  body: { name: string; description?: string; features?: string[] },
) {
  return apiFetch<{ data: TenantRole }>("/api/permissions/roles", {
    token,
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateTenantRole(
  token: string,
  roleId: string,
  body: { name?: string; description?: string | null },
) {
  return apiFetch<{ data: TenantRole }>(`/api/permissions/roles/${roleId}`, {
    token,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteTenantRole(token: string, roleId: string) {
  return apiFetch<void>(`/api/permissions/roles/${roleId}`, {
    token,
    method: "DELETE",
  });
}

export function setTenantRoleFeatures(token: string, roleId: string, features: string[]) {
  return apiFetch<{ data: TenantRole }>(
    `/api/permissions/roles/${roleId}/features`,
    { token, method: "PUT", body: JSON.stringify({ features }) },
  );
}

export function assignUserToRole(token: string, userId: string, roleId: string) {
  return apiFetch<{ data: { userId: string; roleId: string } }>(
    `/api/permissions/users/${userId}/roles/${roleId}`,
    { token, method: "POST" },
  );
}

export function unassignUserFromRole(token: string, userId: string, roleId: string) {
  return apiFetch<void>(`/api/permissions/users/${userId}/roles/${roleId}`, {
    token,
    method: "DELETE",
  });
}

/** Read the hierarchical permission catalog + built-in roles (for the UI). */
export function getPermissionCatalog(token: string) {
  return apiFetch<{ data: PermissionCatalog }>("/api/permissions/catalog", { token });
}

/** A tenant member row for the User Management list (ALL users + assigned role). */
export interface TenantMember {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  phoneNumber: string | null;
  legacyRole: string;
  departmentId: string | null;
  departmentRole: string | null;
  departmentName: string | null;
  // Full multi-department membership; singular fields above = primary (earliest).
  departments?: { departmentId: string; departmentRole: string | null; departmentName: string | null }[];
  roleId: string | null;
  roleName: string | null;
  roleBuiltinKey: string | null;
  scope: "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE" | null;
}
export function getTenantMembers(token: string) {
  return apiFetch<{ data: TenantMember[] }>("/api/permissions/users", { token });
}

/** Full per-user access view for the User Management side panel. */
export interface UserAccessView {
  user: { id: string; role: string; email: string; name: string };
  // roles[].scope is the raw DB enum (uppercase) override, null = inherit role default.
  roles: { roleId: string; scope: "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE" | null }[];
  grants: { feature: string; granted: boolean; reason: string | null }[];
  permissions: string[];
  scope: PermissionScope; // effective (lowercase)
  features: string[];
}
export function getUserAccess(token: string, userId: string) {
  return apiFetch<{ data: UserAccessView }>(`/api/permissions/users/${userId}`, { token });
}

/** Set a user's primary role (+ optional scope override). Replaces existing assignment. */
export function setUserPrimaryRole(
  token: string,
  userId: string,
  body: { roleId: string; scope?: "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE" | null },
) {
  return apiFetch<{ data: unknown }>(`/api/permissions/users/${userId}/role`, {
    token,
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ─── Account (self-service) ─────────────────────────────────

export interface AccountProfile {
  user: { id: string; name: string; email: string; phoneNumber: string | null; locale: string | null; role: string; createdAt: string };
  departmentName: string | null;
  tenantName: string | null;
  tenantDefaultLocale: string;
}
export function getAccount(token: string) {
  return apiFetch<AccountProfile>("/api/account", { token });
}
export function updateAccount(token: string, body: { name?: string; phoneNumber?: string | null; locale?: string }) {
  return apiFetch<{ user: AccountProfile["user"] }>("/api/account", { token, method: "PATCH", body: JSON.stringify(body) });
}

export interface AccountSecurity {
  available: boolean;
  reason?: string;
  mfaEnabled?: boolean;
  totp?: Array<{ id: string; name: string; createdAt: string | null }>;
  passkeys?: Array<{ id: string; name: string; createdAt: string | null }>;
  recoveryCodes?: Array<{ id: string; name: string }>;
  lastLogin?: string | null;
}
export function getAccountSecurity(token: string) {
  return apiFetch<AccountSecurity>("/api/account/security", { token });
}
export function getAccountPasswordLink(token: string) {
  return apiFetch<{ link: string }>("/api/account/password-link", { token, method: "POST" });
}

export interface AccountSession {
  id: string; current: boolean; ip: string | null; userAgent: string | null;
  city: string | null; country: string | null; lastUsed: string | null; expires: string | null;
}
export function getAccountSessions(token: string) {
  return apiFetch<{ available: boolean; sessions: AccountSession[] }>("/api/account/sessions", { token });
}
export function terminateAccountSession(token: string, id: string) {
  return apiFetch<{ ok: boolean }>(`/api/account/sessions/${encodeURIComponent(id)}`, { token, method: "DELETE" });
}
export function terminateAllAccountSessions(token: string) {
  return apiFetch<{ ok: boolean; terminated: number }>("/api/account/sessions", { token, method: "DELETE" });
}

export interface AccountLoginEvent {
  id: string; action: string; success: boolean; ip: string | null;
  city: string | null; country: string | null; userAgent: string | null; timestamp: string;
}
export function getAccountLoginHistory(token: string) {
  return apiFetch<{ available: boolean; events: AccountLoginEvent[] }>("/api/account/login-history", { token });
}

export function requestEmailChange(token: string, newEmail: string) {
  return apiFetch<{ sent: boolean }>("/api/account/email-change", { token, method: "POST", body: JSON.stringify({ newEmail }) });
}
export function verifyEmailChange(token: string, changeToken: string) {
  return apiFetch<{ ok: boolean; email: string }>("/api/account/email-change/verify", { token, method: "POST", body: JSON.stringify({ token: changeToken }) });
}

export interface MemberLoginStatus { status: "active" | "invited" | "disabled"; lastLogin: string | null }
export function getMembersLoginStatus(token: string) {
  return apiFetch<Record<string, MemberLoginStatus>>("/api/agents/login-status", { token });
}

// ─── MFA enforcement ─────────────────────────────────────────

export type MfaRequirementReason = "system_admin" | "tenant_admins" | "all_users" | null;
export interface MfaGate {
  required: boolean;
  reason: MfaRequirementReason;
  enrolled: boolean;
  hasAuthenticator: boolean;
  hasRecovery: boolean;
  mustEnroll: boolean;
  identityAvailable: boolean;
}
/** Is the current user required to have MFA, and have they enrolled (auth + recovery)? */
export function getMfaGate(token: string) {
  return apiFetch<MfaGate>("/api/account/mfa-gate", { token });
}
/** Remove one of the caller's own authenticator devices. */
export function removeMfaDevice(token: string, type: "totp" | "webauthn" | "static", id: string) {
  return apiFetch<{ ok: boolean }>(`/api/account/security/device/${type}/${encodeURIComponent(id)}`, { token, method: "DELETE" });
}

export interface TenantMfaPolicy { mfaRequiredForAdmins: boolean; mfaRequiredForAllUsers: boolean }
export interface MfaComplianceCounts { protected: number; total: number }
export interface TenantSecurity {
  policy: TenantMfaPolicy;
  systemAdminAlways: boolean;
  idpAvailable: boolean;
  compliance: { admins: MfaComplianceCounts; users: MfaComplianceCounts };
}
export function getTenantSecurity(token: string) {
  return apiFetch<TenantSecurity>("/api/tenant/security", { token });
}
export function updateTenantSecurity(token: string, patch: Partial<TenantMfaPolicy>) {
  return apiFetch<TenantSecurity>("/api/tenant/security", { token, method: "PATCH", body: JSON.stringify(patch) });
}
export interface TenantSecurityMember {
  id: string; name: string; email: string; role: string; isActive: boolean;
  hasAuthenticator: boolean; hasRecovery: boolean; enrolled: boolean;
  required: boolean; requirementReason: MfaRequirementReason; compliant: boolean;
}
export function getTenantSecurityReview(token: string) {
  return apiFetch<{ idpAvailable: boolean; members: TenantSecurityMember[] }>("/api/tenant/security/review", { token });
}
