"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getKnowledgeBases,
  createKnowledgeBase,
  deleteKnowledgeBase,
  updateKnowledgeBase,
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  processKnowledgeDocument,
  uploadKnowledgeFile,
  getKnowledgeIntegrations,
  deleteKnowledgeIntegration,
  initConfluenceOAuth,
  initGoogleDriveOAuth,
  getConfluenceSpaces,
  getConfluencePages,
  syncConfluenceSpaces,
  getDriveFiles,
  getDriveSharedDrives,
  syncDriveFiles,
  setKnowledgeIntegrationAutoSync,
  getAgents,
  getDepartments,
} from "@/lib/api";
import clsx from "clsx";

// ─── Types ────────────────────────────────────────────────────

interface KnowledgeDocument {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  sourceType: string;
  sourceUrl?: string;
  createdAt: string;
}

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  documents: KnowledgeDocument[];
  scope?: string; // "all" | "agent:<id>" | "department:<id>"
  createdAt: string;
}

interface Integration {
  id: string;
  provider: string;
  displayName: string;
  config: any;
  isActive: boolean;
  createdAt: string;
}

type ScopeOption = { value: string; label: string; type: "all" | "agent" | "department" };

// ─── Scope Helpers ────────────────────────────────────────────

// `t` is threaded in rather than read from a hook: this is a module-level
// helper, and the "All AI" default it returns is rendered as a badge on every
// KB row - it stayed English in Hebrew until it was translated here.
function scopeLabel(scope: string | undefined, scopeOptions: ScopeOption[], t: (k: string) => string): string {
  if (!scope || scope === "all") return t("aiStudio.knowledge.manage.scopeAllShort");
  const opt = scopeOptions.find((o) => o.value === scope);
  return opt?.label ?? scope;
}

function scopeBadgeColor(scope: string | undefined): string {
  if (!scope || scope === "all") return "bg-violet-100 text-violet-700";
  if (scope.startsWith("agent:")) return "bg-blue-100 text-blue-700";
  if (scope.startsWith("department:")) return "bg-emerald-100 text-emerald-700";
  return "bg-gray-100 text-gray-600";
}

// ─── Page ─────────────────────────────────────────────────────

// useSearchParams (for the ?kb= deep link) forces this into a Suspense
// boundary - the static build refuses to render the consumer without one.
export default function KnowledgePage() {
  return (
    <Suspense fallback={null}>
      <KnowledgePageInner />
    </Suspense>
  );
}

