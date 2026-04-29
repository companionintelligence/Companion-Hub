import type { McpToolDefinition, OpenClawPluginApi } from './types';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP client that connects to the Hub MCP server over HTTP+SSE.
 * Establishes an SSE connection to discover the messages endpoint,
 * then uses JSON-RPC over HTTP for tool calls.
 * Handles reconnection with exponential backoff.
 */
export class McpClient {
  private hubUrl: string;
  private apiKey: string;
  private connected = false;
  private messagesUrl: string | null = null;
  private requestId = 0;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 60_000;
  private sseAbortController: AbortController | null = null;
  private log: OpenClawPluginApi['log'];

  constructor(hubUrl: string, apiKey: string, log: OpenClawPluginApi['log']) {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.log = log;
  }

  async connect(): Promise<void> {
    try {
      this.sseAbortController = new AbortController();

      // Step 1: Connect to SSE endpoint to discover the messages URL
      this.log.info('Connecting to Hub MCP SSE endpoint...');
      this.messagesUrl = await this.discoverMessagesEndpoint();

      // Step 2: Send initialize via the discovered messages URL
      const initResponse = await this.sendMessage('initialize', {});
      if (initResponse.result) {
        this.connected = true;
        this.backoffMs = 1000;
        this.log.info('MCP client connected to Hub');
      }
    } catch (error) {
      this.connected = false;
      this.messagesUrl = null;
      this.log.warn(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Connect to the SSE endpoint and extract the messages URL from the
   * `endpoint` event, per MCP HTTP+SSE transport spec.
   */
  private async discoverMessagesEndpoint(): Promise<string> {
    const sseUrl = `${this.hubUrl}/api/mcp/sse`;
    const response = await fetch(sseUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: this.sseAbortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    // Read SSE stream until we get the endpoint event
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended before endpoint event');

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEvent === 'endpoint') {
          const messagesUrl = line.slice(6).trim();
          // Don't close the SSE connection — keep it alive for the session
          this.log.info(`Discovered MCP messages endpoint: ${messagesUrl}`);
          return messagesUrl;
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    this.messagesUrl = null;
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
    const response = await this.sendMessage('tools/list', {});
    if (response.error) {
      throw new Error(response.error.message);
    }
    return (response.result as { tools: McpToolDefinition[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      return { error: 'Hub MCP server is not connected' };
    }
    try {
      const response = await this.sendMessage('tools/call', { name, arguments: args });
      if (response.error) {
        return { error: response.error.message };
      }
      return response.result;
    } catch (error) {
      this.connected = false;
      this.scheduleReconnect();
      return { error: 'Hub MCP server is not connected' };
    }
  }

  private async sendMessage(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const url = this.messagesUrl ?? `${this.hubUrl}/api/mcp/messages`;
    const id = ++this.requestId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: this.sseAbortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as JsonRpcResponse;
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log.info(`Reconnecting to Hub MCP in ${delay}ms...`);
    setTimeout(() => this.connect(), delay);
  }
}
