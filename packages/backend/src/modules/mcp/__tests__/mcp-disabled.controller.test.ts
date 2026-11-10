import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpDisabledController } from '../mcp-disabled.controller';
import { isMcpEnabled } from '../mcp-enabled';

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
