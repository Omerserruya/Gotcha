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

export function getConversationHistory(token: string, customerExternalId: string) {
  return apiFetch<{ data: any[] }>(`/api/conversations/history/${encodeURIComponent(customerExternalId)}`, { token });
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

export function updateAgent(token: string, id: string, data: { name?: string; isActive?: boolean }) {
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

export function getAISuggestions(token: string, conversationId: string, locale?: string) {
  const params = locale ? `?locale=${locale}` : "";
  return apiFetch<{ data: any[]; copilotMode?: string }>(`/api/ai-assist/${conversationId}/suggestions${params}`, { token });
}

export function getAIPrompt(token: string, departmentId: string) {
  return apiFetch<{ data: any }>(`/api/ai-assist/prompt/${departmentId}`, { token });
}

export function getAISummary(token: string, conversationId: string, locale?: string) {
  const params = locale ? `?locale=${locale}` : "";
  return apiFetch<{ data: { summary: string }; copilotMode?: string }>(`/api/ai-assist/${conversationId}/summary${params}`, { token });
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
  industry: string;
  businessDescription: string;
  businessPriority: string;
  estimatedDailyConversations: number;
  numberOfAgents: number;
}) {
  return apiFetch<{ data: any }>("/api/onboarding/business-profile", {
    token, method: "POST", body: JSON.stringify(data),
  });
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

export function getConversationIntelligence(token: string, conversationId: string) {
  return apiFetch<{ data: any }>(`/api/ai-assist/${conversationId}/intelligence`, { token });
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

export function updateIntegrationCredentials(token: string, slug: string, credentials: Record<string, any>) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/credentials`, {
    token, method: "PUT", body: JSON.stringify({ credentials }),
  });
}

export function getIntegrationTools(token: string, slug: string) {
  return apiFetch<{ data: any[] }>(`/api/integrations/${slug}/tools`, { token });
}

export function toggleIntegrationTool(token: string, slug: string, toolSlug: string, isEnabled: boolean) {
  return apiFetch<{ data: any }>(`/api/integrations/${slug}/tools/${toolSlug}`, {
    token, method: "PUT", body: JSON.stringify({ isEnabled }),
  });
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

// ─── System Admin: All Tenants Usage ────────────────────────

export function getSystemUsageStats(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: any }>(`/api/system/usage/stats${qs}`, { token });
}

export function getSystemUsageByTenant(token: string, days?: number) {
  const qs = days ? `?days=${days}` : "";
  return apiFetch<{ data: any[] }>(`/api/system/usage/by-tenant${qs}`, { token });
}
