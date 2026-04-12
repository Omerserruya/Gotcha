import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

// GET / — List all published catalog integrations with tenant connection status
router.get("/", async (req: Request, res: Response) => {
  try {
    const catalog = await prisma.integrationCatalog.findMany({
      where: { isPublished: true },
      include: {
        catalogTools: {
          select: {
            id: true,
            name: true,
            slug: true,
            riskLevel: true,
            tenantTools: {
              where: { tenantId: req.tenantId! },
              select: { id: true, isEnabled: true },
            },
          },
          orderBy: { name: "asc" },
        },
        tenantConnections: {
          where: { tenantId: req.tenantId! },
          select: { id: true, status: true, createdAt: true },
        },
      },
      orderBy: { sortOrder: "asc" },
    });

    const data = catalog.map((entry) => ({
      ...entry,
      catalogTools: entry.catalogTools.map((ct: any) => ({
        ...ct,
        tenantTool: ct.tenantTools?.[0] || null,
        tenantTools: undefined,
      })),
      authType: entry.authType,
      authSchema: entry.authSchema,
      tenantConnection: entry.tenantConnections[0] || null,
      tenantConnections: undefined,
    }));

    res.json({ data });
  } catch (err) {
    console.error("List catalog integrations error:", err);
    res.status(500).json({ error: "Failed to list integrations" });
  }
});

// GET /:slug — Get single catalog integration with connection status + tools
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({
      where: { slug },
      include: {
        catalogTools: { orderBy: { name: "asc" } },
        tenantConnections: {
          where: { tenantId: req.tenantId! },
          select: { id: true, status: true, credentials: true, createdAt: true, updatedAt: true },
        },
      },
    });

    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantConnection = entry.tenantConnections[0] || null;

    res.json({
      data: {
        ...entry,
        authType: entry.authType,
        authSchema: entry.authSchema,
        catalogTools: entry.catalogTools,
        tenantConnection,
        tenantConnections: undefined,
      },
    });
  } catch (err) {
    console.error("Get catalog integration error:", err);
    res.status(500).json({ error: "Failed to get integration" });
  }
});

// POST /:slug/connect — Connect tenant to integration
router.post("/:slug/connect", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { credentials } = req.body;

    const entry = await prisma.integrationCatalog.findUnique({
      where: { slug },
      include: { catalogTools: { where: { isDefault: true } } },
    });

    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    // Check for existing connection
    const existing = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (existing) {
      res.status(409).json({ error: "Already connected to this integration" });
      return;
    }

    // Determine initial status and stored credentials based on auth type
    let storedCredentials: Record<string, unknown> = {};
    let initialStatus = "PENDING";

    if (entry.authType === "OAUTH2") {
      // For OAuth2, accept oauth_code if provided, otherwise stay PENDING
      if (credentials?.oauth_code) {
        storedCredentials = { oauth_code: credentials.oauth_code };
      }
      initialStatus = "PENDING";
    } else if (entry.authType === "API_KEY" || entry.authType === "BASIC_AUTH") {
      // Store provided credential fields as-is
      storedCredentials = credentials && typeof credentials === "object" ? credentials : {};
      initialStatus = "PENDING";
    } else {
      storedCredentials = credentials && typeof credentials === "object" ? credentials : {};
    }

    // Create TenantIntegration and auto-create TenantTool rows for all default catalog tools
    const tenantIntegration = await prisma.tenantIntegration.create({
      data: {
        tenantId: req.tenantId!,
        integrationId: entry.id,
        status: initialStatus,
        credentials: storedCredentials,
        tenantTools: {
          create: entry.catalogTools.map((tool) => ({
            tenantId: req.tenantId!,
            catalogToolId: tool.id,
            isEnabled: true,
          })),
        },
      },
    });

    res.status(201).json({ data: tenantIntegration });
  } catch (err) {
    console.error("Connect integration error:", err);
    res.status(500).json({ error: "Failed to connect integration" });
  }
});

