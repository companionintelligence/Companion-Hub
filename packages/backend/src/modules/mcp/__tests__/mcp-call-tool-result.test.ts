import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LoggerService } from '@/core/logger/logger.service';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { bridgedCallToolResult, isMarkedCallToolResult, markCallToolResult } from '../mcp-call-tool-result';
import { mcpCallContext } from '../mcp-call-context';
import { invokeRegistryTool } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { McpService } from '../mcp.service';
import { McpV2ServerFactory } from '../mcp-v2-server.factory';

describe('bridgedCallToolResult', () => {
  it("keeps an app server's text item as it is, without encoding it again", () => {
    const upstream = { content: [{ type: 'text', text: '{"login":"octocat"}' }] };

    expect(bridgedCallToolResult(upstream)).toEqual({ content: [{ type: 'text', text: '{"login":"octocat"}' }] });
  });

  it('keeps a file the server returns as a resource item', () => {
    const upstream = {
      content: [
        { type: 'text', text: 'successfully downloaded text file' },
        { type: 'resource', resource: { uri: 'repo://github/github-mcp-server/contents/LICENSE', mimeType: 'text/plain', text: 'MIT License' } },
      ],
    };

    expect(bridgedCallToolResult(upstream)?.content).toEqual(upstream.content);
  });

  it("carries the server's isError", () => {
    const upstream = { content: [{ type: 'text', text: 'state: invalid value' }], isError: true };

    expect(bridgedCallToolResult(upstream)).toEqual({ content: [{ type: 'text', text: 'state: invalid value' }], isError: true });
  });

  it('turns a content item the protocol does not define into text instead of failing the call', () => {
    const result = bridgedCallToolResult({ content: [{ type: 'hologram', frames: 3 }] });

    expect(result).toEqual({ content: [{ type: 'text', text: '{"type":"hologram","frames":3}' }] });
  });

  it('drops structuredContent, which the Hub tool declares no schema for', () => {
    const result = bridgedCallToolResult({ content: [{ type: 'text', text: '1 issue' }], structuredContent: { issues: [1] } });

    expect(result).toEqual({ content: [{ type: 'text', text: '1 issue' }] });
  });

  it("reads the bridge's own refusal as a failed call", () => {
    const refusal = { error: 'MCP error from github-mcp:ci-marketplace: failed to list issues: 422 Validation Failed', isError: true };

    expect(bridgedCallToolResult(refusal)).toEqual({
      content: [{ type: 'text', text: 'MCP error from github-mcp:ci-marketplace: failed to list issues: 422 Validation Failed' }],
      isError: true,
    });
  });

  it('is null for anything else, which then goes out encoded as before', () => {
    expect(bridgedCallToolResult('plain')).toBeNull();
    expect(bridgedCallToolResult(null)).toBeNull();
    expect(bridgedCallToolResult({ rows: [] })).toBeNull();
  });
});

describe('markCallToolResult', () => {
  it('marks without adding anything JSON can see, so the admin runner shows the plain result', () => {
    const marked = markCallToolResult({ content: [{ type: 'text', text: 'ok' }] });

    expect(isMarkedCallToolResult(marked)).toBe(true);
    expect(JSON.parse(JSON.stringify(marked))).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('does not take an unmarked object of the same shape for one', () => {
    expect(isMarkedCallToolResult({ content: [{ type: 'text', text: 'ok' }] })).toBe(false);
  });
});

describe('invokeRegistryTool with an app tool result', () => {
  const whois = { hubManageVerdictFor: async () => 'allowed' as never };
  const call = (result: unknown) => {
    const registry = mock<McpToolRegistry>();
    registry.callTool.mockResolvedValue(result);
    return invokeRegistryTool(registry, mock<LoggerService>(), whois, 'hub_call_app_tool', { appUrn: 'github-mcp:ci-marketplace' });
  };

  it("sends a marked result's content and isError as the tools/call result", async () => {
    const result = await call(markCallToolResult({ content: [{ type: 'text', text: '422 Validation Failed' }], isError: true }));

    expect(result).toEqual({ content: [{ type: 'text', text: '422 Validation Failed' }], isError: true });
  });

  it('sends a marked success without isError', async () => {
    const result = await call(markCallToolResult({ content: [{ type: 'text', text: '[]' }] }));

    expect(result).toEqual({ content: [{ type: 'text', text: '[]' }] });
  });

  it("still encodes every other tool's return as one JSON text item", async () => {
    const result = await call({ content: [{ type: 'text', text: 'not marked' }] });

    expect(result).toEqual({ content: [{ type: 'text', text: '{"content":[{"type":"text","text":"not marked"}]}' }] });
  });
});

// The per-request server is built on a different SDK package than the one McpServerFactory uses, so
// it gets its own round trip: a resource item and isError have to survive its result validation too.
describe('an app tool result through the per-request (2026-07-28) server', () => {
  const key: ApiKeyContext = { id: 1, name: 'test-key', capability: 'read', ownerAppUrn: null, createdByUserId: null } as ApiKeyContext;
  const file = { uri: 'repo://github/github-mcp-server/contents/LICENSE', mimeType: 'text/plain', text: 'MIT License' };

  it('reaches a real client with its items and isError', async () => {
    const registry = new McpToolRegistry();
    const tool = (name: string, result: CallToolResult) => ({
      name,
      access: 'read' as const,
      description: '',
      inputSchema: { type: 'object' },
      handler: async () => markCallToolResult(result),
    });
    registry.register(
      tool('hub_app_ok', {
        content: [
          { type: 'text', text: 'downloaded' },
          { type: 'resource', resource: file },
        ],
      }),
    );
    registry.register(tool('hub_app_refused', { content: [{ type: 'text', text: '422 Validation Failed' }], isError: true }));
    const logger = mock<LoggerService>();
    const server = await mcpCallContext.run(key, () =>
      new McpV2ServerFactory(registry, new McpService(registry, logger), logger, mock<MarketplaceWhoIsService>()).create({ era: 'legacy' } as never),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as never);
    const client = new Client({ name: 'call-tool-result-test', version: '1.0.0' });
    await client.connect(clientTransport);

    const ok = await mcpCallContext.run(key, () => client.callTool({ name: 'hub_app_ok', arguments: {} }));
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([
      { type: 'text', text: 'downloaded' },
      { type: 'resource', resource: file },
    ]);

    const refused = await mcpCallContext.run(key, () => client.callTool({ name: 'hub_app_refused', arguments: {} }));
    expect(refused.isError).toBe(true);
    expect(refused.content).toEqual([{ type: 'text', text: '422 Validation Failed' }]);
  });
});
