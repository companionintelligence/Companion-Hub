import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpAdminService } from '../mcp-admin.service';
import { McpDisabledController } from '../mcp-disabled.controller';
import { McpService } from '../mcp.service';
import { McpSessionRegistry } from '../mcp-session.registry';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { isMcpEnabled } from '../mcp-enabled';

// CI-Hub#2380: with MCP_ENABLED=false the MCP module is not imported, so nothing answered
// /api/mcp-admin/status and Settings > MCP showed its load error instead of "Disabled".
describe('McpDisabledController', () => {
  it('reports MCP as disabled on the same session-authed path the Settings screen reads', () => {
    const controller = new McpDisabledController();

    expect(Reflect.getMetadata(PATH_METADATA, McpDisabledController)).toBe('mcp-admin');
    expect(Reflect.getMetadata(GUARDS_METADATA, McpDisabledController)).toEqual([AuthGuard]);
    expect(controller.getStatus()).toMatchObject({ enabled: false, endpoint: '/api/mcp', toolCount: 0, activeSessions: 0, activeKeyCount: 0 });
  });

  // A mobile app carries its own copy of the Settings screen. One built before this stand-in existed
  // reads `status.server.name` from any 200, so the stand-in answers with every key the real one has.
  it('answers with the real status of an idle Hub, so an older screen can show its own Disabled badge', async () => {
    const registry = new McpToolRegistry();
    const real = new McpAdminService(
      registry,
      new McpService(registry, mock<LoggerService>()),
      { activeSessions: 0 } as unknown as McpSessionRegistry,
      mock<ApiKeyService>({ count: vi.fn().mockResolvedValue(0) }),
      mock<LoggerService>(),
    );
    const stand = new McpDisabledController().getStatus();

    expect(stand).toEqual({ ...(await real.getStatus()), enabled: false });
    expect(stand.protocolVersions).toContain(stand.protocolVersion);
  });

  it('lists no tools', () => {
    expect(new McpDisabledController().listTools()).toEqual({ tools: [] });
  });
});

// AppModule chooses McpModule or McpDisabledModule with this check. It is tested on its own because
// importing AppModule re-evaluates the whole backend module graph, which took up to 59s on a loaded
// machine for a single case.
describe('isMcpEnabled', () => {
  it('turns MCP off only when MCP_ENABLED is exactly "false"', () => {
    expect(isMcpEnabled({ MCP_ENABLED: 'false' })).toBe(false);
    expect(isMcpEnabled({ MCP_ENABLED: 'true' })).toBe(true);
    expect(isMcpEnabled({})).toBe(true);
  });
});
