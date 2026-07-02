import type { McpToolDefinition, OpenClawPluginApi } from './types';

/** MCP protocol version this client requests at initialize (kept as a named constant rather than
 *  repeated string literals). The Hub advertises the SDK's LATEST_PROTOCOL_VERSION and negotiates
 *  down if needed, so bump this when the client is validated against a newer spec revision. */
const MCP_CLIENT_PROTOCOL_VERSION = '2025-11-25';

/** Default per-request timeout so a hung/half-open Hub connection can't wedge the plugin. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Transport-level failure: the Hub was unreachable or stopped responding (network fault, connection
 * refused/reset, request or body-read timeout). Distinguished from an HTTP error a LIVE server
 * returned, so callers can decide between entering the reconnect loop (transport dead) and surfacing
 * a tool-level fault (server alive, session likely still valid).
 */
export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTransportError';
  }
}

/**
 * fetch with a hard timeout via AbortController so a hung/half-open connection can't block a call
 * indefinitely. The timer is always cleared. Exported so the plugin's other Hub/inference metadata
 * calls (index.ts) share the same guard. NOTE: the timeout spans the request up to response headers;
 * McpClient.post() manages its own controller so the timeout also covers the response body read.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'openclaw-plugin', version: '1.0' },
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (body.error || !body.result || !sessionId) {
        throw new Error(body.error ? body.error.message : 'initialize did not establish a session');
      }
      if (this.disposed) {
        // disconnect() ran while initialize was in flight — release the session we just created and
        // stay torn down instead of reviving the client (the teardown already saw a null sessionId).
        await fetchWithTimeout(this.endpoint, { method: 'DELETE', headers: this.buildHeaders(sessionId) }).catch(() => undefined);
        this.log.info('MCP connect aborted (client disconnected during initialize)');
        return;
      }
      // A transport-fault teardown keeps sessionId (the Hub was unreachable, so a DELETE was
      // pointless then). Now that the Hub answers again, reclaim that stale session fire-and-forget
      // rather than leaving it to the server's idle reaper. (404 session-loss already nulls it.)
      const staleSessionId = this.sessionId;
      if (staleSessionId && staleSessionId !== sessionId) {
        fetchWithTimeout(this.endpoint, { method: 'DELETE', headers: this.buildHeaders(staleSessionId) }).catch(() => undefined);
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
        await fetchWithTimeout(this.endpoint, { method: 'DELETE', headers: this.buildHeaders(this.sessionId) });
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
    try {
      const body = await this.sendMessage('tools/list', {});
      if (body.error) {
        throw new Error(body.error.message);
      }
      return (body.result as { tools: McpToolDefinition[] }).tools;
    } catch (error) {
      // Hub unreachable (transport fault/timeout) or session lost (sendMessage's 404) — arm the
      // backoff reconnect loop before propagating, so a tools/list failure can't leave the client
      // stuck reporting connected with no reconnect scheduled.
      if (error instanceof McpTransportError || !this.connected) {
        this.connected = false;
        this.scheduleReconnect();
      }
      throw error;
    }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpTransportError || !this.connected) {
        // Hub unreachable (network fault/timeout) or session lost (sendMessage's 404) — mark
        // disconnected and enter the backoff loop so the client self-recovers when the Hub returns.
        this.connected = false;
        this.scheduleReconnect();
      } else {
        // HTTP/parse fault from a LIVE server: surface the REAL cause instead of masquerading it as
        // "not connected", and don't tear down a session that may still work.
        this.log.warn(`MCP tool call '${name}' failed: ${message}`);
      }
      return { error: message };
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

  /**
   * POST a JSON-RPC request to the single MCP endpoint and parse the JSON or SSE response body.
   * ONE AbortController spans both the request and the body read, so a Hub that hangs after sending
   * headers still trips the timeout (a headers-only guard would leave `response.text()` unbounded).
   * Network faults and timeouts throw {@link McpTransportError}; an HTTP error status from a live
   * server stays a plain Error (the session may still be valid).
   */
  private async post(method: string, params: Record<string, unknown>, sessionId?: string): Promise<{ response: Response; body: JsonRpcResponse }> {
    const id = ++this.requestId;
    // Serialize OUTSIDE the transport try: a non-serializable tool argument (BigInt, circular
    // object) is a caller-side input error and must surface as a plain error — never as a transport
    // fault that would tear down a healthy session.
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.buildHeaders(sessionId),
          body: payload,
          signal: controller.signal,
        });
      } catch (error) {
        // fetch rejects only on a network fault or an abort — both mean the Hub is unreachable.
        throw new McpTransportError(
          controller.signal.aborted
            ? `MCP request timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // On paths that never parse the body, discard it so undici can recycle the socket instead of
      // stranding it until the Response is GC'd.
      const discardBody = () => void response.body?.cancel().catch(() => undefined);
      // 502/504 are proxy-generated (bad gateway / gateway timeout): the Hub behind Traefik/CI-Gateway
      // is unreachable — a transport fault in all but name, so classify it for the reconnect loop.
      // 503 is deliberately EXCLUDED: a live server emits it under load/maintenance, and tearing down a
      // valid session then would add initialize churn at the worst possible time.
      if (response.status === 502 || response.status === 504) {
        discardBody();
        throw new McpTransportError(`MCP request failed: ${response.status} ${response.statusText}`);
      }
      // 404: no consumer needs the body — sendMessage decides on status alone, and connect() only
      // needs an error envelope — so synthesize one instead of parsing. This also covers a gateway
      // "no route" 404 whose HTML body would otherwise fail parsing and mask the 404 from the
      // session-loss recovery path.
      if (response.status === 404) {
        discardBody();
        return { response, body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Session not found (HTTP 404)' } } };
      }
      // Other non-2xx are hard failures — but from a LIVE server, so deliberately NOT
      // McpTransportError (no reconnect churn for a server-side 5xx).
      if (!response.ok) {
        discardBody();
        throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
      }
      // Read the body under the same timeout. A body-read failure is transport-level either way:
      // the stream stalled until the abort fired, or it died outright (reset/terminated mid-body).
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new McpTransportError(
          controller.signal.aborted
            ? `MCP response timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `MCP response body failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Parsing is a server-side concern: a malformed body from a live server stays a plain error.
      return { response, body: this.parseRpcBody(text, response.headers.get('content-type') ?? '') };
    } finally {
      clearTimeout(timer);
    }
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

  /** Extract the JSON-RPC payload from a plain JSON body or the last `data:` line of an SSE frame.
   *  Pure parse — the body TEXT is read (and timeout-guarded) by post(), so parse failures here are
   *  unambiguously server-side, never transport faults. Convention: gate on `application/json` (else
   *  parse as SSE) — kept identical to the Layer-2 QA bridge (scripts/qa-mcp-bridge.ts) so both
   *  hand-rolled clients resolve an ambiguous content-type the same way. The two are intentionally
   *  NOT a shared module: the QA script is dependency-free so it ships to fleet nodes unchanged. */
  private parseRpcBody(text: string, contentType: string): JsonRpcResponse {
    if (contentType.includes('application/json')) {
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
    // Last resort: an intermediary (reverse proxy/gateway) may strip or rewrite the content-type on
    // a plain JSON body — try the raw text before giving up. Mirrored in scripts/qa-mcp-bridge.ts.
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error('no JSON-RPC payload in MCP response');
    }
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
