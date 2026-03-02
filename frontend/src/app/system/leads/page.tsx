"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { SystemLayout } from "@/components/SystemLayout";
import { getLeads, getLeadStats, updateLead, deleteLead, exportLeadsCsv } from "@/lib/api";

type LeadStatus = "NEW" | "CONTACTED" | "APPROVED" | "REJECTED";

interface Lead {
  id: string;
  firstName: string;
  email: string;
  phone: string | null;
  company: string | null;
  role: string;
  companySize: string;
  frustration: string | null;
  source: string;
  status: LeadStatus;
  leadScore: number;
  notes: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Stats {
  total: number;
  new: number;
  contacted: number;
  approved: number;
  rejected: number;
  recentWeek: number;
}

const STATUS_OPTIONS: { value: LeadStatus | ""; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

const STATUS_COLORS: Record<LeadStatus, string> = {
  NEW: "bg-blue-50 text-blue-700 ring-blue-200",
  CONTACTED: "bg-amber-50 text-amber-700 ring-amber-200",
  APPROVED: "bg-green-50 text-green-700 ring-green-200",
  REJECTED: "bg-red-50 text-red-700 ring-red-200",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export default function LeadsCRMPage() {
  const { token } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState("");
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  const fetchLeads = useCallback(async () => {
    if (!token) return;
    try {
      const params: Record<string, string> = {
        page: String(page),
        limit: "25",
        sortBy: "createdAt",
        sortOrder,
      };
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;

      const res = await getLeads(token, params);
      setLeads(res.data);
      setMeta({ total: res.meta.total, totalPages: res.meta.totalPages });
    } catch (err) {
      console.error("Failed to load leads:", err);
    } finally {
      setLoading(false);
    }
  }, [token, page, search, statusFilter, sortOrder]);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getLeadStats(token);
      setStats(res.data);
    } catch (err) {
      console.error("Failed to load lead stats:", err);
    }
  }, [token]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Debounced search
  function handleSearchChange(val: string) {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(val);
      setPage(1);
    }, 300);
  }

  // Status change inline
  async function handleStatusChange(leadId: string, newStatus: LeadStatus) {
    if (!token) return;
    try {
      const res = await updateLead(token, leadId, { status: newStatus });
      setLeads((prev) => prev.map((l) => l.id === leadId ? res.data : l));
      if (selectedLead?.id === leadId) setSelectedLead(res.data);
      fetchStats();
    } catch (err) {
      console.error("Failed to update status:", err);
    }
  }

  // Save notes
  async function handleSaveNotes(leadId: string) {
    if (!token) return;
    try {
      const res = await updateLead(token, leadId, { notes: notesValue });
      setLeads((prev) => prev.map((l) => l.id === leadId ? res.data : l));
      if (selectedLead?.id === leadId) setSelectedLead(res.data);
      setEditingNotes(null);
    } catch (err) {
      console.error("Failed to save notes:", err);
    }
  }

  // Export CSV
  async function handleExport() {
    if (!token) return;
    try {
      const res = await exportLeadsCsv(token, statusFilter || undefined);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }

  // Delete lead
  async function handleDelete(leadId: string) {
    if (!token || !confirm("Delete this lead permanently?")) return;
    try {
      await deleteLead(token, leadId);
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
      if (selectedLead?.id === leadId) setSelectedLead(null);
      fetchStats();
    } catch (err) {
      console.error("Failed to delete lead:", err);
    }
  }

  return (
    <SystemLayout>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
            <p className="text-sm text-gray-500 mt-1">Manage early access whitelist signups</p>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition shadow-subtle"
          >
            <ExportIcon className="w-4 h-4" />
            Export CSV
          </button>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="New" value={stats.new} color="blue" />
            <StatCard label="Contacted" value={stats.contacted} color="amber" />
            <StatCard label="Approved" value={stats.approved} color="green" />
            <StatCard label="Rejected" value={stats.rejected} color="red" />
            <StatCard label="This Week" value={stats.recentWeek} color="purple" />
          </div>
        )}

        {/* Toolbar: Search + Filter + Sort */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, email, or company..."
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-400 transition"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-4 py-2.5 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500/20 cursor-pointer"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={() => setSortOrder((o) => o === "desc" ? "asc" : "desc")}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition"
          >
            <SortIcon className="w-4 h-4 text-gray-400" />
            {sortOrder === "desc" ? "Newest" : "Oldest"}
          </button>
        </div>

        {/* Table */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-subtle">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : leads.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <p className="text-lg font-medium">No leads found</p>
              <p className="text-sm mt-1">Try adjusting your search or filters</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Company</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Role</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Source</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="w-10 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr
                      key={lead.id}
                      className="border-b border-gray-50 hover:bg-gray-50/50 transition cursor-pointer"
                      onClick={() => setSelectedLead(lead)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{lead.firstName}</p>
                        {lead.notes && <p className="text-xs text-gray-400 truncate max-w-[140px]">{lead.notes}</p>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{lead.email}</td>
                      <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">{lead.company || "—"}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{lead.role}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={lead.status}
                          onChange={(e) => handleStatusChange(lead.id, e.target.value as LeadStatus)}
                          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ring-1 appearance-none cursor-pointer focus:outline-none ${STATUS_COLORS[lead.status]}`}
                        >
                          <option value="NEW">New</option>
                          <option value="CONTACTED">Contacted</option>
                          <option value="APPROVED">Approved</option>
                          <option value="REJECTED">Rejected</option>
                        </select>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs hidden lg:table-cell">{lead.source}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{timeAgo(lead.createdAt)}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setSelectedLead(lead)}
                          className="text-gray-400 hover:text-gray-600 transition"
                        >
                          <ChevronRightIcon className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
              <p className="text-xs text-gray-400">
                {meta.total} lead{meta.total !== 1 ? "s" : ""} total
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Prev
                </button>
                <span className="px-3 py-1.5 text-xs text-gray-500">
                  {page} / {meta.totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                  disabled={page === meta.totalPages}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Lead Detail Drawer ─────────────────────────────── */}
      {selectedLead && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => { setSelectedLead(null); setEditingNotes(null); }}
          />

          {/* Drawer */}
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-gray-100 overflow-y-auto animate-slide-in">
            {/* Header */}
            <div className="sticky top-0 bg-white/95 backdrop-blur-sm z-10 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-gray-900">Lead Details</h2>
                <button
                  onClick={() => { setSelectedLead(null); setEditingNotes(null); }}
                  className="p-1.5 rounded-lg hover:bg-gray-100 transition text-gray-400 hover:text-gray-600"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* Identity */}
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-gradient-to-br from-primary-400 to-primary-600 rounded-2xl flex items-center justify-center text-white font-bold text-lg shrink-0">
                  {selectedLead.firstName.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-lg font-bold text-gray-900">{selectedLead.firstName}</p>
                  <p className="text-sm text-gray-500">{selectedLead.email}</p>
                  {selectedLead.phone && <p className="text-sm text-gray-400">{selectedLead.phone}</p>}
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</label>
                <select
                  value={selectedLead.status}
                  onChange={(e) => handleStatusChange(selectedLead.id, e.target.value as LeadStatus)}
                  className={`mt-1 block w-full text-sm font-semibold px-3 py-2 rounded-xl ring-1 appearance-none cursor-pointer focus:outline-none ${STATUS_COLORS[selectedLead.status]}`}
                >
                  <option value="NEW">New</option>
                  <option value="CONTACTED">Contacted</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                </select>
              </div>

              {/* Details Grid */}
              <div className="grid grid-cols-2 gap-4">
                <DetailField label="Company" value={selectedLead.company || "—"} />
                <DetailField label="Role" value={selectedLead.role} />
                <DetailField label="Company Size" value={selectedLead.companySize} />
                <DetailField label="Source" value={selectedLead.source} />
                <DetailField label="Lead Score" value={String(selectedLead.leadScore)} />
                <DetailField label="Signed Up" value={formatDateTime(selectedLead.createdAt)} />
              </div>

              {/* Frustration */}
              {selectedLead.frustration && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Pain Point</label>
                  <p className="mt-1 text-sm text-gray-700 bg-gray-50 rounded-xl p-3">{selectedLead.frustration}</p>
                </div>
              )}

              {/* Notes */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Notes</label>
                  {editingNotes !== selectedLead.id && (
                    <button
                      onClick={() => { setEditingNotes(selectedLead.id); setNotesValue(selectedLead.notes || ""); }}
                      className="text-xs text-primary-500 hover:text-primary-600 font-medium"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {editingNotes === selectedLead.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={notesValue}
                      onChange={(e) => setNotesValue(e.target.value)}
                      rows={3}
                      className="w-full text-sm border border-gray-200 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-400 resize-none"
                      placeholder="Add notes about this lead..."
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingNotes(null)}
                        className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleSaveNotes(selectedLead.id)}
                        className="px-4 py-1.5 text-xs font-semibold text-white bg-primary-500 rounded-lg hover:bg-primary-600 transition"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-xl p-3 min-h-[48px]">
                    {selectedLead.notes || <span className="text-gray-300 italic">No notes yet</span>}
                  </p>
                )}
              </div>

              {/* Converted */}
              {selectedLead.convertedAt && (
                <div className="bg-green-50 rounded-xl p-3 text-sm text-green-700">
                  Converted on {formatDateTime(selectedLead.convertedAt)}
                </div>
              )}

              {/* Delete */}
              <div className="pt-4 border-t border-gray-100">
                <button
                  onClick={() => handleDelete(selectedLead.id)}
                  className="text-xs text-red-400 hover:text-red-600 transition font-medium"
                >
                  Delete this lead
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slide-in 0.2s ease-out;
        }
      `}</style>
    </SystemLayout>
  );
}

// ─── Sub-Components ──────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  const colorClasses: Record<string, string> = {
    blue: "text-blue-600",
    amber: "text-amber-600",
    green: "text-green-600",
    red: "text-red-600",
    purple: "text-purple-600",
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${color ? colorClasses[color] : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-sm text-gray-900 mt-0.5">{value}</p>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function SortIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
    </svg>
  );
}

function ExportIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
