import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type StreamableHttpMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type StreamableHttpClientConnectOptions = {
  url: string;
  headers?: Record<string, string>;
  sessionId?: string;
};

/**
 * Thin wrapper around the official MCP SDK Streamable HTTP client for upstream
 * marketplace MCP servers (context7, ad4m, etc.).
 */
export class McpStreamableHttpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  get connected(): boolean {
    return this.client !== null && this.transport !== null;
  }

  async connect(options: StreamableHttpClientConnectOptions): Promise<void> {
    await this.close();

    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      ...options.headers,
    };

    this.transport = new StreamableHTTPClientTransport(new URL(options.url), {
      sessionId: options.sessionId,
      requestInit: { headers },
    });
    this.client = new Client({ name: 'ci-hub-mcp-bridge', version: '1.0.0' });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<StreamableHttpMcpTool[]> {
    const client = this.requireClient();
    const result = await client.listTools();
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.requireClient();
    return client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // transport may already be gone
      }
      this.client = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error('Streamable HTTP MCP client is not connected');
    }
    return this.client;
  }
}
