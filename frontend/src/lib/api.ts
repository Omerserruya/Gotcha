const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function apiFetch<T = any>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers: extraHeaders, ...rest } = options;

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
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// ─── Waitlist (public, no auth) ──────────────────────────────

export function submitWaitlistEntry(data: {
  firstName: string;
  email: string;
  phone?: string;
  role: string;
  companySize: string;
  companyDomain?: string;
  frustration?: string;
}) {
  return apiFetch<{ data: { id: string } }>("/api/waitlist", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ─── Auth ───────────────────────────────────────────────────

export function login(email: string, password: string, tenantSlug: string) {
  return apiFetch<{ token: string; refreshToken: string; user: any }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, tenantSlug }),
  });
}

export function refreshAccessToken(refreshToken: string) {
  return apiFetch<{ token: string; refreshToken: string; expiresIn: number }>("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

export function getMe(token: string) {
  return apiFetch<{ user: any }>("/api/auth/me", { token });
}

// ─── Password Management ───────────────────────────────────

export function changePassword(token: string, currentPassword: string, newPassword: string) {
  return apiFetch<{ success: boolean }>("/api/auth/change-password", {
    token,
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function forgotPassword(email: string, tenantSlug: string) {
  return apiFetch<{ success: boolean; message: string }>("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email, tenantSlug }),
  });
}

export function resetPassword(resetToken: string, newPassword: string) {
  return apiFetch<{ success: boolean }>("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token: resetToken, newPassword }),
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

export function createAgent(token: string, data: { name: string; email: string; password: string }) {
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

export function resetAgentPassword(token: string, id: string, newPassword: string) {
  return apiFetch<any>(`/api/agents/${id}/reset-password`, { token, method: "POST", body: JSON.stringify({ newPassword }) });
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

// Recent posts for a Facebook/Instagram channel — used by the Comment
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

export function updateWebchatSettings(token: string, accountId: string, settings: { color?: string; iconUrl?: string; title?: string; subtitle?: string; welcome?: string; position?: string }) {
  return apiFetch<{ data: any }>(`/api/channels/webchat/${accountId}/settings`, {
    token, method: "PUT", body: JSON.stringify(settings)
  });
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
  // Per-invocation idempotency key — the backend dedup layer collapses
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
      // Phase 1 — Live Call CoPilot feature flags. Optional for back-compat
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

export function systemLogin(email: string, password: string) {
  return apiFetch<{ token: string; user: any }>("/api/system/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

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

export function createTenant(token: string, data: { name: string; slug: string; adminEmail: string; adminPassword: string; adminName: string }) {
  return apiFetch<{ data: any }>("/api/system/tenants", { token, method: "POST", body: JSON.stringify(data) });
}

export function updateTenant(token: string, id: string, data: { name?: string; isActive?: boolean }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function createTenantUser(token: string, tenantId: string, data: { email: string; password: string; name: string; role?: string }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/users`, { token, method: "POST", body: JSON.stringify(data) });
}

export function updateTenantUser(token: string, tenantId: string, userId: string, data: { isActive?: boolean; role?: string }) {
  return apiFetch<{ data: any }>(`/api/system/tenants/${tenantId}/users/${userId}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function resendOnboardingLink(token: string, tenantId: string) {
  return apiFetch<{ data: { message: string; sentTo: string } }>(`/api/system/tenants/${tenantId}/resend-onboarding`, {
    token, method: "POST",
  });
}

export function seedSystemAdmin(data: { email: string; password: string; name: string; setupSecret: string }) {
  return apiFetch<{ data: any }>("/api/system/seed", { method: "POST", body: JSON.stringify(data) });
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

// ─── Magic Link ────────────────────────────────────────────

export function verifyMagicLink(token: string) {
  return apiFetch<{ token: string; refreshToken: string; user: any; tenantStatus: string }>("/api/auth/verify-magic-link", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

// ─── Onboarding ────────────────────────────────────────────

export function getOnboardingStatus(token: string) {
  return apiFetch<{ data: any }>("/api/onboarding/status", { token });
}

export function saveBusinessProfile(token: string, data: {
  organizationName: string;
  businessDescription: string;
  locale?: string;
  // Onboarding v2 — multi-select goals + the original domain the user
  // typed so we can re-run the analysis later from settings.
  businessGoals?: string[];
  websiteDomain?: string;
  // Legacy fields — kept optional so callers outside the 2-screen flow
  // (e.g. settings) can still patch them; onboarding ignores them.
  industry?: string;
  businessPriority?: string;
  estimatedDailyConversations?: number;
  numberOfAgents?: number;
}) {
  return apiFetch<{ data: any }>("/api/onboarding/business-profile", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

// Onboarding v2 — analyze a domain to AI-suggest a business description.
export interface AnalyzeDomainResult {
  ok: boolean;
  domain?: string;
  description?: string;
  reason?: "invalid_domain" | "fetch_failed" | "ai_unavailable" | "no_summary";
}
export function analyzeBusinessDomain(token: string, domain: string, locale?: string) {
  return apiFetch<{ data: AnalyzeDomainResult }>("/api/onboarding/analyze-domain", {
    token, method: "POST", body: JSON.stringify({ domain, locale }),
  });
}

// Onboarding v2 — invite teammates by email (magic-link based).
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

// Onboarding v2 — generate a shareable tenant invite link.
export function createInviteLink(token: string, role?: "ADMIN" | "AGENT") {
  return apiFetch<{ data: { url: string; token: string; expiresAt: string } }>("/api/onboarding/invite-link", {
    token, method: "POST", body: JSON.stringify({ role: role || "AGENT" }),
  });
}

// Public — fetch invite details by token (used by /join page).
export function getPublicInvite(inviteToken: string) {
  return apiFetch<{ data: { tenant: { name: string; slug: string }; email: string | null; role: string; requiresPassword: boolean } }>(`/api/public/onboarding/invite/${encodeURIComponent(inviteToken)}`, {});
}

// Public — accept an invite (creates the user / sets their password).
export function acceptPublicInvite(payload: { token: string; name: string; email?: string; password: string }) {
  return apiFetch<{ data: { ok: true; tenantId: string } }>("/api/public/onboarding/invite/accept", {
    method: "POST", body: JSON.stringify(payload),
  });
}

export type OnboardingMissionId =
  | "confirm_business"
  | "connect_channel"
  | "send_test_reply"
  | "review_agent_tone"
  | "invite_teammate";

export interface OnboardingMission {
  id: OnboardingMissionId;
  status: "done" | "active" | "pending";
  deepLink: string;
}

export function getOnboardingMissions(token: string) {
  return apiFetch<{ data: { missions: OnboardingMission[] } }>("/api/onboarding/missions", { token });
}

export function getBusinessProfile(token: string) {
  return apiFetch<{ data: any }>("/api/onboarding/business-profile", { token });
}

export function saveOnboardingDepartments(token: string, data: { departments: any[] }) {
  return apiFetch<{ data: any[] }>("/api/onboarding/departments", {
    token, method: "POST", body: JSON.stringify(data),
  });
}

export function getOnboardingDepartments(token: string) {
  return apiFetch<{ data: any[] }>("/api/onboarding/departments", { token });
}

export function completeOnboarding(token: string) {
  return apiFetch<{ data: any }>("/api/onboarding/complete", {
    token, method: "POST",
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

export function initGoogleDriveOAuth(token: string, kbId: string) {
  return apiFetch<{ url: string }>(`/api/knowledge/oauth/google-drive/init?kbId=${kbId}`, { token });
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
 * Toggle a single tool for one AI agent. Writes `AgentToolPermission`.
 * Use after `toggleIntegrationTool` so the underlying `TenantTool` is
 * also enabled — both layers must be true for the bot to see the tool.
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
 * Returns the provider's authorize URL — caller should window.location = url.
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

export function updateAIAgent(token: string, id: string, data: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/ai-agents/${id}`, { token, method: "PATCH", body: JSON.stringify(data) });
}

export function deleteAIAgent(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/ai-agents/${id}`, { token, method: "DELETE" });
}

export function testAgentChat(token: string, agentId: string, message: string, history: Array<{role: "user"|"assistant", content: string}>) {
  return apiFetch<{ data: { reply: string } }>(`/api/ai-agents/${agentId}/test-chat`, {
    token, method: "POST", body: JSON.stringify({ message, history })
  });
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

// ─── Voice Sessions (Phase 1 — Live Call CoPilot) ───────────
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

// ─── Voice Channels (Phase 2 — Twilio onboarding) ───────────
//
// Tenant-owned Twilio accounts (BYO). `authToken` is write-only — the
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
   * TenantFunnel.id (cuid) — pins this voice channel to a specific funnel
   * for stage resolution. Overrides the department-scoped funnel lookup.
   * Lets a tenant run different pipelines per phone number.
   */
  funnelId?: string;
  /**
   * AIAgent.id — the AI Employee that drives call-pilot turns on this
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
   * (legacy behavior — the call rings until Twilio's own timeout or
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
   * "fire and forget" — agent walks away from the computer, mobile rings.
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
  createdAt: string;
  updatedAt: string;
  features: { roleId: string; feature: string; createdAt: string }[];
  _count?: { assignments: number };
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

// SYSTEM_ADMIN — feature registry + tenant feature toggles

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

// Tenant ADMIN — roles + grants

export function getMyFeatures(token: string) {
  return apiFetch<{ data: { features: string[]; role: string } }>(
    "/api/permissions/me",
    { token },
  );
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
