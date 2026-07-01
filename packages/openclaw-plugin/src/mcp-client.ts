import type { McpToolDefinition, OpenClawPluginApi } from './types';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP client for the Hub MCP server, speaking the spec's **Streamable HTTP** transport (BUG-MCP-1):
 * a single `/api/mcp` endpoint where `initialize` issues an `Mcp-Session-Id` that every subsequent
 * request carries. Responses may be a plain JSON body or an SSE (`text/event-stream`) frame; both are
 * handled. Dependency-free (fetch only) so it still bundles into OpenClaw via esbuild. Reconnects with
 * exponential backoff.
 */
export class McpClient {
  private hubUrl: string;
  private apiKey: string;
  private connected = false;
  private sessionId: string | null = null;
  private requestId = 0;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 60_000;
  // Pending reconnect timer + a disposed flag so disconnect() can cancel the backoff loop instead of
  // reconnecting after an intentional teardown (a fired timer would otherwise revive the connection).
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private log: OpenClawPluginApi['log'];

  constructor(hubUrl: string, apiKey: string, log: OpenClawPluginApi['log']) {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.log = log;
  }

  private get endpoint(): string {
    return `${this.hubUrl}/api/mcp`;
  }

  async connect(): Promise<void> {
    // An explicit connect re-arms the client after a prior disconnect() disposed it.
    this.disposed = false;
    try {
      this.log.info('Connecting to Hub MCP endpoint...');
      const { response, body } = await this.post('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'openclaw-plugin', version: '1.0' },
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (body.error || !body.result || !sessionId) {
        throw new Error(body.error ? body.error.message : 'initialize did not establish a session');
      }
      this.sessionId = sessionId;
      this.connected = true;
      this.backoffMs = 1000;
      this.log.info('MCP client connected to Hub');
    } catch (error) {
      this.connected = false;
      this.sessionId = null;
      this.log.warn(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    // Stop the backoff loop and cancel any pending reconnect so we don't revive the connection.
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sessionId) {
      try {
        await fetch(this.endpoint, { method: 'DELETE', headers: this.buildHeaders(this.sessionId) });
      } catch {
        // best-effort session teardown
      }
    }
    this.sessionId = null;
    this.connected = false;
    this.log.info('MCP client disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.connected) {
      throw new Error('Hub MCP server is not connected');
    }
    const body = await this.sendMessage('tools/list', {});
    if (body.error) {
      throw new Error(body.error.message);
    }
    return (body.result as { tools: McpToolDefinition[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      return { error: 'Hub MCP server is not connected' };
    }
    try {
      const body = await this.sendMessage('tools/call', { name, arguments: args });
      if (body.error) {
        return { error: body.error.message };
      }
      return body.result;
    } catch {
      this.connected = false;
      this.scheduleReconnect();
      return { error: 'Hub MCP server is not connected' };
    }
  }

  /** Send a JSON-RPC message over the established session; a 404 means the session expired. */
  private async sendMessage(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const { response, body } = await this.post(method, params, this.sessionId ?? undefined);
    if (response.status === 404) {
      this.connected = false;
      this.sessionId = null;
      throw new Error('MCP session not found');
    }
    return body;
  }

  /** POST a JSON-RPC request to the single MCP endpoint and parse the JSON or SSE response body. */
  private async post(method: string, params: Record<string, unknown>, sessionId?: string): Promise<{ response: Response; body: JsonRpcResponse }> {
    const id = ++this.requestId;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.buildHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    // 404 (expired session) is handled by the caller; other non-2xx are hard failures.
    if (!response.ok && response.status !== 404) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }
    return { response, body: await this.readRpcBody(response) };
  }

  private buildHeaders(sessionId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return headers;
  }

  /** Extract the JSON-RPC payload from a plain JSON body or the last `data:` line of an SSE frame. */
  private async readRpcBody(response: Response): Promise<JsonRpcResponse> {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!contentType.includes('text/event-stream')) {
      return JSON.parse(text) as JsonRpcResponse;
    }
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter(Boolean);
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i] as string) as JsonRpcResponse;
      } catch {
        // keep scanning earlier data lines
      }
    }
    throw new Error('no JSON-RPC payload in MCP response');
  }

  private scheduleReconnect(): void {
    // Don't reconnect after an intentional disconnect, and don't stack overlapping timers (a live
    // session's request failure and a prior failed connect could both land here).
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log.info(`Reconnecting to Hub MCP in ${delay}ms...`);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-check disposed inside the callback: clearTimeout normally prevents this from firing, but a
      // callback already queued when disconnect() ran would otherwise revive the torn-down client.
      if (this.disposed) {
        return;
      }
      void this.connect();
    }, delay);
    // Never let a pending reconnect keep the host process alive (no-op where unref is unavailable).
    (timer as { unref?: () => void }).unref?.();
    this.reconnectTimer = timer;
  }
}
