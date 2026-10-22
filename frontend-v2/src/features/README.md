# Features

One directory per product area, added when that area is built:
`inbox/`, `customers/`, `approvals/`, `analytics/`, `outreach/`, `ai-studio/`.

A feature owns its components, its hooks, its domain operations and its
translation namespace. It may depend on `domain/`, `api/`, `design-system/`,
`i18n/`, `permissions/`, `tenant/`, `realtime/`, `server-state/` and `forms/` -
and on other features only through their public entry point.

**Product components live here, not in a shared components folder.**
`ConversationRow`, `OrderCard`, `ApprovalRequest` and `CustomerSummary` belong
to the feature that owns the concept. A generic `components/` directory is
where unrelated abstractions accumulate until nobody can safely change any of
them; the boundaries lint rules exist to prevent that.

Only genuinely product-agnostic building blocks - Button, Input, Dialog - go in
`design-system/`.
