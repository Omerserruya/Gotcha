import { prisma } from "@chatcenter/shared";
import { processDocument } from "./embedding.service";

interface ConfluenceIntegration {
  id: string;
  credentials: {
    accessToken: string;
    refreshToken: string;
    cloudId: string;
    expiresAt?: number;
  };
  knowledgeBaseId: string;
  tenantId: string;
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
  const { accessToken, cloudId } = integration.credentials;
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

  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: integration.credentials.refreshToken,
    }),
  });

  if (!res.ok) return null;

  const data: any = await res.json();
  const newCredentials = {
    ...integration.credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || integration.credentials.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: { credentials: newCredentials as any },
  });

  integration.credentials = newCredentials;
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

export async function fetchPageContent(integration: ConfluenceIntegration, pageId: string): Promise<string> {
  const data = await confluenceFetch(
    integration,
    `/wiki/api/v2/pages/${pageId}?body-format=storage`
  );

  const html = data.body?.storage?.value || "";
  // Strip HTML tags to get plain text
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function syncSpace(
  integration: ConfluenceIntegration,
  spaceKey: string
): Promise<{ imported: number }> {
  const pages = await listPages(integration, spaceKey);
  let imported = 0;

  for (const page of pages) {
    try {
      const content = await fetchPageContent(integration, page.id);
      if (!content) continue;

      const doc = await prisma.knowledgeDocument.create({
        data: {
          knowledgeBaseId: integration.knowledgeBaseId,
          tenantId: integration.tenantId,
          title: page.title,
          content,
          sourceType: "confluence",
          sourceUrl: `https://api.atlassian.com/ex/confluence/${integration.credentials.cloudId}/wiki/spaces/${spaceKey}/pages/${page.id}`,
          status: "pending",
          metadata: {
            integrationId: integration.id,
            confluencePageId: page.id,
            spaceKey,
          },
        },
      });

      processDocument(doc.id).catch((err) => {
        console.error(`[Confluence] Failed to process page ${page.id}:`, err.message);
      });
      imported++;
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

  return { imported };
}
