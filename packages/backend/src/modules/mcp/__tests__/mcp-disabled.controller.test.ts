import { GUARDS_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpDisabledController } from '../mcp-disabled.controller';

// CI-Hub#2380: with MCP_ENABLED=false the MCP module is not imported, so nothing answered
// /api/mcp-admin/status and Settings > MCP showed its load error instead of "Disabled".
describe('McpDisabledController', () => {
  it('reports MCP as disabled on the same session-authed path the Settings screen reads', () => {
    const controller = new McpDisabledController();

    expect(Reflect.getMetadata(PATH_METADATA, McpDisabledController)).toBe('mcp-admin');
    expect(Reflect.getMetadata(GUARDS_METADATA, McpDisabledController)).toEqual([AuthGuard]);
    expect(controller.getStatus()).toEqual({ enabled: false, endpoint: '/api/mcp', toolCount: 0, activeSessions: 0, activeKeyCount: 0 });
  });

  it('lists no tools', () => {
    expect(new McpDisabledController().listTools()).toEqual({ tools: [] });
  });
});

describe('AppModule MCP wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const importedModules = async () => {
    vi.resetModules();
    const { AppModule } = await import('@/app.module');
    const { McpModule } = await import('../mcp.module');
    const { McpDisabledModule } = await import('../mcp-disabled.module');
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    return { imports, McpModule, McpDisabledModule };
  };

  it('imports the disabled stand-in, not the MCP module, when MCP is off', async () => {
    vi.stubEnv('MCP_ENABLED', 'false');
    const { imports, McpModule, McpDisabledModule } = await importedModules();

    expect(imports).toContain(McpDisabledModule);
    expect(imports).not.toContain(McpModule);
  });

  it('imports the MCP module, not the disabled stand-in, when MCP is on', async () => {
    vi.stubEnv('MCP_ENABLED', 'true');
    const { imports, McpModule, McpDisabledModule } = await importedModules();

    expect(imports).toContain(McpModule);
    expect(imports).not.toContain(McpDisabledModule);
  });
});
