import { describe, expect, it } from 'vitest';

import { server } from './fixtures';
import { ownToolsView } from './own-tools-view';

describe('which own-tools view ?system= names', () => {
  const servers = [server()];

  it('the catalogue keeps everything else', () => {
    expect(ownToolsView(undefined, servers)).toBeNull();
    expect(ownToolsView('hubspot', servers)).toBeNull();
    expect(ownToolsView('builtin', servers)).toBeNull();
  });

  it('mcp, custom_api and a server by id', () => {
    expect(ownToolsView('mcp', servers)).toEqual({ kind: 'intro' });
    expect(ownToolsView('custom_api', null)).toEqual({ kind: 'custom' });
    expect(ownToolsView('mcp:srv_1', servers)).toEqual({ kind: 'server', server: servers[0] });
    expect(ownToolsView('mcp:gone', servers)).toEqual({ kind: 'notFound' });
  });

  it('★ a failed read is never "not found"', () => {
    expect(ownToolsView('mcp:srv_1', null)).toEqual({ kind: 'unread' });
  });
});
