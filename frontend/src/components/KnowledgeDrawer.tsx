"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getKnowledgeBases,
  createKnowledgeBase,
  uploadKnowledgeDocument,
  uploadKnowledgeFile,
  getKnowledgeIntegrations,
  initConfluenceOAuth,
  initGoogleDriveOAuth,
} from "@/lib/api";
import clsx from "clsx";

// ─── Types ─────────────────────────────────────────────────
interface KnowledgeDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  linkedKbIds: string[];
  onToggleKb: (kbId: string, linked: boolean) => void;
}

type DrawerView = "list" | "create" | "upload";

// "sources" covers the connected knowledge integrations (Google Drive /
// Confluence). Uploading a file was previously the only way to fill a KB from
// here, which meant a tenant with Drive connected still had to leave the
// employee editor to use it.
type UploadMode = "file" | "url" | "text" | "sources";

const STATUS_ICON: Record<string, { color: string; icon: string }> = {
  ready: { color: "bg-green-100 text-green-600", icon: "M5 13l4 4L19 7" },
  processing: { color: "bg-amber-100 text-amber-600", icon: "M12 6v6l4 2" },
  error: { color: "bg-red-100 text-red-600", icon: "M6 18L18 6M6 6l12 12" },
  pending: { color: "bg-gray-100 text-gray-500", icon: "M12 6v6l4 2" },
};

