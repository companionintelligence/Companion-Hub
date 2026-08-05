import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpAdminService } from '../mcp-admin.service';
import { McpService } from '../mcp.service';
import { McpSessionRegistry } from '../mcp-session.registry';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { LoggerService } from '@/core/logger/logger.service';

const readTool = (name: string, result: unknown = {}) => ({
  name,
  access: 'read' as const,
  description: '',
  inputSchema: {},
  handler: async () => result,
});

describe('McpAdminService', () => {
  let registry: McpToolRegistry;
  let apiKeys: MockProxy<ApiKeyService>;
  let service: McpAdminService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    registry = new McpToolRegistry();
    apiKeys = mock<ApiKeyService>();
    const mcpService = new McpService(registry, mock<LoggerService>());
    // Stub the session registry: only activeSessions (a getter) is read here.
    const sessions = { activeSessions: 2 } as unknown as McpSessionRegistry;
    service = new McpAdminService(registry, mcpService, sessions, apiKeys, mock<LoggerService>());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('reports enabled state, server info, tool count, sessions, and key count', async () => {
      process.env.MCP_ENABLED = 'true';
      apiKeys.count.mockResolvedValue(3);
      registry.register(readTool('hub_a'));

      const status = await service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.server.name).toBe('ci-hub');
      expect(status.toolCount).toBe(1);
      expect(status.activeSessions).toBe(2);
      expect(status.activeKeyCount).toBe(3);
      // No appliance-wide destructive gate is reported, because there is none: destructive access is
      // a property of each key, granted in Settings → Security.
      expect(status).not.toHaveProperty('destructiveAllowed');
      expect(apiKeys.count).toHaveBeenCalledWith('mcp'); // MCP-surface count, not all scopes
      expect(status.endpoint).toBe('/api/mcp');
      expect(status.protocolVersions).toEqual(['2026-07-28', '2025-11-25']);
    });

    it('treats MCP_ENABLED=false as disabled', async () => {
      process.env.MCP_ENABLED = 'false';
      expect((await service.getStatus()).enabled).toBe(false);
    });
  });

  describe('listTools', () => {
    it('exposes the destructive flag per tool', () => {
      registry.register(readTool('safe'));
      registry.register({ ...readTool('danger'), access: 'write' as const, destructive: true });
      const tools = service.listTools();
      expect(tools.find((t) => t.name === 'safe')?.destructive).toBe(false);
      expect(tools.find((t) => t.name === 'danger')?.destructive).toBe(true);
    });

    it('exposes read/write access per tool, so the catalog can say which capability reaches it', () => {
      registry.register(readTool('safe'));
      registry.register({ ...readTool('mutate'), access: 'write' as const });
      const tools = service.listTools();
      expect(tools.find((t) => t.name === 'safe')?.access).toBe('read');
      expect(tools.find((t) => t.name === 'mutate')?.access).toBe('write');
    });

    it('exposes each tool category, defaulting to Other when untagged', () => {
      registry.register({ ...readTool('tagged'), category: 'App Lifecycle' });
      registry.register(readTool('untagged'));
      const tools = service.listTools();
      expect(tools.find((t) => t.name === 'tagged')?.category).toBe('App Lifecycle');
      expect(tools.find((t) => t.name === 'untagged')?.category).toBe('Other');
    });
  });

  describe('callTool', () => {
    it('returns ok + result for a successful call', async () => {
      registry.register({ ...readTool('echo'), handler: async (p: Record<string, unknown>) => ({ got: p.x }) });
      const res = await service.callTool('echo', { x: 1 }, false);
      expect(res).toEqual({ ok: true, result: { got: 1 } });
    });

    it('returns ok:false with the message for an unknown tool', async () => {
      const res = await service.callTool('missing', {}, false);
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Unknown tool') });
    });

    it('blocks a destructive tool without confirmation and allows it with confirmation', async () => {
      // The operator is session-authed, so what stands between them and a destructive tool is the
      // confirmation they just gave — not a stored capability, which this caller does not have.
      registry.register({ ...readTool('wipe', { wiped: true }), access: 'write' as const, destructive: true });

      const blocked = await service.callTool('wipe', {}, false);
      expect(blocked.ok).toBe(false);

      const allowed = await service.callTool('wipe', {}, true);
      expect(allowed).toEqual({ ok: true, result: { wiped: true } });
    });

    it('runs a mutating tool for the operator without any confirmation', async () => {
      // Capability gates KEYS, not the operator's own session — requiring a tick to restart an app
      // from the Hub's own UI would be confirmation fatigue with nothing behind it.
      registry.register({ ...readTool('restart', { restarted: true }), access: 'write' as const });

      expect(await service.callTool('restart', {}, false)).toEqual({ ok: true, result: { restarted: true } });
    });
  });
});
