/**
 * What belongs in the Integrations & Tools workspace, and as what.
 *
 * The product boundary is strict and worth stating, because the obvious
 * temptation is to show everything a tenant has ever connected in one list:
 *
 *   - Channels owns communication setup and routing. It is NOT represented
 *     here at all - see "Channels are not integrations" below.
 *   - Knowledge Manager owns Drive and other knowledge sources.
 *   - Integrations & Tools owns external business systems and the permission
 *     policy for their EXECUTABLE tools.
 *
 * So this workspace is not a unified connections screen. An item earns a full
 * entry only when there is actually something to govern here: a connection
 * lifecycle AND one or more executable tools in the catalog AND therefore a
 * meaningful Autonomous / HITL / Disabled choice.
 *
 * A tenant's OWN connections that a tool might depend on but that another
 * screen governs are listed separately, status-only, linking to their owner.
 * The rule that matters most: a status-only entry never shows a tool count.
 * Showing "Google Drive - 0 tools" invites the reader to conclude tools are
 * missing or broken, when the truth is that tool counts do not apply.
 *
 * Classification is DERIVED from the real catalog, never hardcoded per page: a
 * provider that gains its first tool becomes a full integration on its own, and
 * one whose tools are removed stops pretending to have policy.
 *
 * ── Channels are not integrations ───────────────────────────
 *
 * WhatsApp and the rest used to be listed here as status-only rows. It read as
 * a bug and behaved like one: a permissions screen showed comms setup it could
 * not govern, mixed into a list of business systems, and clicking a row threw
 * the reader out to /settings/channels. Channel health belongs on the Channels
 * page. Where the dependency actually matters - the platform's own delivery
 * tools - it is stated on the tool surface itself, next to the tools it gates.
 *
 * ── Nothing to govern and nothing connected means nothing to show ──
 *
 * Two rows used to appear that were not merely misfiled but false. An
 * UNPUBLISHED catalog row (calendly, deliberately withdrawn because its
 * connector is incomplete) was advertised anyway, and the detail route 404s on
 * exactly those - so selecting one was a dead end. And a catalog row with no
 * executable tools that the tenant had never connected (custom_api) sat under a
 * heading reading "connected services" while being connected to nothing. Both
 * are dropped by `classifyCatalogIntegration` returning null. A connection the
 * tenant DOES hold is never hidden, whatever the catalog says about it.
 */

// ─── Kinds ──────────────────────────────────────────────────

export type WorkspaceEntryKind =
  /** Has executable tools and policy. Gets the full tool UI. */
  | "tool_integration"
  /**
   * Connected, and a tool may depend on it, but it is owned by another screen.
   * Status only. No tool count, no permission controls.
   */
  | "external_connection";

/** Which screen owns an external connection, so the link goes to the right place. */
export type ExternalOwner = "knowledge" | "integration_setup";

export type ConnectionState =
  /** Usable right now. */
  | "connected"
  /** Connected but degraded: missing scopes, stale capability, provider errors. */
  | "warning"
  /** Was connected, is not now. Reconnect is the fix. */
  | "disconnected"
  /** Supported and installable, never connected by this tenant. */
  | "available"
  /** Supported, but the tenant's plan does not include it. */
  | "not_entitled";

export interface WorkspaceEntry {
  /** Catalog slug, channel type, or the reserved "gotcha". */
  id: string;
  name: string;
  kind: WorkspaceEntryKind;
  state: ConnectionState;
  category: string | null;
  description: string | null;
  logoUrl: string | null;
  /**
   * Tool count. `null` for external connections - deliberately not 0, so a UI
   * cannot render "0 tools" for something tool counts do not apply to.
   */
  toolCount: number | null;
  /** Owner screen + href, for external connections only. */
  owner?: ExternalOwner;
  href?: string;
  /** Degraded detail, when state is "warning". */
  warning?: { reason: "missing_scopes" | "capability_error" | "stale"; scopes?: string[] };
  /** The platform's own tools. Always present, never disconnectable. */
  internal?: boolean;
}

// ─── Inputs (mirrors of the three real models) ──────────────

export interface CatalogIntegrationInput {
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  logoUrl?: string | null;
  isPublished?: boolean;
  /** Executable tools in the canonical catalog for this provider. */
  toolCount: number;
  /** Present only when this tenant has a connection row. */
  connection?: {
    status: string;
    missingScopes?: string[];
    capabilityStatus?: string | null;
    capabilityFresh?: boolean;
  };
  /** False when the tenant's plan excludes it. */
  entitled?: boolean;
}

export interface KnowledgeSourceInput {
  provider: string;
  isActive: boolean;
}

export interface InternalToolsInput {
  /** Executable internal GOTCHA tools (TOOL_REGISTRY action + system kinds). */
  toolCount: number;
}

