import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpAdminService } from '../mcp-admin.service';
import { McpService } from '../mcp.service';
import { McpSessionRegistry } from '../mcp-session.registry';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { ApiKeyAdminService } from '@/modules/api-keys/api-key-admin.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('McpAdminService', () => {
  let registry: McpToolRegistry;
  let configuration: MockProxy<ConfigurationService>;
  let apiKeys: MockProxy<ApiKeyService>;
  let apiKeyAdmin: MockProxy<ApiKeyAdminService>;
  let service: McpAdminService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    registry = new McpToolRegistry();
    configuration = mock<ConfigurationService>();
    apiKeys = mock<ApiKeyService>();
    apiKeyAdmin = mock<ApiKeyAdminService>();
    const mcpService = new McpService(registry, mock<LoggerService>());
    // Stub the session registry: only activeSessions (a getter) is read here.
    const sessions = { activeSessions: 2 } as unknown as McpSessionRegistry;
    service = new McpAdminService(registry, mcpService, sessions, configuration, apiKeys, apiKeyAdmin, mock<LoggerService>());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('reports enabled state, server info, tool count, sessions, gate, and key count', async () => {
      process.env.MCP_ENABLED = 'true';
      process.env.MCP_ALLOW_DESTRUCTIVE = 'true';
      apiKeys.count.mockResolvedValue(3);
      registry.register({ name: 'hub_a', description: '', inputSchema: {}, handler: async () => ({}) });

      const status = await service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.server.name).toBe('ci-hub');
      expect(status.toolCount).toBe(1);
      expect(status.activeSessions).toBe(2);
      expect(status.destructiveAllowed).toBe(true);
      expect(status.activeKeyCount).toBe(3);
      expect(apiKeys.count).toHaveBeenCalledWith('mcp'); // MCP-surface count, not all scopes
      expect(status.endpoint).toBe('/api/mcp');
    });

    it('treats MCP_ENABLED=false as disabled', async () => {
      process.env.MCP_ENABLED = 'false';
      expect((await service.getStatus()).enabled).toBe(false);
    });
  });

  describe('listTools', () => {
    it('exposes the destructive flag per tool', () => {
      registry.register({ name: 'safe', description: '', inputSchema: {}, handler: async () => ({}) });
      registry.register({ name: 'danger', destructive: true, description: '', inputSchema: {}, handler: async () => ({}) });
      const tools = service.listTools();
      expect(tools.find((t) => t.name === 'safe')?.destructive).toBe(false);
      expect(tools.find((t) => t.name === 'danger')?.destructive).toBe(true);
    });

    it('exposes each tool category, defaulting to Other when untagged', () => {
      registry.register({ name: 'tagged', category: 'App Lifecycle', description: '', inputSchema: {}, handler: async () => ({}) });
      registry.register({ name: 'untagged', description: '', inputSchema: {}, handler: async () => ({}) });
      const tools = service.listTools();
      expect(tools.find((t) => t.name === 'tagged')?.category).toBe('App Lifecycle');
      expect(tools.find((t) => t.name === 'untagged')?.category).toBe('Other');
    });
  });

  describe('callTool', () => {
    it('returns ok + result for a successful call', async () => {
      registry.register({ name: 'echo', description: '', inputSchema: {}, handler: async (p) => ({ got: p.x }) });
      const res = await service.callTool('echo', { x: 1 }, false);
      expect(res).toEqual({ ok: true, result: { got: 1 } });
    });

    it('returns ok:false with the message for an unknown tool', async () => {
      const res = await service.callTool('missing', {}, false);
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Unknown tool') });
    });

    it('blocks a destructive tool without confirmation and allows it with confirmation', async () => {
      registry.register({ name: 'wipe', destructive: true, description: '', inputSchema: {}, handler: async () => ({ wiped: true }) });
      delete process.env.MCP_ALLOW_DESTRUCTIVE;

      const blocked = await service.callTool('wipe', {}, false);
      expect(blocked.ok).toBe(false);

      const allowed = await service.callTool('wipe', {}, true);
      expect(allowed).toEqual({ ok: true, result: { wiped: true } });
    });
  });

  describe('setDestructiveAllowed', () => {
    it('persists via the disk-only path and applies to process.env immediately', async () => {
      await service.setDestructiveAllowed(true);
      // Disk-only: must NOT go through setUserSettings (which would leak into /app-context).
      expect(configuration.persistMcpSettings).toHaveBeenCalledWith({ mcpAllowDestructive: true });
      expect(configuration.setUserSettings).not.toHaveBeenCalled();
      expect(process.env.MCP_ALLOW_DESTRUCTIVE).toBe('true');
    });
  });

  describe('key management (transitional delegates)', () => {
    // Key management moved to the hub-wide ApiKeyAdminService; these routes stay for one
    // release so a not-yet-refreshed frontend keeps working. Behavior (last-operator-key
    // guard etc.) is covered in api-keys/__tests__/api-key-admin.service.test.ts.
    it('listKeys delegates to the hub-wide admin service', async () => {
      apiKeyAdmin.listKeys.mockResolvedValue([]);
      await service.listKeys();
      expect(apiKeyAdmin.listKeys).toHaveBeenCalled();
    });

    it('createKey delegates to the hub-wide admin service', async () => {
      apiKeyAdmin.createKey.mockResolvedValue({
        id: 5,
        name: 'CLI',
        prefix: 'abcd1234',
        scopes: ['mcp'],
        key: 'abcd1234RAW',
        managed: false,
        ownerAppUrn: null,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      });
      const res = await service.createKey('CLI');
      expect(apiKeyAdmin.createKey).toHaveBeenCalledWith('CLI');
      expect(res.key).toBe('abcd1234RAW');
    });

    it('revokeKey delegates to the hub-wide admin service', async () => {
      apiKeyAdmin.revokeKey.mockResolvedValue({ revoked: true });
      expect(await service.revokeKey(5)).toEqual({ revoked: true });
      expect(apiKeyAdmin.revokeKey).toHaveBeenCalledWith(5);
    });
  });
});
