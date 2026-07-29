import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireOnboardingOrActiveTenant, requirePermissionOrRole, safeFetch, requireEntitlement, requireCapacity } from "@chatcenter/shared";
import { processDocument } from "../services/embedding.service";
import { deleteByDocumentId, deleteByKnowledgeBaseId } from "../services/qdrant.service";
import { parseFile, isAllowedMimeType, resolveMimeType } from "../services/file-parser.service";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/**
 * Document metadata is provenance, not a free-form bag. It is written by the
 * onboarding projection and read back by the re-scan reconciler and the
 * Knowledge Manager, so it is allowlisted on the way in: a client must not be
 * able to smuggle a `tenantId` (which would be read as authoritative by a
 * future consumer) or an unbounded blob into a Json column.
 */
const DOC_META_KEYS = new Set([
  "origin", "topic", "sourceType", "dedupeKey", "sourceUrl", "normalizedUrl",
  "checksum", "scanVersion", "language", "createdDuringOnboarding",
  "lastRefreshedAt", "manualEdit",
]);

function sanitizeDocMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!DOC_META_KEYS.has(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 2048);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// PENDING_ONBOARDING is allowed: Movement 6 of onboarding uploads files and
// creates the first knowledge base BEFORE the tenant flips ACTIVE.
router.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requirePermissionOrRole("ai:knowledge:read", "ADMIN"));

// List knowledge bases
router.get("/", async (req: Request, res: Response) => {
  try {
    const knowledgeBases = await prisma.knowledgeBase.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        documents: {
          // `metadata` and `sourceUrl` are selected because the Knowledge
          // Manager renders provenance (where this came from, when it was last
          // refreshed, whether a human edited it) and the re-scan reconciler
          // matches on metadata.dedupeKey. `updatedAt` drives "last refreshed".
          select: {
            id: true, title: true, status: true, chunkCount: true,
            sourceType: true, sourceUrl: true, metadata: true,
            createdAt: true, updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: knowledgeBases });
  } catch (err) {
    console.error("List knowledge bases error:", err);
    res.status(500).json({ error: "Failed to list knowledge bases" });
  }
});

// Create knowledge base
router.post(
  "/",
  requirePermissionOrRole("ai:knowledge:write", "ADMIN"),
  requireEntitlement("ai.knowledge_base"),
  requireCapacity("limit:knowledge_sources", (tenantId) => prisma.knowledgeBase.count({ where: { tenantId } })),
  async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const kb = await prisma.knowledgeBase.create({
      data: {
        tenantId: req.tenantId!,
        name,
        description: description || null,
      },
    });
    res.status(201).json({ data: kb });
  } catch (err) {
    console.error("Create knowledge base error:", err);
    res.status(500).json({ error: "Failed to create knowledge base" });
  }
});

// Update knowledge base
router.patch("/:id", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { name, description, isActive } = req.body;
    const updated = await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update knowledge base error:", err);
    res.status(500).json({ error: "Failed to update knowledge base" });
  }
});

// Delete knowledge base
router.delete("/:id", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    await deleteByKnowledgeBaseId(kb.id);
    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete knowledge base error:", err);
    res.status(500).json({ error: "Failed to delete knowledge base" });
  }
});

