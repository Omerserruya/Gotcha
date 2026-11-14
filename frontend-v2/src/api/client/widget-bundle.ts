/**
 * The website widget's chat bundle, by the name its manifest gives it - for
 * the settings preview, which boots the same file the site loads.
 *
 * Not the platform API: the gateway serves the widget's own files at
 * `/widget/` (nginx, from frontend/public/widget). The names are content-
 * hashed, so the manifest is read fresh; a hard-coded name is how a stale
 * widget was served once. `null`: unreadable, or a name that is not a plain
 * file name (it is put in a URL).
 */
export const WIDGET_BASE = '/widget';

export async function readWidgetBundle(): Promise<string | null> {
  try {
    const response = await fetch(`${WIDGET_BASE}/widget-manifest.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    const manifest = (await response.json()) as { chat?: unknown };
    const chat = typeof manifest.chat === 'string' ? manifest.chat : '';
    return /^[\w.-]+\.js$/.test(chat) ? chat : null;
  } catch {
    return null;
  }
}
