import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpAdminService } from '../mcp-admin.service';
import { McpService } from '../mcp.service';
import { McpSessionRegistry } from '../mcp-session.registry';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('McpAdminService', () => {
  let registry: McpToolRegistry;
  let configuration: MockProxy<ConfigurationService>;
  let service: McpAdminService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    registry = new McpToolRegistry();
    configuration = mock<ConfigurationService>();
    const mcpService = new McpService(registry, mock<LoggerService>());
    // Stub the session registry: only activeSessions (a getter) is read here.
    const sessions = { activeSessions: 2 } as unknown as McpSessionRegistry;
    service = new McpAdminService(registry, mcpService, sessions, configuration, mock<LoggerService>());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('reports enabled state, server info, tool count, sessions, and gate', () => {
      process.env.MCP_ENABLED = 'true';
      process.env.MCP_API_KEY = 'secret';
      process.env.MCP_ALLOW_DESTRUCTIVE = 'true';
      registry.register({ name: 'hub_a', description: '', inputSchema: {}, handler: async () => ({}) });

      const status = service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.server.name).toBe('ci-hub');
      expect(status.toolCount).toBe(1);
      expect(status.activeSessions).toBe(2);
      expect(status.destructiveAllowed).toBe(true);
      expect(status.apiKeyConfigured).toBe(true);
      expect(status.endpoint).toBe('/api/mcp');
    });

    it('treats MCP_ENABLED=false as disabled', () => {
      process.env.MCP_ENABLED = 'false';
      expect(service.getStatus().enabled).toBe(false);
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

  describe('rotateApiKey', () => {
    it('generates + persists (disk-only) + applies a new key and warns about agent apps', async () => {
      const res = await service.rotateApiKey();
      expect(res.apiKey).toMatch(/^[a-f0-9]{48}$/);
      // SECURITY: key must be persisted via the disk-only path, never via setUserSettings (which
      // merges into the /app-context userSettings and would disclose the key to browser sessions).
      expect(configuration.persistMcpSettings).toHaveBeenCalledWith({ mcpApiKey: res.apiKey });
      expect(configuration.setUserSettings).not.toHaveBeenCalled();
      expect(process.env.MCP_API_KEY).toBe(res.apiKey);
      expect(res.warning).toMatch(/re-installed or restarted/i);
    });
  });
});