// ─── Naming for external connections ────────────────────────

const KNOWLEDGE_NAMES: Record<string, string> = {
  google_drive: "Google Drive",
  confluence: "Confluence",
};

export const GOTCHA_ENTRY_ID = "gotcha";

// ─── Classification ─────────────────────────────────────────

function connectionStateFor(input: CatalogIntegrationInput): ConnectionState {
  if (input.entitled === false) return "not_entitled";
  const conn = input.connection;
  if (!conn) return "available";
  const status = String(conn.status || "").toUpperCase();
  if (status !== "CONNECTED") return "disconnected";
  if (conn.missingScopes?.length) return "warning";
  if (conn.capabilityStatus && conn.capabilityStatus !== "ok") return "warning";
  if (conn.capabilityFresh === false) return "warning";
  return "connected";
}

function warningFor(input: CatalogIntegrationInput): WorkspaceEntry["warning"] {
  const conn = input.connection;
  if (!conn) return undefined;
  if (conn.missingScopes?.length) return { reason: "missing_scopes", scopes: conn.missingScopes };
  if (conn.capabilityStatus && conn.capabilityStatus !== "ok") return { reason: "capability_error" };
  if (conn.capabilityFresh === false) return { reason: "stale" };
  return undefined;
}

/**
 * The platform's own tools. Always a full integration and always connected -
 * there is no connection to lose - so it anchors the top of the list and is the
 * one entry guaranteed to have something to govern.
 */
export function gotchaEntry(input: InternalToolsInput): WorkspaceEntry {
  return {
    id: GOTCHA_ENTRY_ID,
    name: "GOTCHA",
    kind: "tool_integration",
    state: "connected",
    category: "Platform",
    description: "GOTCHA's own system actions: conversations, contacts, tasks, broadcasts and workflows.",
    logoUrl: null,
    toolCount: input.toolCount,
    internal: true,
  };
}

/**
 * A catalog provider becomes a full integration only if it has executable
 * tools. One with none has no policy to show, so it is listed as an external
 * connection pointing at its own setup page rather than as an empty tool
 * surface - but only when the tenant actually holds a connection to it.
 *
 * Returns null when the row does not belong on this screen at all:
 *
 *   - unpublished and unconnected. The catalog withdraws a provider by
 *     unpublishing it (calendly, whose connector is incomplete), and the
 *     detail route already 404s on unpublished rows - listing one produces a
 *     link that cannot open. A tenant who connected it BEFORE it was withdrawn
 *     still sees it, because hiding a live connection is the worse lie.
 *   - no executable tools and no connection. There is no policy to govern and
 *     no connection to report, so every honest thing this screen could say
 *     about it is "nothing". Its own setup page is where it gets connected.
 */
export function classifyCatalogIntegration(input: CatalogIntegrationInput): WorkspaceEntry | null {
  const state = connectionStateFor(input);
  const hasTools = input.toolCount > 0;
  const hasConnection = !!input.connection;
  if (!hasConnection && (input.isPublished === false || !hasTools)) return null;
  return {
    id: input.slug,
    name: input.name,
    kind: hasTools ? "tool_integration" : "external_connection",
    state,
    category: input.category,
    description: input.description,
    logoUrl: input.logoUrl ?? null,
    // null, not 0: see the module note on fake tool counts.
    toolCount: hasTools ? input.toolCount : null,
    ...(hasTools
      ? {}
      : { owner: "integration_setup" as ExternalOwner, href: `/settings/business-systems/${input.slug}` }),
    ...(warningFor(input) ? { warning: warningFor(input) } : {}),
  };
}

/** Knowledge sources are owned by Knowledge Manager. Status only. */
export function classifyKnowledgeSource(input: KnowledgeSourceInput): WorkspaceEntry {
  return {
    id: `knowledge:${input.provider}`,
    name: KNOWLEDGE_NAMES[input.provider] ?? input.provider,
    kind: "external_connection",
    state: input.isActive ? "connected" : "disconnected",
    category: "Knowledge source",
    description: null,
    logoUrl: null,
    toolCount: null,
    owner: "knowledge",
    href: "/ai-studio/knowledge",
  };
}

// ─── Sidebar assembly ───────────────────────────────────────

export interface WorkspaceSidebar {
  /** Have tools and policy. The reason this screen exists. */
  toolIntegrations: {
    connected: WorkspaceEntry[];
    available: WorkspaceEntry[];
    unavailable: WorkspaceEntry[];
  };
  /** Status only, owned elsewhere. Visually separate from the above. */
  externalConnections: WorkspaceEntry[];
}

const STATE_RANK: Record<ConnectionState, number> = {
  connected: 0, warning: 1, disconnected: 2, available: 3, not_entitled: 4,
};