// ─── Component ─────────────────────────────────────────────
export default function KnowledgeDrawer({ isOpen, onClose, linkedKbIds, onToggleKb }: KnowledgeDrawerProps) {
  const { token } = useAuth();
  const { t } = useI18n();

  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<DrawerView>("list");

  // Create KB state
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Upload state
  const [uploadKbId, setUploadKbId] = useState<string | null>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>("file");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploadUrl, setUploadUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Which knowledge integrations this KB already has connected. Drives the
  // "Drive / Confluence" source options: a connected provider offers browsing,
  // an unconnected one offers connecting. Loaded per KB when the source tab
  // opens - the drawer is otherwise KB-agnostic.
  const [kbIntegrations, setKbIntegrations] = useState<any[]>([]);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !uploadKbId || uploadMode !== "sources") return;
    let cancelled = false;
    getKnowledgeIntegrations(token, uploadKbId)
      .then((res) => { if (!cancelled) setKbIntegrations((res as any)?.data || []); })
      .catch(() => { if (!cancelled) setKbIntegrations([]); });
    return () => { cancelled = true; };
  }, [token, uploadKbId, uploadMode]);

  /** Start OAuth for a knowledge provider, scoped to the KB being filled. */
  async function connectProvider(provider: "confluence" | "google_drive") {
    if (!token || !uploadKbId) return;
    setConnectingProvider(provider);
    try {
      const res = provider === "confluence"
        ? await initConfluenceOAuth(token, uploadKbId)
        : await initGoogleDriveOAuth(token, uploadKbId);
      window.location.href = res.url;
    } catch (err) {
      console.error(`Failed to init ${provider} OAuth:`, err);
      setConnectingProvider(null);
    }
  }

  useEffect(() => {
    if (!isOpen || !token) return;
    loadKbs();
  }, [isOpen, token]);

  async function loadKbs() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await getKnowledgeBases(token);
      setKnowledgeBases(res.data || []);
    } catch {
      setKnowledgeBases([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!token || !newName.trim()) return;
    setCreating(true);
    try {
      const res = await createKnowledgeBase(token, { name: newName.trim(), description: newDesc.trim() || undefined });
      const newKb = res.data;
      await loadKbs();
      // Auto-link the new KB
      if (newKb?.id) {
        onToggleKb(newKb.id, true);
        // Go to upload view for the new KB
        setUploadKbId(newKb.id);
        setView("upload");
      }
      setNewName("");
      setNewDesc("");
    } catch (err: any) {
      alert(err.message || "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpload() {
    if (!token || !uploadKbId) return;
    setUploading(true);
    try {
      if (uploadMode === "file" && uploadFile) {
        await uploadKnowledgeFile(token, uploadKbId, uploadFile, uploadFile.name);
      } else if (uploadMode === "url" && uploadUrl.trim()) {
        await uploadKnowledgeDocument(token, uploadKbId, {
          title: uploadUrl.trim(),
          content: uploadUrl.trim(),
          sourceType: "url",
          sourceUrl: uploadUrl.trim(),
        });
      } else if (uploadMode === "text" && uploadContent.trim()) {
        await uploadKnowledgeDocument(token, uploadKbId, {
          title: uploadTitle.trim() || "Untitled",
          content: uploadContent.trim(),
          sourceType: "text",
        });
      }
      await loadKbs();
      // Reset and go back to list
      resetUpload();
      setView("list");
    } catch (err: any) {
      alert(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function resetUpload() {
    setUploadFile(null);
    setUploadTitle("");
    setUploadContent("");
    setUploadUrl("");
    setUploadMode("file");
  }

  function openUploadFor(kbId: string) {
    setUploadKbId(kbId);
    resetUpload();
    setView("upload");
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ms-auto w-full max-w-[480px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
          {view !== "list" && (
            <button onClick={() => setView("list")} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900">
              {view === "list" ? t("aiStudio.agents.editor.knowledge.title") : view === "create" ? t("knowledge.createKb") : t("knowledge.uploadDocument")}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {view === "list" ? t("aiStudio.agents.editor.knowledge.subtitle") : view === "create" ? t("knowledge.createKbSub") : t("knowledge.uploadSub")}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {view === "list" && (
            <KbListView
              knowledgeBases={knowledgeBases}
              loading={loading}
              linkedKbIds={linkedKbIds}
              onToggle={onToggleKb}
              onCreateNew={() => setView("create")}
              onUpload={openUploadFor}
              t={t}
            />
          )}
          {view === "create" && (
            <CreateKbView
              name={newName}
              setName={setNewName}
              desc={newDesc}
              setDesc={setNewDesc}
              creating={creating}
              onCreate={handleCreate}
              t={t}
            />
          )}
          {view === "upload" && (
            <UploadView
              mode={uploadMode}
              setMode={setUploadMode}
              file={uploadFile}
              setFile={setUploadFile}
              title={uploadTitle}
              setTitle={setUploadTitle}
              content={uploadContent}
              setContent={setUploadContent}
              url={uploadUrl}
              setUrl={setUploadUrl}
              uploading={uploading}
              onUpload={handleUpload}
              fileInputRef={fileInputRef}
              t={t}
              kbId={uploadKbId}
              integrations={kbIntegrations}
              connectingProvider={connectingProvider}
              onConnectProvider={connectProvider}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── KB List View ──────────────────────────────────────────
function KbListView({
  knowledgeBases, loading, linkedKbIds, onToggle, onCreateNew, onUpload, t,
}: {
  knowledgeBases: any[]; loading: boolean; linkedKbIds: string[];
  onToggle: (id: string, linked: boolean) => void; onCreateNew: () => void;
  onUpload: (kbId: string) => void; t: (key: string) => string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {knowledgeBases.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm text-gray-400 mb-3">{t("aiStudio.agents.editor.knowledge.noSources")}</p>
        </div>
      ) : (
        knowledgeBases.map((kb) => {
          const isLinked = linkedKbIds.includes(kb.id);
          const docCount = kb.documents?.length || kb._count?.documents || 0;
          return (
            <div
              key={kb.id}
              className={clsx(
                "p-4 rounded-xl border transition",
                isLinked ? "border-emerald-200 bg-emerald-50/30" : "border-gray-100 hover:border-gray-200"
              )}
            >
              <div className="flex items-start gap-3">
                <button
                  onClick={() => onToggle(kb.id, !isLinked)}
                  className={clsx(
                    "w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition",
                    isLinked ? "bg-emerald-500 border-emerald-500" : "border-gray-300 hover:border-emerald-400"
                  )}
                >
                  {isLinked && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-gray-900">{kb.name}</h4>
                    <span className={clsx(
                      "px-1.5 py-0.5 rounded-full text-[10px] font-medium",
                      kb.isActive ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-500"
                    )}>
                      {kb.isActive ? t("knowledge.active") : t("knowledge.inactive")}
                    </span>
                  </div>
                  {kb.description && <p className="text-xs text-gray-400 mt-0.5">{kb.description}</p>}
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-gray-400">{docCount} document{docCount !== 1 ? "s" : ""}</span>
                    <button
                      onClick={() => onUpload(kb.id)}
                      className="text-xs text-emerald-600 hover:text-emerald-700 font-medium transition"
                    >
                      + {t("knowledge.uploadDocument")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* Create new KB */}
      <button
        onClick={onCreateNew}
        className="w-full p-4 rounded-xl border-2 border-dashed border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/30 transition flex items-center gap-3 text-start"
      >
        <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700">{t("knowledge.createKb")}</p>
          <p className="text-xs text-gray-400">{t("knowledge.createKbSub")}</p>
        </div>
      </button>
    </div>
  );
}

// ─── Create KB View ────────────────────────────────────────
function CreateKbView({
  name, setName, desc, setDesc, creating, onCreate, t,
}: {
  name: string; setName: (s: string) => void; desc: string; setDesc: (s: string) => void;
  creating: boolean; onCreate: () => void; t: (key: string) => string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.name")}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Product FAQ, Return Policy"
          autoFocus
          className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.description")}</label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What kind of information does this contain?"
          className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
        />
      </div>
      <button
        onClick={onCreate}
        disabled={!name.trim() || creating}
        className="w-full py-3 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition shadow-sm flex items-center justify-center gap-2"
      >
        {creating && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
        {t("knowledge.createKb")}
      </button>
    </div>
  );
}

// ─── Upload View ───────────────────────────────────────────
function UploadView({
  mode, setMode, file, setFile, title, setTitle, content, setContent, url, setUrl,
  uploading, onUpload, fileInputRef, t, kbId, integrations, connectingProvider, onConnectProvider,
}: {
  mode: UploadMode; setMode: (m: UploadMode) => void;
  file: File | null; setFile: (f: File | null) => void;
  title: string; setTitle: (s: string) => void; content: string; setContent: (s: string) => void;
  url: string; setUrl: (s: string) => void; uploading: boolean; onUpload: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>; t: (key: string) => string;
  kbId: string | null;
  integrations: any[];
  connectingProvider: string | null;
  onConnectProvider: (p: "confluence" | "google_drive") => void;
}) {
  const canUpload = mode === "file" ? !!file : mode === "url" ? !!url.trim() : mode === "text" ? !!content.trim() : false;

  const MODE_LABEL: Record<UploadMode, string> = {
    file: t("knowledge.fileUpload"),
    url: t("knowledge.websiteUrl"),
    text: t("knowledge.pasteText"),
    sources: t("knowledge.sourcesTab"),
  };

  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {(["file", "url", "text", "sources"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={clsx(
              "flex-1 px-2 py-2 rounded-lg text-xs font-medium transition",
              mode === m ? "bg-white text-emerald-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* Knowledge integrations (Drive / Confluence). Connecting happens here;
          browsing and importing reuse the full picker on the Manage Knowledge
          page rather than a second, thinner copy of it inside this drawer. */}
      {mode === "sources" && (
        <div className="space-y-2">
          {([
            { provider: "google_drive", label: "Google Drive" },
            { provider: "confluence", label: "Confluence" },
          ] as const).map(({ provider, label }) => {
            const connected = integrations.some((i: any) => i.provider === provider);
            return (
              <div key={provider} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800">{label}</p>
                  <p className="text-xs text-gray-400">
                    {connected ? t("knowledge.sourceConnected") : t("knowledge.sourceNotConnected")}
                  </p>
                </div>
                {connected ? (
                  <a
                    href={kbId ? `/ai-studio/knowledge?kb=${encodeURIComponent(kbId)}` : "/ai-studio/knowledge"}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition"
                  >
                    {t("knowledge.sourceBrowse")}
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={!kbId || connectingProvider === provider}
                    onClick={() => onConnectProvider(provider)}
                    className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
                  >
                    {connectingProvider === provider ? t("knowledge.sourceConnecting") : t("knowledge.sourceConnect")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* File upload */}
      {mode === "file" && (
        <div>
          <input
            ref={fileInputRef as any}
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.md,.txt,.csv,.xls,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <div
            onClick={() => (fileInputRef.current as any)?.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/30 transition"
          >
            <svg className="w-8 h-8 mx-auto text-gray-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {file ? (
              <p className="text-sm text-gray-700 font-medium">{file.name}</p>
            ) : (
              <>
                <p className="text-sm text-gray-500">{t("knowledge.dragDrop")}</p>
                <p className="text-xs text-gray-400 mt-1">PDF, DOC, TXT, CSV, XLS</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* URL */}
      {mode === "url" && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Website URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/page"
            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
          />
        </div>
      )}

      {/* Paste text */}
      {mode === "text" && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.name")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("knowledge.docTitlePlaceholder")}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Paste your content here..."
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none"
            />
          </div>
        </div>
      )}

      {/* Sources connect/browse via their own per-row action - there is nothing
          for a single Upload button to submit in that tab. */}
      {mode !== "sources" && (
        <button
          onClick={onUpload}
          disabled={!canUpload || uploading}
          className="w-full py-3 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition shadow-sm flex items-center justify-center gap-2"
        >
          {uploading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
          {t("knowledge.uploadDocument")}
        </button>
      )}
    </div>
  );
}
