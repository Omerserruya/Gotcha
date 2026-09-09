/**
 * The platform's permission catalogue.
 *
 * Transcribed from the backend's canonical set. Kept as named constants rather
 * than inline strings so that a typo is a compile error and a rename is one
 * edit — a mistyped permission string fails silently by hiding a feature,
 * which is the hardest kind of bug to notice.
 *
 * Format is always `domain:resource:action`. Matching is exact: see
 * `PermissionSet`.
 *
 * Not exhaustive of the backend's 47 — the `platform:*` and `settings:*`
 * families are transcribed as they are needed by the surfaces being built.
 */
export const PERMISSIONS = {
  conversation: {
    messages: {
      read: 'conversation:messages:read',
      reply: 'conversation:messages:reply',
      assign: 'conversation:messages:assign',
      close: 'conversation:messages:close',
      takeover: 'conversation:messages:takeover',
    },
  },
  approvals: {
    requests: {
      view: 'approvals:requests:view',
      approve: 'approvals:requests:approve',
      reject: 'approvals:requests:reject',
    },
    policies: { manage: 'approvals:policies:manage' },
  },
  customer: {
    profile: {
      read: 'customer:profile:read',
      update: 'customer:profile:update',
      export: 'customer:profile:export',
    },
    commerce: {
      read: 'customer:commerce:read',
      open: 'customer:commerce:open',
      cancel: 'customer:commerce:cancel',
      refund: 'customer:commerce:refund',
      return: 'customer:commerce:return',
      note: 'customer:commerce:note',
      notify: 'customer:commerce:notify',
      tag: 'customer:commerce:tag',
    },
  },
  crm: {
    contacts: { read: 'crm:contacts:read', update: 'crm:contacts:update' },
    deals: { read: 'crm:deals:read', update: 'crm:deals:update' },
    activities: { create: 'crm:activities:create' },
  },
  outbound: {
    calls: { view: 'outbound:calls:view', create: 'outbound:calls:create' },
  },
  ai: {
    employees: {
      create: 'ai:employees:create',
      read: 'ai:employees:read',
      update: 'ai:employees:update',
      delete: 'ai:employees:delete',
    },
    knowledge: { read: 'ai:knowledge:read', write: 'ai:knowledge:write' },
    tools: { read: 'ai:tools:read', assign: 'ai:tools:assign', manage: 'ai:tools:manage' },
    workflows: {
      read: 'ai:workflows:read',
      update: 'ai:workflows:update',
      publish: 'ai:workflows:publish',
    },
  },
  analytics: {
    dashboard: { read: 'analytics:dashboard:read' },
    reports: { export: 'analytics:reports:export' },
  },
  channels: {
    manage: { read: 'channels:manage:read', update: 'channels:manage:update' },
  },
  businessSystems: {
    connections: {
      read: 'business-systems:connections:read',
      connect: 'business-systems:connections:connect',
      manage: 'business-systems:connections:manage',
    },
    sot: { select: 'business-systems:sot:select' },
  },
  integrations: {
    connections: {
      read: 'integrations:connections:read',
      connect: 'integrations:connections:connect',
      disconnect: 'integrations:connections:disconnect',
    },
  },
} as const;
