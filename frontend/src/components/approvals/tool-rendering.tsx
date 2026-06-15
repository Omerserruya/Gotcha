"use client";

/**
 * Shared rendering helpers for approval cards.
 * Used by both the in-conversation `ApprovalCard` and the dedicated
 * `/approvals` list page so the tool name + parameter preview look
 * identical everywhere.
 */

const TOOL_META: Record<string, { label: string; icon: string; system?: string }> = {
  integration_create_lead: { label: "Create Lead", icon: "🎯", system: "Zoho CRM" },
  integration_update_deal: { label: "Update Deal", icon: "📝", system: "Zoho CRM" },
  integration_contact_search: { label: "Search Contact", icon: "🔍", system: "Zoho CRM" },
  integration_create_deal: { label: "Create Deal", icon: "🤝", system: "HubSpot" },
  integration_process_refund: { label: "Process Refund", icon: "💰", system: "Shopify" },
  send_message: { label: "Send Message", icon: "💬" },
  create_broadcast: { label: "Create Broadcast", icon: "📣" },
  schedule_broadcast: { label: "Schedule Broadcast", icon: "📅" },
  merge_contacts: { label: "Merge Contacts", icon: "🔗" },
  tag_contact: { label: "Tag Contact", icon: "🏷️" },
  link_customer_identifier: { label: "Link Identifier", icon: "🔗" },
};

export function humanizeTool(tool: string): { label: string; icon: string; system?: string } {
  if (TOOL_META[tool]) return TOOL_META[tool];
  const cleaned = tool
    .replace(/^integration_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { label: cleaned, icon: "⚡" };
}

// Unwraps Zoho's `{ data: [{ ... }] }` envelope so we render the actual record.
export function unwrapRecord(params: Record<string, unknown>): Record<string, unknown> {
  const data = (params as any).data;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    return data[0] as Record<string, unknown>;
  }
  return params;
}

// Humanize a snake_case / PascalCase parameter key.
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  // Object: render the most-meaningful field if any, else compact JSON
  const pickable = ["name", "label", "title", "id", "value"];
  for (const k of pickable) {
    if (typeof (v as any)[k] === "string") return (v as any)[k];
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "(complex)";
  }
}

// Generic preview: clean two-column key/value rows, no JSON noise.
export function ParamRows({ params }: { params: Record<string, unknown> }) {
  const record = unwrapRecord(params);
  const entries = Object.entries(record).filter(([, v]) => v !== "" && v != null);
  if (entries.length === 0) {
    return (
      <div className="text-[12px] text-gray-400 italic px-3 py-2 border border-dashed border-gray-200 rounded-md">
        No parameters
      </div>
    );
  }
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50 divide-y divide-gray-100">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-3 px-3 py-1.5 text-[12.5px]">
          <span className="text-gray-500 w-32 shrink-0 truncate">{humanizeKey(k)}</span>
          <span className="text-gray-900 break-words flex-1" dir="auto">
            {formatValue(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Tool-specific previews - fall back to the generic ParamRows.
export function ToolPreview({
  tool,
  params,
}: {
  tool: string;
  params: Record<string, unknown>;
}) {
  if (tool === "integration_create_lead") return <LeadPreview params={params} />;
  if (tool === "send_message") return <MessagePreview params={params} />;
  return <ParamRows params={params} />;
}

function LeadPreview({ params }: { params: Record<string, unknown> }) {
  const r = unwrapRecord(params) as Record<string, any>;
  const fullName = [r.First_Name, r.Last_Name].filter(Boolean).join(" ").trim();
  const fields: Array<{ icon: string; label: string; value?: string | null }> = [
    { icon: "👤", label: "Name", value: fullName || r.Name || null },
    { icon: "📧", label: "Email", value: r.Email || null },
    { icon: "📱", label: "Phone", value: r.Phone || r.Mobile || null },
    { icon: "🏢", label: "Company", value: r.Company || null },
    { icon: "🌐", label: "Website", value: r.Website || null },
    { icon: "🎯", label: "Source", value: r.Lead_Source || null },
  ].filter((f) => f.value);

  return (
    <div className="rounded-md border border-gray-100 bg-white overflow-hidden">
      <div className="px-3 py-1.5 bg-gradient-to-r from-indigo-50 to-white border-b border-gray-100 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
        New lead preview
      </div>
      <div className="p-3 space-y-1.5">
        {fields.map((f) => (
          <div key={f.label} className="flex items-baseline gap-2 text-[13px]">
            <span aria-hidden>{f.icon}</span>
            <span className="text-gray-500 w-16 shrink-0">{f.label}</span>
            <span className="text-gray-900 font-medium break-all" dir="auto">
              {f.value}
            </span>
          </div>
        ))}
        {r.Description && (
          <div className="pt-2 mt-2 border-t border-gray-100">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Notes</div>
            <div className="text-[13px] text-gray-700 leading-relaxed" dir="auto">
              {String(r.Description)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessagePreview({ params }: { params: Record<string, unknown> }) {
  const body = (params as any).body || (params as any).text || "";
  const channel = (params as any).channel;
  return (
    <div className="rounded-md border border-gray-100 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
        Message to send {channel ? `· ${channel}` : ""}
      </div>
      <div
        className="inline-block max-w-full bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 text-[13px] text-gray-900 leading-relaxed"
        dir="auto"
      >
        {String(body)}
      </div>
    </div>
  );
}

// Risk chip - reused across surfaces.
export function RiskChip({ level }: { level: "low" | "medium" | "high" }) {
  const tone =
    level === "high"
      ? "bg-rose-100 text-rose-700 ring-1 ring-rose-200"
      : level === "medium"
      ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
      : "bg-gray-100 text-gray-700 ring-1 ring-gray-200";
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${tone}`}>
      {level} risk
    </span>
  );
}

// Resolve "requestedBy" string into a friendly label. The bot stores
// "bot" / "flow:<id>" / "ai-agent:<id>" / "<userId>" - the list endpoint
// already resolves user ids into a separate `requestedByName`, so the row
// can pass that in here.
export function formatRequestedBy(
  requestedBy: string | null | undefined,
  resolvedName?: string | null,
): string {
  if (!requestedBy) return "system";
  if (resolvedName) return resolvedName;
  if (requestedBy === "bot") return "Bot";
  if (requestedBy.startsWith("flow:")) return "Flow";
  if (requestedBy.startsWith("ai-agent:")) return "AI agent";
  return requestedBy;
}
