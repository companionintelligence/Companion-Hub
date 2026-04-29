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

/** Create a ReadableStream that emits SSE data with the endpoint event */
function createSseStream(messagesUrl: string) {
  const data = `event: endpoint\ndata: ${messagesUrl}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      // Don't close — SSE streams stay open
    },
  });
}

/** Build a mock fetch that handles SSE connect + JSON-RPC messages */
function mockSseThenJsonRpc(messagesUrl: string, jsonRpcResult: unknown) {
  return vi.fn().mockImplementation(async (url: string, _opts?: RequestInit) => {
    if (url.includes('/api/mcp/sse')) {
      return { ok: true, body: createSseStream(messagesUrl) };
    }
    // JSON-RPC POST
    return { ok: true, json: async () => jsonRpcResult };
  });
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

  it('should connect via SSE then initialize successfully', async () => {
    vi.stubGlobal(
      'fetch',
      mockSseThenJsonRpc('http://localhost:5002/api/mcp/messages', {
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'ci-hub' } },
      }),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Discovered MCP messages endpoint'));
    expect(log.info).toHaveBeenCalledWith('MCP client connected to Hub');
  });

  it('should first connect to SSE endpoint, then POST to messages URL', async () => {
    const mockFetch = mockSseThenJsonRpc('http://localhost:5002/api/mcp/messages', {
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.connect();

    // First call: SSE endpoint
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5002/api/mcp/sse');
    // Second call: messages endpoint with initialize
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:5002/api/mcp/messages');
  });

  it('should send Authorization header with API key', async () => {
    const mockFetch = mockSseThenJsonRpc('http://localhost:5002/api/mcp/messages', {
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.connect();

    // SSE call should have auth
    expect(mockFetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    // Messages call should have auth
    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
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
    let callCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/mcp/sse')) {
          return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
        }
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
        }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 2, result: { tools: mockTools } }) };
      }),
    );

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
    let callCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/mcp/sse')) {
          return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
        }
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }) };
        }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 2, result: toolResult }) };
      }),
    );

    await client.connect();
    const result = await client.callTool('hub_list_apps', {});
    expect(result).toEqual(toolResult);
  });

  it('should strip trailing slash from hubUrl', async () => {
    const c = new McpClient('http://localhost:5002/', 'key', log);
    const mockFetch = mockSseThenJsonRpc('http://localhost:5002/api/mcp/messages', {
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
    vi.stubGlobal('fetch', mockFetch);

    await c.connect();

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5002/api/mcp/sse');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:5002/api/mcp/messages');
  });

  it('should disconnect and set connected to false', async () => {
    vi.stubGlobal(
      'fetch',
      mockSseThenJsonRpc('http://localhost:5002/api/mcp/messages', {
        jsonrpc: '2.0',
        id: 1,
        result: {},
      }),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});
