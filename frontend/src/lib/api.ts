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

// ─── Auth ───────────────────────────────────────────────────

export function login(email: string, password: string, tenantSlug: string) {
  return apiFetch<{ token: string; user: any }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, tenantSlug }),
  });
}

export function getMe(token: string) {
  return apiFetch<{ user: any }>("/api/auth/me", { token });
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

export function getConversationHistory(token: string, phone: string) {
  return apiFetch<{ data: any[] }>(`/api/conversations/history/${encodeURIComponent(phone)}`, { token });
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

// ─── Channel Accounts (legacy) ─────────────────────────────

export function getChannelAccounts(token: string) {
  return apiFetch<{ data: any[] }>("/api/agents/settings/channels", { token });
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

export function disconnectChannel(token: string, id: string) {
  return apiFetch<{ success: boolean }>(`/api/channels/${id}/disconnect`, {
    token,
    method: "POST",
  });
}

export function getChannelStatus(token: string, id: string) {
  return apiFetch<{ data: any }>(`/api/channels/${id}/status`, { token });
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

export function getAISuggestions(token: string, conversationId: string) {
  return apiFetch<{ data: any[]; copilotMode?: string }>(`/api/ai-assist/${conversationId}/suggestions`, { token });
}

export function getAISummary(token: string, conversationId: string) {
  return apiFetch<{ data: { summary: string }; copilotMode?: string }>(`/api/ai-assist/${conversationId}/summary`, { token });
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

export function seedSystemAdmin(data: { email: string; password: string; name: string; setupSecret: string }) {
  return apiFetch<{ data: any }>("/api/system/seed", { method: "POST", body: JSON.stringify(data) });
}
