import { describe, expect, it } from 'vitest';
import { appInfoSchema, marketplaceMcpSchema } from '../app-info.js';

/**
 * #936: the Hub must ingest CI-Marketplace's top-level `mcp` listing block so MCP
 * server apps are recognized by the agent bridge and the app page. Shapes below are
 * taken from real marketplace listings (fetch-mcp, miro-mcp).
 */
describe('marketplace mcp block on appInfoSchema', () => {
  const baseInfo = {
    id: 'fetch-mcp',
    urn: 'fetch-mcp:ci-marketplace',
    available: true,
    name: 'Fetch MCP',
    short_desc: 'Fetch a URL and return Markdown',
    author: 'modelcontextprotocol',
    source: 'https://github.com/modelcontextprotocol/servers',
    categories: ['mcp'],
  };

  it('parses a stdio listing (fetch-mcp shape)', () => {
    const parsed = appInfoSchema.parse({
      ...baseInfo,
      mcp: {
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch==2026.6.4'],
        env: [{ key: 'USER_AGENT', label: 'Custom User-Agent', required: false, secret: false }],
        requires: { host_software: ['uv (pip install uv)'], notes: 'Pair with playwright-mcp when JS rendering is needed.' },
        tags: ['fetch', 'http', 'official'],
        manifest: {
          $schema: 'https://schemas.companionintelligence.com/v1/mcp-manifest.json',
          tools: [{ name: 'fetch', description: 'Fetch a URL and return Markdown.' }],
          resources: [],
          prompts: [],
        },
      },
    });

    expect(parsed.mcp?.transport).toBe('stdio');
    expect(parsed.mcp?.command).toBe('uvx');
    expect(parsed.mcp?.args).toEqual(['mcp-server-fetch==2026.6.4']);
    expect(parsed.mcp?.manifest?.tools).toHaveLength(1);
  });

  it('parses an http listing with empty command (miro-mcp shape)', () => {
    const parsed = appInfoSchema.parse({
      ...baseInfo,
      mcp: {
        transport: 'http',
        command: '',
        args: [],
        env: [{ key: 'MIRO_ACCESS_TOKEN', label: 'Miro access token', required: true, secret: true }],
        manifest: { tools: [{ name: 'list_boards', description: 'List accessible Miro boards.' }] },
      },
    });

    expect(parsed.mcp?.transport).toBe('http');
    expect(parsed.mcp?.command).toBe('');
  });

  it('tolerates unknown fields anywhere in the block (marketplace owns the contract)', () => {
    const parsed = marketplaceMcpSchema.parse({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-server'],
      future_field: { anything: true },
      manifest: { tools: [{ name: 't', extra: 1 }], sampling: [] },
    });
    expect(parsed.transport).toBe('stdio');
  });

  it('still parses apps without an mcp block', () => {
    const parsed = appInfoSchema.parse(baseInfo);
    expect(parsed.mcp).toBeUndefined();
  });

  it('rejects an unknown transport', () => {
    expect(() => appInfoSchema.parse({ ...baseInfo, mcp: { transport: 'websocket' } })).toThrow();
  });
});
