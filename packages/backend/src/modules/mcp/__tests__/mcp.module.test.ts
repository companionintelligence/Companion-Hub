import { describe, expect, it } from 'vitest';
import { McpModule } from '../mcp.module';

describe('McpModule', () => {
  // S-MCP-3.1: when MCP_ENABLED=false, routes not registered
  describe('conditional loading', () => {
    it.todo('should not register MCP routes when MCP_ENABLED=false');
  });

  // S-MCP-3.2: disabling MCP does not affect other endpoints
  describe('isolation', () => {
    it.todo('should not affect other Hub endpoints when disabled');
  });

  // S-MCP-3.3: importable independently in test harnesses
  describe('standalone import', () => {
    it.todo('should compile as a standalone NestJS module without the full application');
  });
});
