import { prisma, encryptCredentials, decryptCredentials, isEncrypted } from "@chatcenter/shared";
import { upsertSyncedDocument } from "./embedding.service";

export interface ConfluenceCredentials {
  accessToken: string;
  refreshToken: string;
  cloudId: string;
  expiresAt?: number;
}

interface ConfluenceIntegration {
  id: string;
  /**
   * Encrypted (the current format, via encryptCredentials - the same as Drive)
   * or a plain object (rows written before Confluence tokens were encrypted).
   * Read it ONLY through readConfluenceCredentials.
   */
  credentials: string | ConfluenceCredentials;
  knowledgeBaseId: string;
  tenantId: string;
}

/**
 * Read Confluence credentials in either format. Legacy plain rows keep working
 * and are re-written encrypted on their next token refresh, so the estate
 * converges without a migration and without a reconnect - the same rule as
 * readDriveCredentials.
 */
export function readConfluenceCredentials(raw: unknown): ConfluenceCredentials {
  if (typeof raw === "string") {
    if (!isEncrypted(raw)) throw new Error("Stored Confluence credentials are unreadable");
    return decryptCredentials(raw) as ConfluenceCredentials;
  }
  return (raw || {}) as ConfluenceCredentials;
}

export function writeConfluenceCredentials(credentials: ConfluenceCredentials): string {
  return encryptCredentials(credentials as any);
}

interface ConfluenceSpace {
  key: string;
  name: string;
}

interface ConfluencePage {
  id: string;
  title: string;
}

async function confluenceFetch(integration: ConfluenceIntegration, path: string): Promise<any> {
  const { accessToken, cloudId } = readConfluenceCredentials(integration.credentials);
  const baseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}`;

  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    // Try refreshing the token
    const refreshed = await refreshConfluenceToken(integration);
    if (refreshed) {
      const retryRes = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${refreshed}`,
          Accept: "application/json",
        },
      });
      if (!retryRes.ok) throw new Error(`Confluence API error: ${retryRes.status}`);
      return retryRes.json();
    }
    throw new Error("Failed to refresh Confluence token");
  }

  if (!res.ok) throw new Error(`Confluence API error: ${res.status}`);
  return res.json();
}

async function refreshConfluenceToken(integration: ConfluenceIntegration): Promise<string | null> {
  const clientId = process.env.CONFLUENCE_CLIENT_ID;
  const clientSecret = process.env.CONFLUENCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const current = readConfluenceCredentials(integration.credentials);

  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refreshToken,
    }),
  });

  if (!res.ok) return null;

  const data: any = await res.json();
  const newCredentials: ConfluenceCredentials = {
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  // Always written encrypted - this is also what converts a legacy plain row.
  const stored = writeConfluenceCredentials(newCredentials);

  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: { credentials: stored as any },
  });

  integration.credentials = stored;
  return data.access_token;
}

export async function listSpaces(integration: ConfluenceIntegration): Promise<ConfluenceSpace[]> {
  const data: any = await confluenceFetch(integration, "/wiki/api/v2/spaces?limit=100");
  return (data.results || []).map((s: any) => ({ key: s.key, name: s.name }));
}

export async function listPages(
  integration: ConfluenceIntegration,
  spaceKey: string,
  parentId?: string
): Promise<ConfluencePage[]> {
  let path: string;
  if (parentId) {
    // List child pages of a specific page
    path = `/wiki/api/v2/pages/${parentId}/children?limit=100`;
  } else {
    // List top-level pages in the space
    path = `/wiki/api/v2/spaces/${spaceKey}/pages?limit=100&depth=root&body-format=storage`;
  }

  const data = await confluenceFetch(integration, path);
  return (data.results || []).map((p: any) => ({ id: p.id, title: p.title }));
}

export async function fetchPageContent(
  integration: ConfluenceIntegration,
  pageId: string
): Promise<{ content: string; version: number }> {
  const data = await confluenceFetch(
    integration,
    `/wiki/api/v2/pages/${pageId}?body-format=storage`
  );

  const html = data.body?.storage?.value || "";
  // Strip HTML tags to get plain text
  const content = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  // Confluence bumps version.number on every edit - our change marker.
  return { content, version: Number(data.version?.number || 0) };
}

export async function syncSpace(
  integration: ConfluenceIntegration,
  spaceKey: string
): Promise<{ imported: number; updated: number; skipped: number }> {
  const pages = await listPages(integration, spaceKey);
  let imported = 0, updated = 0, skipped = 0;

  for (const page of pages) {
    try {
      const { content, version } = await fetchPageContent(integration, page.id);
      if (!content) continue;

      const outcome = await upsertSyncedDocument({
        knowledgeBaseId: integration.knowledgeBaseId,
        tenantId: integration.tenantId,
        title: page.title,
        content,
        sourceType: "confluence",
        sourceUrl: `https://api.atlassian.com/ex/confluence/${readConfluenceCredentials(integration.credentials).cloudId}/wiki/spaces/${spaceKey}/pages/${page.id}`,
        changeKey: String(version),
        metadata: { integrationId: integration.id, confluencePageId: page.id, spaceKey },
      });
      if (outcome === "created") imported++;
      else if (outcome === "updated") updated++;
      else skipped++;
    } catch (err: any) {
      console.error(`[Confluence] Failed to import page ${page.title}:`, err.message);
    }
  }

  // Update last sync time
  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...(integration as any).config,
        lastSyncAt: new Date().toISOString(),
      },
    },
  });

  return { imported, updated, skipped };
}
