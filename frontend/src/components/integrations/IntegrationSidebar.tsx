"use client";

/**
 * The integration list.
 *
 * Two regions, kept apart because they are different kinds of thing:
 *
 *   Tool integrations   have executable tools and policy. Selecting one shows
 *                       its tools. This is what the screen is for.
 *   Other connected     status only, owned by the Knowledge Manager or by a
 *     services          provider's own setup page. Not selectable here; the row
 *                       opens the screen that owns it. Never shows a tool count.
 *                       Every row here is something the tenant HAS connected -
 *                       channels are gone from this list entirely, and an
 *                       unconnected catalog row is not "other connected".
 *
 * Status is carried by the GROUPING, not by a coloured dot on every row. A dot
 * beside each name made the eye scan a column of traffic lights and told the
 * reader nothing the "Connected" heading had not already said. The only badge
 * left is a warning, because that is the one case where a row differs from the
 * group it is filed under.
 */

import { useState } from "react";
import clsx from "clsx";
import type { ConnectionState, WorkspaceEntry, WorkspaceSidebar } from "@/lib/api-integration-workspace";
import { IntegrationLogo } from "./IntegrationLogo";

/** Conditions that belong ON the row, because the group cannot express them. */
function rowCondition(entry: WorkspaceEntry, he: boolean): { label: string; tone: "warn" | "muted" } | null {
  if (entry.warning?.reason === "missing_scopes") {
    return { label: he ? "חסרות הרשאות" : "Missing permissions", tone: "warn" };
  }
  if (entry.state === "disconnected") {
    return { label: he ? "נדרש חיבור מחדש" : "Reconnect required", tone: "warn" };
  }
  if (entry.state === "not_entitled") {
    return { label: he ? "דורש שדרוג" : "Requires plan", tone: "muted" };
  }
  if (entry.warning?.reason === "capability_error") {
    return { label: he ? "החיבור נכשל" : "Connection failed", tone: "warn" };
  }
  return null;
}

function WarnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className="shrink-0">
      <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolRow({
  entry, selected, onSelect, he,
}: { entry: WorkspaceEntry; selected: boolean; onSelect: () => void; he: boolean }) {
  const cond = rowCondition(entry, he);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-testid={`sidebar-integration-${entry.id}`}
      className={clsx(
        "w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
        selected
          ? "bg-gray-100 dark:bg-gray-800"
          : "hover:bg-gray-50 dark:hover:bg-gray-800/60",
      )}
    >
      <IntegrationLogo slug={entry.id} name={entry.name} logoUrl={entry.logoUrl} size={24} />
      <span className="min-w-0 flex-1">
        <span className={clsx(
          "block truncate text-[13px]",
          selected ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-200",
        )}>
          {entry.name}
        </span>
        {cond && (
          <span className={clsx(
            "flex items-center gap-1 text-[10px] leading-tight",
            cond.tone === "warn" ? "text-amber-600" : "text-gray-400",
          )}>
            {cond.tone === "warn" && <WarnIcon />}
            {cond.label}
          </span>
        )}
      </span>
      {/* Only tool integrations carry a count, and it is never 0 here. */}
      {entry.toolCount !== null && (
        <span className="shrink-0 text-[10.5px] text-gray-400 tabular-nums">{entry.toolCount}</span>
      )}
    </button>
  );
}

function ExternalRow({ entry, he }: { entry: WorkspaceEntry; he: boolean }) {
  const ownerLabel = he
    ? entry.owner === "knowledge" ? "מאגר ידע" : "הגדרות"
    : entry.owner === "knowledge" ? "Knowledge" : "Setup";
  return (
    <a
      href={entry.href ?? "#"}
      data-testid={`sidebar-external-${entry.id}`}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition hover:bg-gray-50 dark:hover:bg-gray-800/60"
    >
      <IntegrationLogo slug={entry.id.replace(/^knowledge:/, "").toLowerCase()} name={entry.name} logoUrl={entry.logoUrl} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-gray-500 dark:text-gray-400">{entry.name}</span>
        {/* Says where it is managed, so nobody looks for its policy here. */}
        <span className="block truncate text-[10px] text-gray-400">{ownerLabel}</span>
      </span>
      <svg className="w-3 h-3 shrink-0 text-gray-300 group-hover:text-gray-500 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      </svg>
    </a>
  );
}

