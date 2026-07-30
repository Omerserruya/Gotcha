"use client";

/**
 * The integration list.
 *
 * Two visually distinct regions, because they are different kinds of thing:
 *
 *   Tool integrations   - have executable tools and policy. Selecting one shows
 *                         its tools. This is what the screen is for.
 *   Other connected     - status only, owned by Channels or Knowledge Manager.
 *     services            Not selectable here; the row opens the screen that
 *                         owns it. Never shows a tool count.
 *
 * The separation is the point. A channel that appears in the same list as
 * Shopify, with the same affordances, teaches the reader that channels have
 * tool policy - and then the empty tool panel makes the product look broken.
 */

import clsx from "clsx";
import type { ConnectionState, WorkspaceEntry, WorkspaceSidebar } from "@/lib/api-integration-workspace";

const STATE_DOT: Record<ConnectionState, string> = {
  connected: "bg-emerald-500",
  warning: "bg-amber-500",
  disconnected: "bg-rose-500",
  available: "bg-gray-300",
  not_entitled: "bg-gray-300",
};

function stateLabel(state: ConnectionState, he: boolean): string {
  const en: Record<ConnectionState, string> = {
    connected: "Connected",
    warning: "Needs attention",
    disconnected: "Disconnected",
    available: "Available",
    not_entitled: "Not in your plan",
  };
  const heb: Record<ConnectionState, string> = {
    connected: "מחובר",
    warning: "דורש טיפול",
    disconnected: "מנותק",
    available: "זמין",
    not_entitled: "לא בתוכנית",
  };
  return he ? heb[state] : en[state];
}

function Initial({ entry }: { entry: WorkspaceEntry }) {
  if (entry.logoUrl) {
    return <img src={entry.logoUrl} alt="" className="w-6 h-6 rounded-md object-contain shrink-0" />;
  }
  return (
    <span
      className={clsx(
        "w-6 h-6 rounded-md shrink-0 flex items-center justify-center text-[10px] font-bold",
        entry.internal ? "bg-primary-100 text-primary-700" : "bg-gray-100 text-gray-500",
      )}
    >
      {entry.name.charAt(0).toUpperCase()}
    </span>
  );
}

function ToolRow({
  entry, selected, onSelect, he,
}: { entry: WorkspaceEntry; selected: boolean; onSelect: () => void; he: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-testid={`sidebar-integration-${entry.id}`}
      className={clsx(
        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-start transition",
        selected ? "bg-primary-50 ring-1 ring-primary-200" : "hover:bg-gray-50",
      )}
    >
      <Initial entry={entry} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={clsx("text-sm truncate", selected ? "font-semibold text-primary-700" : "text-gray-800")}>
            {entry.name}
          </span>
          <span className={clsx("w-1.5 h-1.5 rounded-full shrink-0", STATE_DOT[entry.state])} title={stateLabel(entry.state, he)} />
        </span>
        {entry.warning?.reason === "missing_scopes" && (
          <span className="block text-[10px] text-amber-600 truncate">
            {he ? "חסרות הרשאות" : "missing permissions"}
          </span>
        )}
      </span>
      {/* Only tool integrations carry a count, and it is never 0 here. */}
      {entry.toolCount !== null && (
        <span className="shrink-0 text-[10px] font-medium text-gray-400 tabular-nums">{entry.toolCount}</span>
      )}
    </button>
  );
}

function ExternalRow({ entry, he }: { entry: WorkspaceEntry; he: boolean }) {
  const ownerLabel = he
    ? entry.owner === "channels" ? "ערוצים" : entry.owner === "knowledge" ? "מאגר ידע" : "הגדרות"
    : entry.owner === "channels" ? "Channels" : entry.owner === "knowledge" ? "Knowledge" : "Setup";
  return (
    <a
      href={entry.href ?? "#"}
      data-testid={`sidebar-external-${entry.id}`}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-start transition hover:bg-gray-50 group"
    >
      <Initial entry={entry} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm truncate text-gray-600">{entry.name}</span>
          <span className={clsx("w-1.5 h-1.5 rounded-full shrink-0", STATE_DOT[entry.state])} title={stateLabel(entry.state, he)} />
        </span>
        {/* Says where it is managed, so nobody looks for its policy here. */}
        <span className="block text-[10px] text-gray-400 truncate">{ownerLabel}</span>
      </span>
      <svg className="w-3.5 h-3.5 shrink-0 text-gray-300 group-hover:text-gray-500 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      </svg>
    </a>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{title}</p>
      {hint && <p className="px-2.5 pb-1.5 text-[10px] text-gray-400">{hint}</p>}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function IntegrationSidebar({
  sidebar, selectedId, onSelect, he, search, onSearch,
}: {
  sidebar: WorkspaceSidebar;
  selectedId: string | null;
  onSelect: (id: string) => void;
  he: boolean;
  search: string;
  onSearch: (v: string) => void;
}) {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const q = search.trim().toLowerCase();
  const match = (e: WorkspaceEntry) => !q || e.name.toLowerCase().includes(q) || (e.category ?? "").toLowerCase().includes(q);

  const connected = sidebar.toolIntegrations.connected.filter(match);
  const available = sidebar.toolIntegrations.available.filter(match);
  const unavailable = sidebar.toolIntegrations.unavailable.filter(match);
  const external = sidebar.externalConnections.filter(match);
  const nothing = !connected.length && !available.length && !unavailable.length && !external.length;

  return (
    <aside className="w-full md:w-64 shrink-0 md:border-e border-gray-100 md:pe-3">
      <div className="mb-3">
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={L("Search integrations", "חיפוש אינטגרציות")}
          aria-label={L("Search integrations", "חיפוש אינטגרציות")}
          data-testid="integration-search"
          className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm outline-none focus:bg-white focus:border-primary-300 focus:ring-2 focus:ring-primary-100 transition"
        />
      </div>

      {nothing && (
        <p className="px-2.5 py-6 text-xs text-gray-400" data-testid="sidebar-empty">
          {q
            ? L("Nothing matches that.", "אין התאמות.")
            : L("No integrations yet.", "אין עדיין אינטגרציות.")}
        </p>
      )}

      {connected.length > 0 && (
        <Group title={L("Connected", "מחוברים")}>
          {connected.map((e) => (
            <ToolRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={() => onSelect(e.id)} he={he} />
          ))}
        </Group>
      )}

      {available.length > 0 && (
        <Group title={L("Available", "זמינים")}>
          {available.map((e) => (
            <ToolRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={() => onSelect(e.id)} he={he} />
          ))}
        </Group>
      )}

      {unavailable.length > 0 && (
        <Group title={L("Not usable now", "לא זמינים כרגע")}>
          {unavailable.map((e) => (
            <ToolRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={() => onSelect(e.id)} he={he} />
          ))}
        </Group>
      )}

      {external.length > 0 && (
        <Group
          title={L("Other connected services", "שירותים מחוברים אחרים")}
          hint={L("Managed elsewhere. No tool permissions here.", "מנוהלים במקום אחר. אין כאן הרשאות כלים.")}
        >
          {external.map((e) => (
            <ExternalRow key={e.id} entry={e} he={he} />
          ))}
        </Group>
      )}
    </aside>
  );
}

export default IntegrationSidebar;
