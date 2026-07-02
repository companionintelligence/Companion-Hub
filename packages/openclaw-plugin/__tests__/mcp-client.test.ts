import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../src/mcp-client';

function createMockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Build a Streamable HTTP-style response with a headers.get() + text() surface. */
function mcpResponse(body: unknown, opts: { status?: number; sessionId?: string; contentType?: string } = {}) {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>([['content-type', opts.contentType ?? 'application/json']]);
  if (opts.sessionId) headers.set('mcp-session-id', opts.sessionId);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  };
}

/** Mock fetch for the single /api/mcp endpoint: route by JSON-RPC method; initialize issues a session. */
function mockHub(results: Record<string, unknown>, sessionId = 'sess-1') {
  return vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
    const method = opts?.body ? (JSON.parse(opts.body as string) as { method: string }).method : 'DELETE';
    const result = results[method] ?? {};
    return mcpResponse({ jsonrpc: '2.0', id: 1, result }, { sessionId: method === 'initialize' ? sessionId : undefined });
  });
}

describe('McpClient (Streamable HTTP)', () => {
  let client: McpClient;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(() => {
    log = createMockLog();
    client = new McpClient('http://localhost:5002', 'test-key', log);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start disconnected', () => {
    expect(client.isConnected()).toBe(false);
  });

  it('connects by initializing and capturing the session id', async () => {
    vi.stubGlobal('fetch', mockHub({ initialize: { serverInfo: { name: 'ci-hub' } } }));
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(log.info).toHaveBeenCalledWith('MCP client connected to Hub');
  });

  it('POSTs initialize to the single /api/mcp endpoint', async () => {
    const mockFetch = mockHub({ initialize: { serverInfo: {} } });
    vi.stubGlobal('fetch', mockFetch);
    await client.connect();
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5002/api/mcp');
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('sends the Authorization bearer + Accept headers', async () => {
    const mockFetch = mockHub({ initialize: { serverInfo: {} } });
    vi.stubGlobal('fetch', mockFetch);
    await client.connect();
    expect(mockFetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          Accept: expect.stringContaining('text/event-stream'),
        }),
      }),
    );
  });

  it('fails to connect (and schedules a reconnect) if initialize returns no session id', async () => {
    vi.useFakeTimers();
    // initialize responds but WITHOUT a session id header → not connected.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } })));
    await client.connect();
    expect(client.isConnected()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('MCP connection failed'));
  });

  it('handles a transport failure and schedules a reconnect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await client.connect();
    expect(client.isConnected()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('MCP connection failed'));
  });

  it('fires the scheduled reconnect after the backoff delay when not disconnected', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await client.connect(); // fails → schedules a reconnect at 1000ms
    const afterFirst = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1100);
    // The reconnect timer fired and attempted another connect (another initialize POST).
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('disconnect() cancels a pending reconnect so the client is not revived', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await client.connect(); // fails → schedules a reconnect
    const afterFirst = fetchMock.mock.calls.length;
    await client.disconnect(); // sessionId is null (never connected) → no fetch; must cancel the timer
    await vi.advanceTimersByTimeAsync(65_000); // past maxBackoff
    // No reconnect attempt fired: the fetch count is unchanged after disconnect.
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    expect(client.isConnected()).toBe(false);
  });

  it('lists tools when connected', async () => {
    const tools = [{ name: 'hub_system_load', description: 'load', inputSchema: {} }];
    vi.stubGlobal('fetch', mockHub({ initialize: { serverInfo: {} }, 'tools/list': { tools } }));
    await client.connect();
    expect(await client.listTools()).toEqual(tools);
  });

  it('throws when listing tools while disconnected', async () => {
    await expect(client.listTools()).rejects.toThrow('Hub MCP server is not connected');
  });

  it('returns an error object when calling a tool while disconnected', async () => {
    expect(await client.callTool('test', {})).toEqual({ error: 'Hub MCP server is not connected' });
  });

  it('calls a tool and returns its result when connected', async () => {
    const toolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
    vi.stubGlobal('fetch', mockHub({ initialize: { serverInfo: {} }, 'tools/call': toolResult }));
    await client.connect();
    expect(await client.callTool('hub_list_installed_apps', {})).toEqual(toolResult);
  });

  it('surfaces the real error and stays connected when a tool call hits a live-server fault (5xx)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
        const method = (JSON.parse(opts?.body as string) as { method: string }).method;
        if (method === 'initialize') return mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, { sessionId: 's1' });
        return mcpResponse({ error: 'server exploded' }, { status: 500 }); // tools/call → hard 5xx
      }),
    );
    await client.connect();
    expect(client.isConnected()).toBe(true);

    const res = (await client.callTool('x', {})) as { error?: string };
    // The REAL cause is surfaced (not a misleading "not connected"), and the live session is NOT torn down.
    expect(res.error).toContain('500');
    expect(res.error).not.toContain('not connected');
    expect(client.isConnected()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("tool call 'x' failed"));
  });

  it('marks the client disconnected and arms a reconnect when a tool call hits a dead Hub', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      const method = (JSON.parse(opts?.body as string) as { method: string }).method;
      if (method === 'initialize') return mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, { sessionId: 's1' });
      throw new Error('ECONNREFUSED'); // Hub died after the session was established
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.connect();
    expect(client.isConnected()).toBe(true);

    const res = (await client.callTool('x', {})) as { error?: string };
    // A transport-dead Hub (fetch reject) must flip connected and enter the backoff loop — unlike a
    // live-server 5xx. The real cause is still surfaced.
    expect(res.error).toContain('ECONNREFUSED');
    expect(client.isConnected()).toBe(false);
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before); // reconnect attempted
  });

  it('times out a response body that never arrives (half-open connection)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      const method = (JSON.parse(opts?.body as string) as { method: string }).method;
      if (method === 'initialize') return mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, { sessionId: 's1' });
      // Headers arrive but the body stream stalls forever; reject only when the request signal aborts.
      const signal = opts?.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: () =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError'))),
          ),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.connect();

    const pending = client.callTool('x', {}) as Promise<{ error?: string }>;
    await vi.advanceTimersByTimeAsync(15_100); // trip REQUEST_TIMEOUT_MS mid-body-read
    const res = await pending;
    // The timeout covers the body read (not just headers) and reports a descriptive message.
    expect(res.error).toContain('timed out');
    expect(client.isConnected()).toBe(false);
  });

  it('does not revive after disconnect() races an in-flight connect', async () => {
    let resolveInit!: (r: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveInit = resolve;
    });
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
        const method = opts?.body ? (JSON.parse(opts.body as string) as { method: string }).method : (opts?.method ?? 'GET');
        methods.push(method);
        if (method === 'initialize') return deferred;
        return mcpResponse({ jsonrpc: '2.0', id: 1, result: {} });
      }),
    );

    const connecting = client.connect(); // initialize in flight
    await client.disconnect(); // teardown while awaiting (sessionId still null → no DELETE yet)
    resolveInit(mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, { sessionId: 's1' }));
    await connecting;

    // The client must NOT revive, and the freshly-minted session must be torn down best-effort.
    expect(client.isConnected()).toBe(false);
    expect(methods).toContain('DELETE');
  });

  it('schedules a reconnect when listTools hits an expired session (404)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      const method = (JSON.parse(opts?.body as string) as { method: string }).method;
      if (method === 'initialize') return mcpResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, { sessionId: 's1' });
      if (method === 'tools/list') return mcpResponse({}, { status: 404 }); // session expired
      return mcpResponse({ jsonrpc: '2.0', id: 1, result: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.connect();
    await expect(client.listTools()).rejects.toThrow('MCP session not found');
    expect(client.isConnected()).toBe(false);

    // Unlike the old behavior, a tools/list session-loss now arms the backoff reconnect loop.
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('parses an SSE (text/event-stream) response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
        const method = (JSON.parse(opts?.body as string) as { method: string }).method;
        const payload = method === 'initialize' ? { serverInfo: {} } : { tools: [{ name: 't', description: '', inputSchema: {} }] };
        const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload })}\n\n`;
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : method === 'initialize' ? 'sess-sse' : null) },
          text: async () => sse,
        };
      }),
    );
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(await client.listTools()).toHaveLength(1);
  });

  it('targets a normalized endpoint when hubUrl has a trailing slash', async () => {
    const c = new McpClient('http://localhost:5002/', 'key', log);
    const mockFetch = mockHub({ initialize: { serverInfo: {} } });
    vi.stubGlobal('fetch', mockFetch);
    await c.connect();
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5002/api/mcp');
  });

  it('disconnects (DELETE) and reports not connected', async () => {
    vi.stubGlobal('fetch', mockHub({ initialize: { serverInfo: {} } }));
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});