// Upload document to knowledge base
router.post("/:id/documents", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    let { title, content, sourceType, sourceUrl, metadata } = req.body;

    if (sourceType === "url" && sourceUrl) {
      try {
        // SSRF-hardened: scheme allowlist, DNS-resolved private/metadata IP
        // block, per-hop redirect revalidation. Never bare-fetch a URL that
        // came from a request body.
        const response = await safeFetch(String(sourceUrl), {
          headers: { "User-Agent": "ChatCenter-Bot/1.0" },
          timeoutMs: 30000,
        });
        if (!response.ok && response.status === 0) {
          throw new Error(response.error || "fetch blocked");
        }
        const html = response.text;
        const textContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        content = textContent.slice(0, 100000);
        title = title || new URL(sourceUrl).hostname;
      } catch (err) {
        console.error("[KB] URL crawl failed:", err);
        // Fall back to storing URL as content if fetch fails
      }
    }

    if (!title || !content) {
      res.status(400).json({ error: "Title and content are required" });
      return;
    }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: sourceType || "text",
        sourceUrl: sourceUrl || null,
        // Provenance travels with the document: which onboarding source it
        // came from, its content checksum and its dedupe key. Without this the
        // re-scan has no way to recognise a page it already ingested and can
        // only ever append, which is how a knowledge base grows a fresh copy
        // of every page on each refresh.
        metadata: sanitizeDocMetadata(metadata),
        status: "pending",
      },
    });

    // Auto-trigger processing, same as the file-upload route. Without this a
    // document created here stays `pending` with no embeddings, so it is never
    // retrievable - the readiness report's "answer it now" gap resolver looked
    // like it saved while the employee never actually learned the answer.
    processDocument(doc.id).catch((err) => {
      console.error(`[Knowledge] Background processing failed for ${doc.id}:`, err.message);
    });

    res.status(201).json({ data: doc });
  } catch (err) {
    console.error("Upload document error:", err);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

// Update a document in place (content and/or provenance metadata).
//
// This route is what makes a website re-scan a REFRESH rather than an append.
// Without it the only way to reflect a changed page was to create a second
// document, so every refresh grew the knowledge base and retrieval started
// returning several stale copies of the same page ranked above the current
// one. Re-embedding is triggered only when the body actually changed, so an
// unchanged page costs nothing.
router.put("/:id/documents/:docId", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    // Tenant scoping is on the WHERE, not on a post-hoc check: a document id
    // from another tenant simply does not match and 404s.
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: String(req.params.docId), knowledgeBaseId: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    const { title, content, metadata, manualEdit } = req.body as {
      title?: string; content?: string; metadata?: unknown; manualEdit?: boolean;
    };

    const nextContent = typeof content === "string" && content.trim() ? content : doc.content;
    const contentChanged = nextContent !== doc.content;

    // A human editing the body stamps manualEdit, which makes later machine
    // refreshes leave this document alone. The flag is sticky: once a person
    // has corrected an entry, a scan must not quietly un-correct it.
    const priorMeta = (doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata))
      ? (doc.metadata as Record<string, unknown>)
      : {};
    const incoming = sanitizeDocMetadata(metadata) ?? {};
    const nextMeta: Record<string, unknown> = { ...priorMeta, ...incoming };
    if (manualEdit === true) nextMeta.manualEdit = true;
    else if (priorMeta.manualEdit === true) nextMeta.manualEdit = true;

    const updated = await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        title: typeof title === "string" && title.trim() ? title.trim() : doc.title,
        content: nextContent,
        metadata: nextMeta,
        // Only a content change invalidates the vectors.
        status: contentChanged ? "pending" : doc.status,
      },
    });

    if (contentChanged) {
      // Drop the old vectors FIRST. Re-embedding without deleting leaves the
      // superseded chunks in Qdrant, so retrieval keeps answering from text
      // the customer already corrected.
      await deleteByDocumentId(doc.id).catch((err) => {
        console.error(`[Knowledge] Failed clearing vectors for ${doc.id}:`, err?.message);
      });
      processDocument(doc.id).catch((err) => {
        console.error(`[Knowledge] Background reprocessing failed for ${doc.id}:`, err.message);
      });
    }

    res.json({ data: { ...updated, reprocessing: contentChanged } });
  } catch (err) {
    console.error("Update document error:", err);
    res.status(500).json({ error: "Failed to update document" });
  }
});

// Delete document
router.delete("/:id/documents/:docId", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: String(req.params.docId), knowledgeBaseId: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    await deleteByDocumentId(doc.id);
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// Upload file document to knowledge base
router.post("/:id/documents/upload", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), upload.single("file"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const file = req.file;
    if (!file) { res.status(400).json({ error: "File is required" }); return; }

    const mime = resolveMimeType(file.mimetype, file.originalname);
    if (!isAllowedMimeType(mime)) {
      res.status(400).json({ error: "Unsupported file type. Allowed: PDF, DOCX, DOC, MD, TXT" });
      return;
    }

    const title = (req.body.title as string) || file.originalname.replace(/\.[^.]+$/, "");
    const content = await parseFile(file.buffer, mime);

    if (!content.trim()) {
      res.status(400).json({ error: "Could not extract text from file" });
      return;
    }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: "file",
        status: "pending",
        metadata: {
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
        },
      },
    });

    // Auto-trigger processing
    processDocument(doc.id).catch((err) => {
      console.error(`[Knowledge] Background processing failed for ${doc.id}:`, err.message);
    });

    res.status(201).json({ data: doc });
  } catch (err: any) {
    console.error("File upload error:", err.message);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// Trigger document processing (embedding generation)
router.post("/:id/documents/:docId/process", requirePermissionOrRole("ai:knowledge:write", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: String(req.params.docId), knowledgeBaseId: String(req.params.id), tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    // Process async - don't block the request
    processDocument(doc.id).catch((err) => {
      console.error(`[Knowledge] Background processing failed for ${doc.id}:`, err.message);
    });

    res.json({ data: { status: "processing", documentId: doc.id } });
  } catch (err) {
    console.error("Process document error:", err);
    res.status(500).json({ error: "Failed to trigger processing" });
  }
});

export default router;
