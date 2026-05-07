const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
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
    throw new Error((body as { error?: string }).error || `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────

export type NotificationPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type NotificationChannel = "email" | "in_app";
export type RecipientType = "tenant_owner" | "department_manager" | "users";
export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

export interface InAppNotification {
  id: string;
  tenantId: string;
  userId: string;
  eventType: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationCondition {
  field: string;
  op: ConditionOp;
  value: unknown;
}

export interface NotificationRecipients {
  type: RecipientType;
  userIds?: string[];
}

export interface NotificationPreference {
  id: string;
  tenantId: string;
  departmentId?: string | null;
  eventType: string;
  enabled: boolean;
  conditions?: NotificationCondition[] | null;
  recipients: NotificationRecipients;
  channels: NotificationChannel[];
  priority: NotificationPriority;
}

export interface CreateNotificationPreferencePayload {
  eventType: string;
  enabled: boolean;
  conditions?: NotificationCondition[] | null;
  recipients: NotificationRecipients;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  departmentId?: string | null;
}

export type UpdateNotificationPreferencePayload = Partial<CreateNotificationPreferencePayload>;

// ─── Notifications ───────────────────────────────────────────

export function listNotifications(
  token: string,
  opts?: { unreadOnly?: boolean; limit?: number }
) {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unreadOnly", "true");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch<{ data: InAppNotification[] }>(`/api/notifications${qs}`, { token });
}

export function getUnreadCount(token: string) {
  return apiFetch<{ count: number }>("/api/notifications/unread-count", { token });
}

export function markRead(token: string, id: string) {
  return apiFetch<{ ok: true }>(`/api/notifications/${id}/mark-read`, {
    token,
    method: "POST",
  });
}

export function markAllRead(token: string) {
  return apiFetch<{ ok: true }>("/api/notifications/mark-all-read", {
    token,
    method: "POST",
  });
}

// ─── Notification Preferences ────────────────────────────────

export function listNotificationPreferences(token: string) {
  return apiFetch<{ data: NotificationPreference[] }>("/api/notification-preferences", {
    token,
  });
}

export function createNotificationPreference(
  token: string,
  payload: CreateNotificationPreferencePayload
) {
  return apiFetch<{ data: NotificationPreference }>("/api/notification-preferences", {
    token,
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateNotificationPreference(
  token: string,
  id: string,
  patch: UpdateNotificationPreferencePayload
) {
  return apiFetch<{ data: NotificationPreference }>(`/api/notification-preferences/${id}`, {
    token,
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNotificationPreference(token: string, id: string) {
  return apiFetch<{ ok: true }>(`/api/notification-preferences/${id}`, {
    token,
    method: "DELETE",
  });
}
