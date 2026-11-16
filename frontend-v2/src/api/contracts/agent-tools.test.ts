import { describe, expect, it } from 'vitest';

import {
  customApiRisk,
  customApiToolSchema,
  editNeedsApproval,
  firstLevelFor,
  isSendableUrl,
  levelsFor,
  mcpFailureOf,
  mcpServerSchema,
  toSlug,
} from './agent-tools';

describe('★★ a new value from the server never rejects the read', () => {
  it('an unnamed server status, tool risk or level reads UNKNOWN, the rest still parses', () => {
    const parsed = mcpServerSchema.parse({
      id: 's',
      name: 'n',
      url: 'https://a.example/mcp',
      status: 'QUARANTINED',
      tools: [{ name: 't', risk: 'catastrophic', level: 'sometimes' }],
    });
    expect(parsed.status).toBe('UNKNOWN');
    expect(parsed.tools[0]).toMatchObject({ risk: 'UNKNOWN', level: 'UNKNOWN', isNew: false, gone: false });
    expect(parsed.auth).toEqual({ kind: 'none', headerName: null });
  });

  it('★ Backend’s names read too: effect, lastError, changedSinceLastDiscovery', () => {
    const parsed = mcpServerSchema.parse({
      id: 's',
      name: 'n',
      url: 'https://a.example/mcp',
      status: 'FAILED',
      lastError: 'protocol',
      tools: [
        { name: 'a', effect: 'money', changedSinceLastDiscovery: 'added' },
        { name: 'b', effect: 'read', changedSinceLastDiscovery: 'removed' },
      ],
    });
    expect(mcpFailureOf(parsed.lastErrorCode)).toBe('protocol');
    expect(mcpServerSchema.parse({ id: 's', name: 'n', url: 'u', auth: { kind: 'bearer', hasSecret: true } }).hasSecret).toBe(true);
    expect(parsed.tools.map((t) => [t.risk, t.isNew, t.gone])).toEqual([
      ['money', true, false],
      ['read', false, true],
    ]);
  });

  it('a custom API tool as the existing route answers it parses, secrets never present', () => {
    const tool = customApiToolSchema.parse({
      id: 'c',
      slug: 's',
      name: 'n',
      method: 'post',
      urlTemplate: 'https://a.example/x',
      category: 'WRITE',
      hasSecrets: true,
      secrets: 'ciphertext',
    });
    expect(tool.method).toBe('GET'); // lowercase is not a method the route stores
    expect('secrets' in tool).toBe(false);
  });
});

describe('★★ the four risks decide what may run on its own', () => {
  it.each([
    ['read', ['execute', 'ask', 'never'], 'execute'],
    ['change', ['execute', 'ask', 'never'], 'ask'],
    ['irreversible', ['ask', 'never'], 'ask'],
    ['money', ['ask', 'never'], 'ask'],
    ['UNKNOWN', ['ask', 'never'], 'ask'],
  ] as const)('%s offers %j and is first turned on as %s', (risk, levels, first) => {
    expect(levelsFor(risk)).toEqual(levels);
    expect(firstLevelFor(risk)).toBe(first);
  });
});

describe('★★ an edit that goes back to GOTCHA', () => {
  const stored = { url: 'https://a.example/mcp', auth: { kind: 'header' as const, headerName: 'X-Key' } };
  const same = { url: 'https://a.example/mcp', authKind: 'header' as const, headerName: 'X-Key', secret: '' };

  it('a new name alone does not (nothing here carries the name)', () => {
    expect(editNeedsApproval(stored, same)).toBe(false);
    expect(editNeedsApproval(stored, { ...same, url: ' https://a.example/mcp ' })).toBe(false);
  });

  it.each([
    ['a new address', { url: 'https://b.example/mcp' }],
    ['a new auth kind', { authKind: 'bearer' as const }],
    ['a new header name', { headerName: 'X-Other' }],
    ['a new secret', { secret: 's3cret' }],
  ])('%s does', (_, change) => {
    expect(editNeedsApproval(stored, { ...same, ...change })).toBe(true);
  });
});

describe('the address the form may send', () => {
  it.each([
    ['https://mcp.example.com/mcp', true],
    ['http://mcp.example.com/mcp', false],
    ['https://user:pw@mcp.example.com/', false],
    ['mcp.example.com', false],
    ['', false],
  ])('%s → %s', (url, ok) => {
    expect(isSendableUrl(url)).toBe(ok);
  });
});

describe('a custom API tool in the four words', () => {
  it.each([
    [{ category: 'READ', method: 'GET', riskLevel: 'LOW' }, 'read'],
    [{ category: 'READ', method: 'POST', riskLevel: 'MEDIUM' }, 'read'],
    [{ category: 'READ', method: 'GET', riskLevel: 'HIGH' }, 'change'],
    [{ category: 'WRITE', method: 'POST', riskLevel: 'MEDIUM' }, 'change'],
    [{ category: 'WRITE', method: 'POST', riskLevel: 'HIGH' }, 'irreversible'],
    [{ category: 'ACTION', method: 'POST', riskLevel: 'LOW' }, 'change'],
    [{ category: 'DELETE', method: 'POST', riskLevel: 'LOW' }, 'irreversible'],
    [{ category: 'WRITE', method: 'DELETE', riskLevel: 'LOW' }, 'irreversible'],
    [{ category: 'UNKNOWN', method: 'GET', riskLevel: 'LOW' }, 'UNKNOWN'],
  ] as const)('%j → %s', (tool, risk) => {
    expect(customApiRisk(tool)).toBe(risk);
  });
});

describe('codes and slugs', () => {
  it('a failure code this build names is its own sentence; anything else is generic', () => {
    expect(mcpFailureOf('tls')).toBe('tls');
    expect(mcpFailureOf('weird')).toBe('unknown');
    expect(mcpFailureOf(null)).toBe('unknown');
  });

  it('a slug keeps only what the route keeps', () => {
    expect(toSlug('Look up Order #42!')).toBe('look_up_order_42');
    expect(toSlug('הזמנה')).toBe('');
  });
});

describe('★ an absent field degrades like an unknown one', () => {
  it('a tool with no risk or level, and a custom tool with no riskLevel, still parse', () => {
    expect(mcpServerSchema.parse({ id: 's', name: 'n', url: 'u', tools: [{ name: 't' }] }).tools[0]).toMatchObject({
      risk: 'UNKNOWN',
      level: 'UNKNOWN',
    });
    expect(mcpServerSchema.parse({ id: 's', name: 'n', url: 'u' }).status).toBe('UNKNOWN');
    expect(
      customApiToolSchema.parse({ id: 'c', slug: 's', name: 'n', urlTemplate: 'https://a.example' }).riskLevel,
    ).toBe('UNKNOWN');
  });
});
