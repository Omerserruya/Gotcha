import type { McpServer } from '@/api/contracts/agent-tools';

export type OwnToolsView =
  | { readonly kind: 'intro' }
  | { readonly kind: 'server'; readonly server: McpServer }
  | { readonly kind: 'custom' }
  /** The servers could not be read: never "not found" over a failed read. */
  | { readonly kind: 'unread' }
  | { readonly kind: 'notFound' };

/**
 * Which of the business's own tools `?system=` names, or `null` for the
 * catalogue's systems:
 *
 *   mcp           connect an MCP server
 *   mcp:<id>      that server
 *   custom_api    the custom API tools
 */
export function ownToolsView(
  system: string | undefined,
  servers: readonly McpServer[] | null,
): OwnToolsView | null {
  if (system === 'mcp') return { kind: 'intro' };
  if (system === 'custom_api') return { kind: 'custom' };
  if (system?.startsWith('mcp:')) {
    if (servers === null) return { kind: 'unread' };
    const id = system.slice('mcp:'.length);
    const server = servers.find((entry) => entry.id === id);
    return server ? { kind: 'server', server } : { kind: 'notFound' };
  }
  return null;
}