function KnowledgePageInner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"documents" | "integrations">("documents");

  // Scope options
  const [scopeOptions, setScopeOptions] = useState<ScopeOption[]>([]);

  // Create KB
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbDescription, setNewKbDescription] = useState("");
  const [newKbScope, setNewKbScope] = useState("all");
  const [creating, setCreating] = useState(false);

  // Upload doc
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<"text" | "file" | "url">("file");
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Integrations
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [showConnectMenu, setShowConnectMenu] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  // Edit KB inline
  const [editingKB, setEditingKB] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [savingKB, setSavingKB] = useState(false);

  // Pending destructive action. Deleting a knowledge base takes every document
  // and embedding with it and cannot be undone, so nothing deletes until the
  // user confirms in the dialog this drives.
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "kb"; kbId: string; name: string; docCount: number }
    | { kind: "doc"; kbId: string; docId: string; name: string }
    | null
  >(null);
  const [deleting, setDeleting] = useState(false);

  // Browse modal (Confluence / Drive)
  const [showBrowseModal, setShowBrowseModal] = useState(false);
  const [browseIntegration, setBrowseIntegration] = useState<Integration | null>(null);
  const [browseItems, setBrowseItems] = useState<any[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseSelected, setBrowseSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [browseSpaceKey, setBrowseSpaceKey] = useState<string | null>(null);
  const [browsePages, setBrowsePages] = useState<any[]>([]);

  // Drive folder navigation
  type BreadcrumbItem = { id: string; name: string; driveId?: string };
  const [driveFolderStack, setDriveFolderStack] = useState<BreadcrumbItem[]>([]);
  const [driveTab, setDriveTab] = useState<"my" | "shared">("my");
  const [sharedDrives, setSharedDrives] = useState<any[]>([]);
  const [sharedDrivesLoaded, setSharedDrivesLoaded] = useState(false);

  // Confluence child page navigation
  const [confluencePageStack, setConfluencePageStack] = useState<{ id: string; title: string }[]>([]);

  // ─── Load data ────────────────────────────────────────────

  const loadKnowledgeBases = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getKnowledgeBases(token);
      setKnowledgeBases(res.data);
    } catch (err) {
      console.error("Failed to load knowledge bases:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Deep link from the AI Studio Knowledge tab (?kb=<id>): editing a knowledge
  // base happens only here, so that tab links in rather than duplicating the
  // editor. Runs once per id, and only for a KB that actually loaded, so a
  // stale link falls back to the normal empty state instead of a blank panel.
  const deepLinkKb = searchParams.get("kb");
  useEffect(() => {
    if (!deepLinkKb || !knowledgeBases.some((kb) => kb.id === deepLinkKb)) return;
    setSelectedKb(deepLinkKb);
    setDetailTab("documents");
  }, [deepLinkKb, knowledgeBases]);

  const loadIntegrations = useCallback(async () => {
    if (!token || !selectedKb) return;
    try {
      const res = await getKnowledgeIntegrations(token, selectedKb);
      setIntegrations(res.data);
    } catch (err) {
      console.error("Failed to load integrations:", err);
    }
  }, [token, selectedKb]);

  // Load agents + departments for scope selector
  useEffect(() => {
    if (!token) return;
    Promise.all([
      getAgents(token).catch(() => []),
      getDepartments(token).catch(() => ({ data: [] })),
    ]).then(([agentsRes, deptsRes]) => {
      const agents = Array.isArray(agentsRes) ? agentsRes : [];
      const depts = deptsRes?.data || [];
      const opts: ScopeOption[] = [
        { value: "all", label: t("aiStudio.knowledge.manage.scopeAllShort"), type: "all" },
        ...agents.map((a: any) => ({
          value: `agent:${a.id}`,
          label: `${t("aiStudio.knowledge.manage.scopeAgent")}: ${a.name || a.email}`,
          type: "agent" as const,
        })),
        ...depts.map((d: any) => ({
          value: `department:${d.id}`,
          label: `${t("aiStudio.knowledge.manage.scopeDepartment")}: ${d.name}`,
          type: "department" as const,
        })),
      ];
      setScopeOptions(opts);
    });
  }, [token]);

  useEffect(() => { loadKnowledgeBases(); }, [loadKnowledgeBases]);
  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  // OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      window.history.replaceState({}, "", "/ai-studio/knowledge");
      loadIntegrations();
    }
  }, [loadIntegrations]);

  // ─── Handlers ─────────────────────────────────────────────

  async function handleCreateKb() {
    if (!token || !newKbName.trim()) return;
    setCreating(true);
    try {
      await createKnowledgeBase(token, {
        name: newKbName,
        description: newKbDescription || undefined,
      });
      setShowCreateModal(false);
      setNewKbName("");
      setNewKbDescription("");
      setNewKbScope("all");
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to create KB:", err);
    } finally {
      setCreating(false);
    }
  }

  /** Runs the pending delete once the user has confirmed it. */
  async function runConfirmedDelete() {
    if (!token || !confirmDelete || deleting) return;
    setDeleting(true);
    try {
      if (confirmDelete.kind === "kb") {
        await deleteKnowledgeBase(token, confirmDelete.kbId);
        if (selectedKb === confirmDelete.kbId) setSelectedKb(null);
      } else {
        await deleteKnowledgeDocument(token, confirmDelete.kbId, confirmDelete.docId);
      }
      setConfirmDelete(null);
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to delete:", err);
    } finally {
      setDeleting(false);
    }
  }

  async function handleUploadDoc() {
    if (!token || !selectedKb) return;

    if (uploadMode === "file") {
      if (!selectedFile) return;
      setUploading(true);
      try {
        await uploadKnowledgeFile(token, selectedKb, selectedFile, docTitle || selectedFile.name.replace(/\.[^.]+$/, ""));
        resetUploadModal();
        await loadKnowledgeBases();
      } catch (err) {
        console.error("Failed to upload file:", err);
      } finally {
        setUploading(false);
      }
      return;
    }

    if (uploadMode === "url") {
      if (!docUrl.trim()) return;
      setUploading(true);
      try {
        const res = await uploadKnowledgeDocument(token, selectedKb, {
          title: docTitle || docUrl,
          content: docUrl,
          sourceType: "url",
          sourceUrl: docUrl,
        });
        await processKnowledgeDocument(token, selectedKb, res.data.id);
        resetUploadModal();
        await loadKnowledgeBases();
      } catch (err) {
        console.error("Failed to add URL:", err);
      } finally {
        setUploading(false);
      }
      return;
    }

    // text mode
    if (!docTitle.trim() || !docContent.trim()) return;
    setUploading(true);
    try {
      const res = await uploadKnowledgeDocument(token, selectedKb, {
        title: docTitle,
        content: docContent,
        sourceType: "text",
      });
      await processKnowledgeDocument(token, selectedKb, res.data.id);
      resetUploadModal();
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to upload document:", err);
    } finally {
      setUploading(false);
    }
  }

  function resetUploadModal() {
    setShowUploadModal(false);
    setDocTitle("");
    setDocContent("");
    setDocUrl("");
    setSelectedFile(null);
    setUploadMode("file");
  }


  async function handleReprocessDoc(kbId: string, docId: string) {
    if (!token) return;
    try {
      await processKnowledgeDocument(token, kbId, docId);
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to reprocess document:", err);
    }
  }

  async function handleConnect(provider: "confluence" | "google_drive") {
    if (!token || !selectedKb) return;
    setConnectingProvider(provider);
    setShowConnectMenu(false);
    try {
      const res = provider === "confluence"
        ? await initConfluenceOAuth(token, selectedKb)
        : await initGoogleDriveOAuth(token, selectedKb);
      window.location.href = res.url;
    } catch (err) {
      console.error(`Failed to init ${provider} OAuth:`, err);
      setConnectingProvider(null);
    }
  }

  async function handleDisconnect(intId: string) {
    if (!token) return;
    try {
      await deleteKnowledgeIntegration(token, intId);
      await loadIntegrations();
    } catch (err) {
      console.error("Failed to disconnect:", err);
    }
  }

  async function handleToggleAutoSync(int: Integration) {
    if (!token) return;
    const next = int.config?.autoSync === false; // currently off → turn on
    try {
      await setKnowledgeIntegrationAutoSync(token, int.id, next);
      await loadIntegrations();
    } catch (err) {
      console.error("Failed to toggle auto-sync:", err);
    }
  }

  async function handleBrowse(integration: Integration) {
    if (!token) return;
    setBrowseIntegration(integration);
    setShowBrowseModal(true);
    setBrowseLoading(true);
    setBrowseSelected(new Set());
    setBrowseSpaceKey(null);
    setBrowsePages([]);
    setDriveFolderStack([]);
    setDriveTab("my");
    setSharedDrivesLoaded(false);
    setSharedDrives([]);
    setConfluencePageStack([]);
    try {
      if (integration.provider === "confluence") {
        const res = await getConfluenceSpaces(token, integration.id);
        setBrowseItems(res.data);
      } else {
        const res = await getDriveFiles(token, integration.id);
        setBrowseItems(res.data);
      }
    } catch (err) {
      console.error("Failed to browse:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleBrowseSpacePages(spaceKey: string, parentId?: string, parentTitle?: string) {
    if (!token || !browseIntegration) return;
    setBrowseSpaceKey(spaceKey);
    setBrowseLoading(true);
    if (parentId && parentTitle) {
      setConfluencePageStack((prev) => [...prev, { id: parentId, title: parentTitle }]);
    } else {
      setConfluencePageStack([]);
    }
    try {
      const res = await getConfluencePages(token, browseIntegration.id, spaceKey, parentId);
      setBrowsePages(res.data);
    } catch (err) {
      console.error("Failed to load pages:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleConfluenceBack() {
    if (!token || !browseIntegration || !browseSpaceKey) return;
    const stack = [...confluencePageStack];
    stack.pop(); // remove current
    setConfluencePageStack(stack);
    setBrowseLoading(true);
    try {
      const parentId = stack.length > 0 ? stack[stack.length - 1].id : undefined;
      const res = await getConfluencePages(token, browseIntegration.id, browseSpaceKey, parentId);
      setBrowsePages(res.data);
    } catch (err) {
      console.error("Failed to load pages:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleDriveEnterFolder(folderId: string, folderName: string) {
    if (!token || !browseIntegration) return;
    const currentDriveId = driveFolderStack.length > 0 ? driveFolderStack[0].driveId : undefined;
    setDriveFolderStack((prev) => [...prev, { id: folderId, name: folderName, driveId: currentDriveId }]);
    setBrowseLoading(true);
    try {
      const res = await getDriveFiles(token, browseIntegration.id, folderId, currentDriveId);
      setBrowseItems(res.data);
    } catch (err) {
      console.error("Failed to browse folder:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleDriveBack() {
    if (!token || !browseIntegration) return;
    const stack = [...driveFolderStack];
    stack.pop();
    setDriveFolderStack(stack);
    setBrowseLoading(true);
    try {
      if (stack.length === 0) {
        if (driveTab === "shared") {
          // Back to shared drives list
          if (!sharedDrivesLoaded) {
            const res = await getDriveSharedDrives(token, browseIntegration.id);
            setSharedDrives(res.data);
            setSharedDrivesLoaded(true);
          }
          setBrowseItems([]);
          setBrowseLoading(false);
          return;
        }
        const res = await getDriveFiles(token, browseIntegration.id);
        setBrowseItems(res.data);
      } else {
        const parent = stack[stack.length - 1];
        const res = await getDriveFiles(token, browseIntegration.id, parent.id, parent.driveId);
        setBrowseItems(res.data);
      }
    } catch (err) {
      console.error("Failed to navigate back:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleDriveTabSwitch(tab: "my" | "shared") {
    if (!token || !browseIntegration) return;
    setDriveTab(tab);
    setDriveFolderStack([]);
    setBrowseSelected(new Set());
    setBrowseLoading(true);
    try {
      if (tab === "shared") {
        if (!sharedDrivesLoaded) {
          const res = await getDriveSharedDrives(token, browseIntegration.id);
          setSharedDrives(res.data);
          setSharedDrivesLoaded(true);
        }
        setBrowseItems([]);
      } else {
        const res = await getDriveFiles(token, browseIntegration.id);
        setBrowseItems(res.data);
      }
    } catch (err) {
      console.error("Failed to switch tab:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleEnterSharedDrive(driveId: string, driveName: string) {
    if (!token || !browseIntegration) return;
    setDriveFolderStack([{ id: driveId, name: driveName, driveId }]);
    setBrowseLoading(true);
    try {
      const res = await getDriveFiles(token, browseIntegration.id, undefined, driveId);
      setBrowseItems(res.data);
    } catch (err) {
      console.error("Failed to browse shared drive:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleImportSelected() {
    if (!token || !browseIntegration || browseSelected.size === 0) return;
    setSyncing(true);
    try {
      if (browseIntegration.provider === "confluence") {
        await syncConfluenceSpaces(token, browseIntegration.id, Array.from(browseSelected));
      } else {
        await syncDriveFiles(token, browseIntegration.id, Array.from(browseSelected));
      }
      setShowBrowseModal(false);
      await loadKnowledgeBases();
      await loadIntegrations();
    } catch (err) {
      console.error("Failed to import:", err);
    } finally {
      setSyncing(false);
    }
  }

  function toggleBrowseItem(id: string) {
    setBrowseSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!docTitle) setDocTitle(file.name.replace(/\.[^.]+$/, ""));
    }
  }

  const activeKb = knowledgeBases.find((kb) => kb.id === selectedKb);

  // ─── Render ───────────────────────────────────────────────

  const inputClass =
    "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back */}
        <button
          onClick={() => router.push("/ai-studio")}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-5 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("aiStudio.knowledge.page.backToStudio")}
        </button>

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-emerald-100 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{t("aiStudio.knowledge.manage.title")}</h1>
              <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.knowledge.manage.subtitle")}</p>
            </div>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            data-tour="kb-add-source"
            className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("aiStudio.knowledge.manage.newKbTitle")}
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-4 md:gap-6 max-w-6xl">
          {/* ── KB List ────────────────────────────────────── */}
          <div className="w-full md:w-72 md:shrink-0 space-y-2">
            {knowledgeBases.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">{t("aiStudio.knowledge.manage.emptyList")}</p>
                <p className="text-xs text-gray-400 mt-1">{t("aiStudio.knowledge.manage.emptyListHint")}</p>
              </div>
            ) : (
              knowledgeBases.map((kb) => (
                <button
                  key={kb.id}
                  onClick={() => { setSelectedKb(kb.id); setDetailTab("documents"); }}
                  className={clsx(
                    "w-full text-left p-4 rounded-xl border transition",
                    selectedKb === kb.id
                      ? "bg-violet-50 border-violet-200 shadow-sm"
                      : "bg-white border-gray-100 hover:border-gray-200 shadow-card"
                  )}
                >
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-sm text-gray-900 truncate">{kb.name}</h4>
                    <span className={clsx("w-2 h-2 rounded-full shrink-0", kb.isActive ? "bg-green-400" : "bg-gray-300")} />
                  </div>
                  {kb.description && <p className="text-xs text-gray-400 truncate">{kb.description}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <p className="text-xs text-gray-400">
                      {kb.documents.length} {kb.documents.length === 1 ? t("aiStudio.knowledge.manage.document") : t("aiStudio.knowledge.manage.documents")}
                    </p>
                    <span className={clsx("px-1.5 py-0.5 rounded-full text-[10px] font-medium", scopeBadgeColor(kb.scope))}>
                      {scopeLabel(kb.scope, scopeOptions, t)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* ── KB Detail ──────────────────────────────────── */}
          <div className="flex-1 min-w-0">
            {!activeKb ? (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-12 text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <p className="text-sm text-gray-400">{t("aiStudio.knowledge.manage.selectHint")}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* KB Header */}
                <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {editingKB ? (
                        <div className="space-y-2">
                          <input
                            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-400"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder={t("aiStudio.knowledge.manage.namePlaceholder")}
                          />
                          <input
                            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-violet-400"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder={t("aiStudio.knowledge.manage.descPlaceholder")}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              disabled={savingKB || !editName.trim()}
                              onClick={async () => {
                                if (!token || !activeKb) return;
                                setSavingKB(true);
                                try {
                                  await updateKnowledgeBase(token, activeKb.id, { name: editName.trim(), description: editDesc.trim() || undefined });
                                  setKnowledgeBases((prev) =>
                                    prev.map((kb) =>
                                      kb.id === activeKb.id
                                        ? { ...kb, name: editName.trim(), description: editDesc.trim() || null as null }
                                        : kb
                                    )
                                  );
                                  setEditingKB(false);
                                } catch (err) {
                                  console.error("Failed to update KB:", err);
                                } finally {
                                  setSavingKB(false);
                                }
                              }}
                              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white px-3 py-1 rounded-lg text-xs font-medium transition"
                            >
                              {savingKB ? t("aiStudio.knowledge.manage.saving") : t("common.save")}
                            </button>
                            <button
                              onClick={() => setEditingKB(false)}
                              className="text-gray-500 hover:text-gray-700 px-3 py-1 rounded-lg text-xs font-medium transition border border-gray-200"
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-bold text-lg text-gray-900">{activeKb.name}</h3>
                            <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", scopeBadgeColor(activeKb.scope))}>
                              {scopeLabel(activeKb.scope, scopeOptions, t)}
                            </span>
                            <button
                              onClick={() => {
                                setEditName(activeKb.name);
                                setEditDesc(activeKb.description || "");
                                setEditingKB(true);
                              }}
                              className="text-gray-400 hover:text-gray-600 transition"
                              title={t("aiStudio.knowledge.manage.editKb")}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                              </svg>
                            </button>
                          </div>
                          {activeKb.description && <p className="text-sm text-gray-500 mt-0.5">{activeKb.description}</p>}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Add Content button group */}
                      <button
                        onClick={() => setShowUploadModal(true)}
                        className="bg-violet-600 hover:bg-violet-700 text-white px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        {t("aiStudio.knowledge.manage.addContentTitle")}
                      </button>

                      {/* Connect Source dropdown */}
                      <div className="relative">
                        <button
                          onClick={() => setShowConnectMenu(!showConnectMenu)}
                          disabled={!!connectingProvider}
                          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.718a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
                          </svg>
                          {connectingProvider ? "Connecting..." : "Connect Source"}
                        </button>
                        {showConnectMenu && (() => {
                          const gdConnected = integrations.some((i: any) => i.provider === "google_drive");
                          const cfConnected = integrations.some((i: any) => i.provider === "confluence");
                          return (
                          <div className="absolute right-0 top-full mt-1 bg-white rounded-xl shadow-lg border border-gray-200 py-1.5 z-10 w-56">
                            <p className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.manage.externalSources")}</p>
                            <button
                              onClick={() => gdConnected ? setDetailTab("integrations") : handleConnect("google_drive")}
                              className="w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                            >
                              <div className="w-7 h-7 bg-green-100 rounded-lg flex items-center justify-center shrink-0 relative">
                                <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                </svg>
                                {gdConnected && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-gray-800">Google Drive</p>
                                <p className="text-xs text-gray-400">{gdConnected ? "Connected - browse files" : "Connect to import docs"}</p>
                              </div>
                            </button>
                            <button
                              onClick={() => cfConnected ? setDetailTab("integrations") : handleConnect("confluence")}
                              className="w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                            >
                              <div className="w-7 h-7 bg-blue-100 rounded-lg flex items-center justify-center shrink-0 relative">
                                <span className="text-blue-600 text-xs font-bold">C</span>
                                {cfConnected && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-gray-800">Confluence</p>
                                <p className="text-xs text-gray-400">{cfConnected ? "Connected - browse spaces" : "Connect to import wiki"}</p>
                              </div>
                            </button>
                          </div>
                          );
                        })()}
                      </div>

                      <button
                        onClick={() => setConfirmDelete({
                          kind: "kb",
                          kbId: activeKb.id,
                          name: activeKb.name,
                          docCount: activeKb.documents.length,
                        })}
                        className="text-red-400 hover:text-red-600 hover:bg-red-50 p-2 rounded-xl transition"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
                  <button
                    onClick={() => setDetailTab("documents")}
                    className={clsx(
                      "px-4 py-1.5 rounded-lg text-xs font-medium transition",
                      detailTab === "documents" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    Documents ({activeKb.documents.length})
                  </button>
                  <button
                    onClick={() => setDetailTab("integrations")}
                    className={clsx(
                      "px-4 py-1.5 rounded-lg text-xs font-medium transition",
                      detailTab === "integrations" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    Integrations ({integrations.length})
                  </button>
                </div>

                {/* Documents Tab */}
                {detailTab === "documents" && (
                  <>
                    {activeKb.documents.length === 0 ? (
                      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                        <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                          <svg className="w-6 h-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                          </svg>
                        </div>
                        <p className="text-sm text-gray-500">{t("aiStudio.knowledge.manage.noDocs")}</p>
                        <p className="text-xs text-gray-400 mt-1">{t("aiStudio.knowledge.manage.noDocsHint")}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {activeKb.documents.map((doc) => (
                          <div key={doc.id} className="bg-white rounded-xl shadow-card border border-gray-100 p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={clsx(
                                "w-9 h-9 rounded-xl flex items-center justify-center shrink-0",
                                doc.status === "ready" ? "bg-green-100" :
                                doc.status === "processing" ? "bg-amber-100" :
                                doc.status === "error" ? "bg-red-100" : "bg-gray-100"
                              )}>
                                {doc.status === "ready" ? (
                                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                  </svg>
                                ) : doc.status === "processing" ? (
                                  <div className="w-4 h-4 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
                                ) : doc.status === "error" ? (
                                  <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                                  </svg>
                                ) : (
                                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                )}
                              </div>
                              <div className="min-w-0">
                                <h5 className="text-sm font-medium text-gray-900 truncate">{doc.title}</h5>
                                <p className="text-xs text-gray-400">
                                  {doc.sourceType === "url" ? (
                                    <span className="text-blue-500">URL</span>
                                  ) : (
                                    doc.sourceType
                                  )}
                                  {" "}&middot; {doc.chunkCount} chunks &middot;{" "}
                                  <span className={clsx(
                                    doc.status === "ready" ? "text-green-600" :
                                    doc.status === "processing" ? "text-amber-600" :
                                    doc.status === "error" ? "text-red-600" : "text-gray-400"
                                  )}>{doc.status}</span>
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {(doc.status === "error" || doc.status === "pending") && (
                                <button
                                  onClick={() => handleReprocessDoc(activeKb.id, doc.id)}
                                  className="text-violet-500 hover:text-violet-700 hover:bg-violet-50 p-1.5 rounded-lg transition"
                                  title="Reprocess"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                                  </svg>
                                </button>
                              )}
                              <button
                                onClick={() => setConfirmDelete({
                                  kind: "doc",
                                  kbId: activeKb.id,
                                  docId: doc.id,
                                  name: doc.title,
                                })}
                                title={t("aiStudio.knowledge.deleteDoc")}
                                aria-label={t("aiStudio.knowledge.deleteDoc")}
                                className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Integrations Tab */}
                {detailTab === "integrations" && (
                  <>
                    {integrations.length === 0 ? (
                      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                        <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                          <svg className="w-6 h-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.718a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
                          </svg>
                        </div>
                        <p className="text-sm text-gray-500">{t("aiStudio.knowledge.manage.noIntegrations")}</p>
                        <p className="text-xs text-gray-400 mt-1">{t("aiStudio.knowledge.manage.noIntegrationsHint")}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {integrations.map((int) => (
                          <div key={int.id} className="bg-white rounded-xl shadow-card border border-gray-100 p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={clsx(
                                "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold",
                                int.provider === "confluence" ? "bg-blue-100 text-blue-600" : "bg-green-100 text-green-600"
                              )}>
                                {int.provider === "confluence" ? "C" : (
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                  </svg>
                                )}
                              </div>
                              <div className="min-w-0">
                                <h5 className="text-sm font-medium text-gray-900 truncate">{int.displayName}</h5>
                                <p className="text-xs text-gray-400">
                                  {int.provider === "confluence" ? "Confluence" : "Google Drive"}
                                  {int.config?.lastSyncAt && (
                                    <> &middot; Last sync: {new Date(int.config.lastSyncAt).toLocaleDateString()}</>
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => handleToggleAutoSync(int)}
                                title="Re-sync this source automatically every hour when it changes"
                                className={clsx(
                                  "px-2.5 py-1.5 rounded-xl text-xs font-medium transition border",
                                  int.config?.autoSync !== false
                                    ? "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
                                    : "bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100"
                                )}
                              >
                                {int.config?.autoSync !== false ? "Auto-sync: On" : "Auto-sync: Off"}
                              </button>
                              <button
                                onClick={() => handleBrowse(int)}
                                className="bg-violet-50 text-violet-700 hover:bg-violet-100 px-3 py-1.5 rounded-xl text-xs font-medium transition"
                              >
                                {int.provider === "confluence" ? t("aiStudio.knowledge.manage.browseSpaces") : t("aiStudio.knowledge.manage.browseFiles")}
                              </button>
                              <button
                                onClick={() => handleDisconnect(int.id)}
                                className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition"
                                title="Disconnect"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Create KB Modal ────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <h3 className="font-bold text-lg text-gray-900 mb-4">{t("aiStudio.knowledge.manage.newKbTitle")}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldName")}</label>
                <input
                  type="text"
                  value={newKbName}
                  onChange={(e) => setNewKbName(e.target.value)}
                  placeholder={t("aiStudio.knowledge.manage.fieldNamePlaceholder")}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldDesc")}</label>
                <textarea
                  value={newKbDescription}
                  onChange={(e) => setNewKbDescription(e.target.value)}
                  placeholder={t("aiStudio.knowledge.manage.fieldDescPlaceholder")}
                  rows={2}
                  className={clsx(inputClass, "resize-none")}
                />
              </div>

              {/* Scope selector */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldScope")}</label>
                <select
                  value={newKbScope}
                  onChange={(e) => setNewKbScope(e.target.value)}
                  className={inputClass}
                >
                  <optgroup label="Global">
                    <option value="all">{t("aiStudio.knowledge.manage.scopeAll")}</option>
                  </optgroup>
                  {scopeOptions.filter((o) => o.type === "agent").length > 0 && (
                    <optgroup label="Specific Agent">
                      {scopeOptions.filter((o) => o.type === "agent").map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </optgroup>
                  )}
                  {scopeOptions.filter((o) => o.type === "department").length > 0 && (
                    <optgroup label="Department (Agent & Co-Pilot)">
                      {scopeOptions.filter((o) => o.type === "department").map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-xs text-gray-400 mt-1.5">
                  Choose who can access this knowledge: a specific agent, a department (both AI agent and co-pilot), or all AI in the tenant.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition">
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreateKb}
                disabled={!newKbName.trim() || creating}
                className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 shadow-sm"
              >
                {creating ? t("aiStudio.knowledge.manage.creating") : t("aiStudio.knowledge.manage.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload / Add Content Modal ─────────────────────── */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={resetUploadModal} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold text-lg text-gray-900 mb-4">{t("aiStudio.knowledge.manage.addContentTitle")}</h3>

            {/* Mode tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-5">
              {(["file", "url", "text"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setUploadMode(mode)}
                  className={clsx(
                    "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition capitalize",
                    uploadMode === mode ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {mode === "file" ? t("aiStudio.knowledge.manage.modeFile") : mode === "url" ? t("aiStudio.knowledge.manage.modeUrl") : t("aiStudio.knowledge.manage.modeText")}
                </button>
              ))}
            </div>

            <div className="space-y-4">
              {/* Title */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldTitle")}</label>
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  placeholder={uploadMode === "url" ? "e.g. Help Center" : "e.g. Return Policy"}
                  className={inputClass}
                />
              </div>

              {/* File upload */}
              {uploadMode === "file" && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldFile")}</label>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-200 rounded-2xl p-8 text-center cursor-pointer hover:border-violet-300 hover:bg-violet-50/30 transition"
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.md,.txt,.csv,.xls,.xlsx"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    {selectedFile ? (
                      <div>
                        <svg className="w-8 h-8 text-violet-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                    ) : (
                      <div>
                        <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                        <p className="text-sm font-medium text-gray-700">{t("aiStudio.knowledge.manage.dropFiles")}</p>
                        <p className="text-xs text-gray-400 mt-1">PDF, DOCX, TXT, MD, CSV, XLS up to 10MB</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* URL input */}
              {uploadMode === "url" && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldUrl")}</label>
                  <input
                    type="url"
                    value={docUrl}
                    onChange={(e) => setDocUrl(e.target.value)}
                    placeholder={t("aiStudio.knowledge.manage.urlPlaceholder")}
                    className={inputClass}
                  />
                  <p className="text-xs text-gray-400 mt-1.5">{t("aiStudio.knowledge.manage.urlHint")}</p>
                </div>
              )}

              {/* Paste text */}
              {uploadMode === "text" && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t("aiStudio.knowledge.manage.fieldContent")}</label>
                  <textarea
                    value={docContent}
                    onChange={(e) => setDocContent(e.target.value)}
                    placeholder={t("aiStudio.knowledge.manage.contentPlaceholder")}
                    rows={10}
                    className={clsx(inputClass, "resize-none font-mono")}
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={resetUploadModal} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition">
                {t("common.cancel")}
              </button>
              <button
                onClick={handleUploadDoc}
                disabled={
                  uploading ||
                  (uploadMode === "text" ? (!docTitle.trim() || !docContent.trim()) :
                   uploadMode === "url" ? !docUrl.trim() :
                   !selectedFile)
                }
                className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 shadow-sm"
              >
                {uploading ? t("aiStudio.knowledge.manage.processing") : uploadMode === "url" ? t("aiStudio.knowledge.manage.crawlAdd") : t("aiStudio.knowledge.manage.upload")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Browse Modal (Confluence / Drive) ──────────────── */}
      {showBrowseModal && browseIntegration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowBrowseModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
                {/* Back button */}
                {browseIntegration.provider === "confluence" && browseSpaceKey && confluencePageStack.length > 0 ? (
                  <button onClick={handleConfluenceBack} className="text-violet-600 hover:text-violet-700">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                  </button>
                ) : browseIntegration.provider === "confluence" && browseSpaceKey ? (
                  <button onClick={() => { setBrowseSpaceKey(null); setBrowsePages([]); setBrowseSelected(new Set()); setConfluencePageStack([]); }} className="text-violet-600 hover:text-violet-700">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                  </button>
                ) : browseIntegration.provider === "google_drive" && driveFolderStack.length > 0 ? (
                  <button onClick={handleDriveBack} className="text-violet-600 hover:text-violet-700">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                  </button>
                ) : null}

                {/* Title */}
                {browseIntegration.provider === "confluence"
                  ? browseSpaceKey
                    ? confluencePageStack.length > 0
                      ? confluencePageStack[confluencePageStack.length - 1].title
                      : `Pages in ${browseSpaceKey}`
                    : "Confluence Spaces"
                  : driveFolderStack.length > 0
                    ? driveFolderStack[driveFolderStack.length - 1].name
                    : "Google Drive"
                }
              </h3>
              <button onClick={() => setShowBrowseModal(false)} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Breadcrumb for Drive */}
            {browseIntegration.provider === "google_drive" && driveFolderStack.length > 0 && (
              <div className="flex items-center gap-1 mb-3 text-xs text-gray-400 overflow-x-auto">
                <button
                  onClick={() => { setDriveFolderStack([]); handleDriveTabSwitch(driveTab); }}
                  className="text-violet-600 hover:text-violet-700 font-medium shrink-0"
                >
                  {driveTab === "shared" ? "Shared Drives" : "My Drive"}
                </button>
                {driveFolderStack.map((crumb, i) => (
                  <span key={crumb.id} className="flex items-center gap-1 shrink-0">
                    <span>/</span>
                    {i < driveFolderStack.length - 1 ? (
                      <button
                        onClick={async () => {
                          if (!token || !browseIntegration) return;
                          const newStack = driveFolderStack.slice(0, i + 1);
                          setDriveFolderStack(newStack);
                          setBrowseLoading(true);
                          try {
                            const res = await getDriveFiles(token, browseIntegration.id, crumb.id, crumb.driveId);
                            setBrowseItems(res.data);
                          } catch (err) { console.error(err); } finally { setBrowseLoading(false); }
                        }}
                        className="text-violet-600 hover:text-violet-700 font-medium"
                      >
                        {crumb.name}
                      </button>
                    ) : (
                      <span className="text-gray-600 font-medium">{crumb.name}</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            {/* Breadcrumb for Confluence */}
            {browseIntegration.provider === "confluence" && browseSpaceKey && confluencePageStack.length > 0 && (
              <div className="flex items-center gap-1 mb-3 text-xs text-gray-400 overflow-x-auto">
                <button
                  onClick={() => { setBrowseSpaceKey(null); setBrowsePages([]); setBrowseSelected(new Set()); setConfluencePageStack([]); }}
                  className="text-violet-600 hover:text-violet-700 font-medium shrink-0"
                >
                  {t("aiStudio.knowledge.manage.spaces")}
                </button>
                <span>/</span>
                <button
                  onClick={() => { setConfluencePageStack([]); handleBrowseSpacePages(browseSpaceKey); }}
                  className="text-violet-600 hover:text-violet-700 font-medium shrink-0"
                >
                  {browseSpaceKey}
                </button>
                {confluencePageStack.map((crumb, i) => (
                  <span key={crumb.id} className="flex items-center gap-1 shrink-0">
                    <span>/</span>
                    {i < confluencePageStack.length - 1 ? (
                      <button
                        onClick={async () => {
                          if (!token || !browseIntegration) return;
                          const newStack = confluencePageStack.slice(0, i + 1);
                          setConfluencePageStack(newStack);
                          setBrowseLoading(true);
                          try {
                            const res = await getConfluencePages(token, browseIntegration.id, browseSpaceKey, crumb.id);
                            setBrowsePages(res.data);
                          } catch (err) { console.error(err); } finally { setBrowseLoading(false); }
                        }}
                        className="text-violet-600 hover:text-violet-700 font-medium"
                      >
                        {crumb.title}
                      </button>
                    ) : (
                      <span className="text-gray-600 font-medium">{crumb.title}</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            {/* Drive tabs: My Drive / Shared Drives */}
            {browseIntegration.provider === "google_drive" && driveFolderStack.length === 0 && (
              <div className="flex gap-1 mb-3 p-1 bg-gray-100 rounded-xl">
                <button
                  onClick={() => handleDriveTabSwitch("my")}
                  className={clsx("flex-1 text-sm font-medium py-1.5 rounded-lg transition", driveTab === "my" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}
                >
                  {t("aiStudio.knowledge.manage.myDrive")}
                </button>
                <button
                  onClick={() => handleDriveTabSwitch("shared")}
                  className={clsx("flex-1 text-sm font-medium py-1.5 rounded-lg transition", driveTab === "shared" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}
                >
                  {t("aiStudio.knowledge.manage.sharedDrives")}
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto space-y-1">
              {browseLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
                </div>

              ) : browseIntegration.provider === "confluence" && !browseSpaceKey ? (
                /* ── Confluence: Space list ── */
                browseItems.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">{t("aiStudio.knowledge.manage.noSpaces")}</p>
                ) : browseItems.map((space: any) => (
                  <div
                    key={space.key}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggleBrowseItem(space.key)}
                  >
                    <input
                      type="checkbox"
                      checked={browseSelected.has(space.key)}
                      onChange={() => toggleBrowseItem(space.key)}
                      className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                    />
                    <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{space.name}</p>
                      <p className="text-xs text-gray-400">{space.key}</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleBrowseSpacePages(space.key); }}
                      className="text-xs text-violet-600 hover:text-violet-700 font-medium shrink-0"
                    >
                      Browse &rarr;
                    </button>
                  </div>
                ))

              ) : browseIntegration.provider === "confluence" && browseSpaceKey ? (
                /* ── Confluence: Pages with child navigation ── */
                browsePages.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">{t("aiStudio.knowledge.manage.noPages")}</p>
                ) : browsePages.map((page: any) => (
                  <div
                    key={page.id}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggleBrowseItem(page.id)}
                  >
                    <input
                      type="checkbox"
                      checked={browseSelected.has(page.id)}
                      onChange={() => toggleBrowseItem(page.id)}
                      className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                    />
                    <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                    </div>
                    <p className="text-sm text-gray-900 truncate flex-1">{page.title}</p>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleBrowseSpacePages(browseSpaceKey, page.id, page.title); }}
                      className="text-xs text-violet-600 hover:text-violet-700 font-medium shrink-0"
                    >
                      Children &rarr;
                    </button>
                  </div>
                ))

              ) : browseIntegration.provider === "google_drive" && driveTab === "shared" && driveFolderStack.length === 0 ? (
                /* ── Drive: Shared Drives list ── */
                sharedDrives.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">{t("aiStudio.knowledge.manage.noSharedDrives")}</p>
                ) : sharedDrives.map((drive: any) => (
                  <div
                    key={drive.id}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer"
                    onClick={() => handleEnterSharedDrive(drive.id, drive.name)}
                  >
                    <div className="w-7 h-7 bg-violet-50 rounded-lg flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" /></svg>
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate flex-1">{drive.name}</p>
                    <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                  </div>
                ))

              ) : (
                /* ── Drive: Files & Folders with navigation ── */
                browseItems.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">{t("aiStudio.knowledge.manage.emptyFolder")}</p>
                ) : browseItems.map((file: any) => {
                  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
                  return (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer"
                      onClick={() => isFolder ? handleDriveEnterFolder(file.id, file.name) : toggleBrowseItem(file.id)}
                    >
                      {!isFolder && (
                        <input
                          type="checkbox"
                          checked={browseSelected.has(file.id)}
                          onChange={() => toggleBrowseItem(file.id)}
                          className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                        />
                      )}
                      <div className={clsx(
                        "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                        isFolder ? "bg-amber-50" : "bg-green-50"
                      )}>
                        {isFolder ? (
                          <svg className="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                        )}
                      </div>
                      <p className="text-sm text-gray-900 truncate flex-1">{file.name}</p>
                      {isFolder && (
                        <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer: selection count + import button */}
            {browseSelected.size > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
                <p className="text-xs text-gray-500">{browseSelected.size} selected</p>
                <button
                  onClick={handleImportSelected}
                  disabled={syncing}
                  className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 shadow-sm"
                >
                  {syncing ? "Importing..." : "Import Selected"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation. Deleting is irreversible and takes every document
          and embedding with it, so it never happens on a single stray click. */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !deleting && setConfirmDelete(null)} />
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
            <h3 className="text-lg font-bold text-gray-900">
              {confirmDelete.kind === "kb"
                ? t("aiStudio.knowledge.confirmDeleteKbTitle")
                : t("aiStudio.knowledge.confirmDeleteDocTitle")}
            </h3>
            <p className="text-sm text-gray-500 mt-2">
              {confirmDelete.kind === "kb"
                ? t("aiStudio.knowledge.confirmDeleteKbBody")
                    .replace("{name}", confirmDelete.name)
                    .replace("{count}", String(confirmDelete.docCount))
                : t("aiStudio.knowledge.confirmDeleteDocBody").replace("{name}", confirmDelete.name)}
            </p>
            <p className="text-xs text-gray-400 mt-2">{t("aiStudio.knowledge.confirmDeleteIrreversible")}</p>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={runConfirmedDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition disabled:opacity-50 shadow-sm"
              >
                {deleting ? t("aiStudio.knowledge.deleting") : t("aiStudio.knowledge.confirmDeleteAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
