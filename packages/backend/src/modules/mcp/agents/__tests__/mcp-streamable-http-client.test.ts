import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpStreamableHttpClient } from '../mcp-streamable-http-client.js';

const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockClientConstructor = vi.fn();

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    constructor(...args: unknown[]) {
      mockClientConstructor(...args);
    }
    connect = mockConnect;
    close = mockClose;
    listTools = mockListTools;
    callTool = mockCallTool;
  },
  StreamableHTTPClientTransport: class {
    sessionId = 'test-session';
    close = vi.fn();
  },
}));

describe('McpStreamableHttpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({
      tools: [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object' } }],
    });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it('connects and lists tools via the SDK client', async () => {
    const client = new McpStreamableHttpClient();
    await client.connect({ url: 'http://context7:8080/mcp', headers: { Authorization: 'Bearer tok' } });

    expect(client.connected).toBe(true);
    expect(client.sessionId).toBe('test-session');

    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'search', description: 'Search docs', inputSchema: { type: 'object' } }]);
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('uses v2 auto version negotiation when connecting', async () => {
    const client = new McpStreamableHttpClient();
    await client.connect({ url: 'http://context7:8080/mcp' });
    expect(mockClientConstructor).toHaveBeenCalledWith({ name: 'ci-hub-mcp-bridge', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  });

  it('forwards tool calls through the SDK client', async () => {
    const client = new McpStreamableHttpClient();
    await client.connect({ url: 'http://context7:8080/mcp' });

    const result = await client.callTool('search', { q: 'mcp' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'mcp' } });
  });
});