function Group({
  id, title, hint, count, children,
}: { id: string; title: string; hint?: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      <button
        type="button"
        data-testid={`sidebar-group-${id}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 rounded"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
          aria-hidden="true"
          className={clsx("transition-transform", open ? "rotate-0" : "-rotate-90 rtl:rotate-90")}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {title}
        <span className="ms-auto tabular-nums text-gray-300">{count}</span>
      </button>
      {open && (
        <>
          {hint && <p className="px-2 pb-1 text-[10px] text-gray-400">{hint}</p>}
          <div className="space-y-0.5">{children}</div>
        </>
      )}
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
  const [searchOpen, setSearchOpen] = useState(false);
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const q = search.trim().toLowerCase();
  const match = (e: WorkspaceEntry) =>
    !q || e.name.toLowerCase().includes(q) || (e.category ?? "").toLowerCase().includes(q);

  const connected = sidebar.toolIntegrations.connected.filter(match);
  // ONE Available group. "Not entitled" is not a different place to look - it
  // is a condition ON the row, which is why rowCondition exists.
  const available = [...sidebar.toolIntegrations.available, ...sidebar.toolIntegrations.unavailable].filter(match);
  const external = sidebar.externalConnections.filter(match);
  const nothing = !connected.length && !available.length && !external.length;

  return (
    <aside className="w-full shrink-0 md:w-[228px] md:border-e md:border-gray-100 md:pe-2 dark:md:border-gray-800">
      <div className="mb-2 flex items-center gap-1 px-2">
        <h2 className="flex-1 text-[13px] font-semibold text-gray-800 dark:text-gray-100">
          {L("Integrations", "אינטגרציות")}
        </h2>
        <button
          type="button"
          data-testid="integration-search-toggle"
          aria-label={L("Search integrations", "חיפוש אינטגרציות")}
          aria-expanded={searchOpen}
          onClick={() => { setSearchOpen((v) => !v); if (searchOpen) onSearch(""); }}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:hover:bg-gray-800"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {searchOpen && (
        <div className="mb-2 px-1">
          <input
            autoFocus
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={L("Search integrations", "חיפוש אינטגרציות")}
            aria-label={L("Search integrations", "חיפוש אינטגרציות")}
            data-testid="integration-search"
            className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12px] outline-none transition focus:border-primary-300 focus:ring-2 focus:ring-primary-100 dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
      )}

      {nothing && (
        <p className="px-2 py-6 text-[11px] text-gray-400" data-testid="sidebar-empty">
          {q ? L("Nothing matches that.", "אין התאמות.") : L("No integrations yet.", "אין עדיין אינטגרציות.")}
        </p>
      )}

      {connected.length > 0 && (
        <Group id="connected" title={L("Connected", "מחוברים")} count={connected.length}>
          {connected.map((e) => (
            <ToolRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={() => onSelect(e.id)} he={he} />
          ))}
        </Group>
      )}

      {available.length > 0 && (
        <>
          <hr data-testid="sidebar-divider" className="my-2 border-gray-100 dark:border-gray-800" />
          <Group id="available" title={L("Available", "אינטגרציות זמינות")} count={available.length}>
            {available.map((e) => (
              <ToolRow key={e.id} entry={e} selected={e.id === selectedId} onSelect={() => onSelect(e.id)} he={he} />
            ))}
          </Group>
        </>
      )}

      {external.length > 0 && (
        <>
          <hr className="my-2 border-gray-100 dark:border-gray-800" />
          <Group
            id="external"
            title={L("Other connected services", "שירותים מחוברים אחרים")}
            hint={L("Managed elsewhere. No tool permissions here.", "מנוהלים במקום אחר. אין כאן הרשאות כלים.")}
            count={external.length}
          >
            {external.map((e) => <ExternalRow key={e.id} entry={e} he={he} />)}
          </Group>
        </>
      )}
    </aside>
  );
}

export default IntegrationSidebar;
