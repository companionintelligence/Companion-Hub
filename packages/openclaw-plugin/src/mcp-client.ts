import type { McpToolDefinition, OpenClawPluginApi } from './types';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP client that connects to the Hub MCP server over HTTP+SSE.
 * Handles tool listing, tool calling, and reconnection with exponential backoff.
 */
export class McpClient {
  private hubUrl: string;
  private apiKey: string;
  private connected = false;
  private requestId = 0;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 60_000;
  private abortController: AbortController | null = null;
  private log: OpenClawPluginApi['log'];

  constructor(hubUrl: string, apiKey: string, log: OpenClawPluginApi['log']) {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.log = log;
  }

  async connect(): Promise<void> {
    try {
      this.abortController = new AbortController();
      // Initialize the MCP connection
      const initResponse = await this.sendMessage('initialize', {});
      if (initResponse.result) {
        this.connected = true;
        this.backoffMs = 1000;
        this.log.info('MCP client connected to Hub');
      }
    } catch (error) {
      this.connected = false;
      this.log.warn(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
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
    const id = ++this.requestId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const response = await fetch(`${this.hubUrl}/api/mcp/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: this.abortController?.signal,
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