// POST /:slug/test — Test connection by validating required credential fields from authSchema
router.post("/:slug/test", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    // Validate required credential fields from authSchema
    const authSchema = (entry.authSchema as Record<string, unknown>) || {};
    const requiredFields: string[] = Array.isArray(authSchema.required)
      ? (authSchema.required as string[])
      : [];
    const storedCredentials = (tenantIntegration.credentials as Record<string, unknown>) || {};

    const missingFields = requiredFields.filter(
      (field) => !storedCredentials[field] || storedCredentials[field] === ""
    );

    if (missingFields.length > 0) {
      // Update lastTestedAt and lastTestResult as failed
      await prisma.tenantIntegration.update({
        where: { id: tenantIntegration.id },
        data: {
          lastTestedAt: new Date(),
          lastTestResult: false,
        },
      });
      res.status(400).json({
        error: "Missing required credential fields",
        missingFields,
      });
      return;
    }

    // All required fields present — mark as CONNECTED
    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: {
        status: "CONNECTED",
        lastTestedAt: new Date(),
        lastTestResult: true,
      },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Test integration error:", err);
    res.status(500).json({ error: "Failed to test integration" });
  }
});

// POST /:slug/disconnect — Disconnect and delete tenant tools (cascade handles child rows)
router.post("/:slug/disconnect", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    // Explicitly delete tenant tools (cascade on TenantIntegration deletion handles this,
    // but we delete them explicitly to be safe when only updating status)
    await prisma.tenantTool.deleteMany({
      where: { tenantIntegrationId: tenantIntegration.id },
    });

    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: { status: "DISCONNECTED", credentials: {} },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Disconnect integration error:", err);
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

// PUT /:slug/credentials — Update credentials
router.put("/:slug/credentials", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { credentials } = req.body;

    if (!credentials) {
      res.status(400).json({ error: "credentials are required" });
      return;
    }

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: { credentials },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update credentials error:", err);
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

// GET /:slug/tools — List catalog tools with tenant activation status
router.get("/:slug/tools", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    const catalogTools = await prisma.catalogTool.findMany({
      where: { integrationId: entry.id },
      include: tenantIntegration
        ? {
            tenantTools: {
              where: { tenantId: req.tenantId!, tenantIntegrationId: tenantIntegration.id },
              select: { id: true, isEnabled: true },
            },
          }
        : undefined,
      orderBy: { name: "asc" },
    });

    const data = catalogTools.map((tool) => ({
      ...tool,
      tenantTool: (tool as any).tenantTools?.[0] || null,
      tenantTools: undefined,
    }));

    res.json({ data });
  } catch (err) {
    console.error("List integration tools error:", err);
    res.status(500).json({ error: "Failed to list tools" });
  }
});

// PUT /:slug/tools/:toolSlug — Toggle tool enabled/disabled for tenant
router.put("/:slug/tools/:toolSlug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const toolSlug = req.params.toolSlug as string;
    const { isEnabled } = req.body;

    if (typeof isEnabled !== "boolean") {
      res.status(400).json({ error: "isEnabled (boolean) is required" });
      return;
    }

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    const catalogTool = await prisma.catalogTool.findFirst({
      where: { integrationId: entry.id, slug: toolSlug },
    });

    if (!catalogTool) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }

    const tenantTool = await prisma.tenantTool.upsert({
      where: {
        tenantIntegrationId_catalogToolId: {
          tenantIntegrationId: tenantIntegration.id,
          catalogToolId: catalogTool.id,
        },
      },
      create: {
        tenantId: req.tenantId!,
        tenantIntegrationId: tenantIntegration.id,
        catalogToolId: catalogTool.id,
        isEnabled,
      },
      update: { isEnabled },
    });

    res.json({ data: tenantTool });
  } catch (err) {
    console.error("Toggle tool error:", err);
    res.status(500).json({ error: "Failed to update tool" });
  }
});

export default router;