function byStateThenName(a: WorkspaceEntry, b: WorkspaceEntry): number {
  const s = STATE_RANK[a.state] - STATE_RANK[b.state];
  return s !== 0 ? s : a.name.localeCompare(b.name);
}

/**
 * Assemble the sidebar.
 *
 * GOTCHA is pinned first among connected tool integrations: it is the one entry
 * that is always there, and burying the platform's own actions under an
 * alphabetical list of third parties makes them feel like an afterthought.
 */
export function buildWorkspaceSidebar(entries: WorkspaceEntry[]): WorkspaceSidebar {
  const tools = entries.filter((e) => e.kind === "tool_integration");
  const external = entries.filter((e) => e.kind === "external_connection");

  const connected = tools
    .filter((e) => e.state === "connected" || e.state === "warning")
    .sort((a, b) => {
      if (a.internal && !b.internal) return -1;
      if (b.internal && !a.internal) return 1;
      return byStateThenName(a, b);
    });

  return {
    toolIntegrations: {
      connected,
      available: tools.filter((e) => e.state === "available").sort(byStateThenName),
      // Disconnected and plan-blocked are genuinely different problems, but
      // both mean "not usable now", so they share a group with distinct copy
      // rather than two near-identical headings.
      unavailable: tools.filter((e) => e.state === "disconnected" || e.state === "not_entitled").sort(byStateThenName),
    },
    externalConnections: external.sort(byStateThenName),
  };
}

/** Total tools a tenant can actually govern here. Excludes external entries. */
export function governableToolCount(entries: WorkspaceEntry[]): number {
  return entries
    .filter((e) => e.kind === "tool_integration")
    .reduce((n, e) => n + (e.toolCount ?? 0), 0);
}

// ─── Channel dependency ─────────────────────────────────────

/**
 * Channels do not belong in the sidebar, but they are a real precondition for
 * some of the platform's own tools: granting `send_message` while no channel is
 * connected grants the ability to send nothing. So the dependency is stated
 * once, ON the tool surface that depends on it, where it is actionable.
 */
const CHANNEL_NAMES: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  MESSENGER: "Facebook Messenger",
  INSTAGRAM: "Instagram",
  EMAIL: "Email",
  GMAIL: "Gmail",
  OUTLOOK: "Outlook",
  SLACK: "Slack",
  VOICE: "Voice",
  WEBCHAT: "Website chat",
  SHOPIFY_LIVE_CHAT: "Shopify live chat",
};

/**
 * Tools that put a message in front of a customer over a channel.
 *
 * Deliberately narrow. `preview_broadcast` renders without sending and
 * `escalate_to_human` hands off inside a conversation that already exists on a
 * channel - neither needs a channel to be granted, so neither is listed. A set
 * that over-claimed would turn this note into background noise.
 */
export const CHANNEL_DELIVERY_TOOLS: ReadonlySet<string> = new Set([
  "send_message",
  "create_broadcast",
  "schedule_broadcast",
  "schedule_followup",
  "schedule_followup_template",
]);

export interface ChannelDependency {
  /** Human names of channels that can deliver right now. */
  connected: string[];
  /** Connected but in ERROR: still configured, currently not delivering. */
  degraded: string[];
  /** How many tools on THIS surface deliver over a channel. */
  toolCount: number;
  href: string;
}

/**
 * The channel note for a tool surface, or null when there is nothing to say -
 * either no tool here delivers over a channel, or every channel is healthy and
 * the reader needs no warning. A note that appears when all is well is a note
 * people learn to skip.
 */
export function channelDependencyFor(opts: {
  toolNames: string[];
  channels: Array<{ channel: string; connectionStatus: string }>;
}): ChannelDependency | null {
  const toolCount = opts.toolNames.filter((n) => CHANNEL_DELIVERY_TOOLS.has(n)).length;
  if (toolCount === 0) return null;

  const connected: string[] = [];
  const degraded: string[] = [];
  const seen = new Set<string>();
  for (const c of opts.channels) {
    if (seen.has(c.channel)) continue;
    seen.add(c.channel);
    const status = String(c.connectionStatus || "").toUpperCase();
    const name = CHANNEL_NAMES[c.channel] ?? c.channel;
    if (status === "CONNECTED") connected.push(name);
    else if (status === "ERROR") degraded.push(name);
    // DISCONNECTED and friends are not a dependency problem - the tenant chose
    // not to use that channel. Only a channel that is meant to work and does
    // not is worth a line here.
  }
  connected.sort();
  degraded.sort();

  if (degraded.length === 0 && connected.length > 0) return null;
  return { connected, degraded, toolCount, href: "/settings/channels" };
}
