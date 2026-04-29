import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { McpClient } from '../src/mcp-client';

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('McpClient', () => {
  let client: McpClient;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(() => {
    log = createMockLog();
    client = new McpClient('http://localhost:5002', 'test-key', log);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start disconnected', () => {
    expect(client.isConnected()).toBe(false);
  });

  it('should connect successfully with valid MCP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'ci-hub' } } }),
      }),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(log.info).toHaveBeenCalledWith('MCP client connected to Hub');
  });

  it('should send Authorization header with API key', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.connect();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5002/api/mcp/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('should handle connection failure and schedule reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await client.connect();

    expect(client.isConnected()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('MCP connection failed'));
  });

  it('should list tools when connected', async () => {
    const mockTools = [{ name: 'test_tool', description: 'Test', inputSchema: {} }];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: mockTools } }),
      }),
    );

    // Manually set connected
    await client.connect();
    const tools = await client.listTools();

    expect(tools).toEqual(mockTools);
  });

  it('should throw when listing tools while disconnected', async () => {
    await expect(client.listTools()).rejects.toThrow('Hub MCP server is not connected');
  });

  it('should return error when calling tool while disconnected', async () => {
    const result = await client.callTool('test', {});
    expect(result).toEqual({ error: 'Hub MCP server is not connected' });
  });

  it('should call tool and return result when connected', async () => {
    const toolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: toolResult }),
      }),
    );

    await client.connect();
    const result = await client.callTool('hub_list_apps', {});
    expect(result).toEqual(toolResult);
  });

  it('should strip trailing slash from hubUrl', async () => {
    const c = new McpClient('http://localhost:5002/', 'key', log);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await c.connect();

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5002/api/mcp/messages', expect.anything());
  });

  it('should disconnect and set connected to false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      }),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});
