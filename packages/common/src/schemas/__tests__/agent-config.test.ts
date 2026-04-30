import { describe, expect, it } from 'vitest';
import { agentConfigSchema, agentMcpConfigSchema, agentOpenApiAuthSchema, agentOpenApiConfigSchema, agentSkillConfigSchema } from '../agent-config';

describe('agent-config schemas', () => {
  describe('agentSkillConfigSchema', () => {
    it('should accept boolean true', () => {
      const result = agentSkillConfigSchema.safeParse(true);
      expect(result.success).toBe(true);
    });

    it('should accept boolean false', () => {
      const result = agentSkillConfigSchema.safeParse(false);
      expect(result.success).toBe(true);
    });

    it('should accept a string (inline content)', () => {
      const result = agentSkillConfigSchema.safeParse('# My App\nInline skill content');
      expect(result.success).toBe(true);
    });

    it('should accept object with enabled field', () => {
      const result = agentSkillConfigSchema.safeParse({ enabled: true });
      expect(result.success).toBe(true);
    });

    it('should default enabled to true in object form', () => {
      const result = agentSkillConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('agentOpenApiAuthSchema', () => {
    it('should accept bearer auth config', () => {
      const result = agentOpenApiAuthSchema.safeParse({
        type: 'bearer',
        token_env: 'APP_TOKEN',
      });
      expect(result.success).toBe(true);
    });

    it('should accept api_key config', () => {
      const result = agentOpenApiAuthSchema.safeParse({
        type: 'api_key',
        token_env: 'API_KEY',
        api_key_name: 'X-API-Key',
        api_key_in: 'header',
      });
      expect(result.success).toBe(true);
    });

    it('should default to none', () => {
      const result = agentOpenApiAuthSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('none');
      }
    });
  });

  describe('agentOpenApiConfigSchema', () => {
    it('should accept full OpenAPI config', () => {
      const result = agentOpenApiConfigSchema.safeParse({
        enabled: true,
        spec_path: 'agents/openapi.yaml',
        base_url: 'http://localhost:8080',
        auth: { type: 'bearer', token_env: 'TOKEN' },
        operations_filter: ['GET *', 'POST /api/*'],
      });
      expect(result.success).toBe(true);
    });

    it('should have default spec_path', () => {
      const result = agentOpenApiConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.spec_path).toBe('agents/openapi.yaml');
      }
    });
  });

  describe('agentMcpConfigSchema', () => {
    it('should accept SSE transport config', () => {
      const result = agentMcpConfigSchema.safeParse({
        enabled: true,
        transport: 'sse',
        url: 'http://localhost:3000/mcp',
        auth: { type: 'bearer', token_env: 'MCP_TOKEN' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept stdio transport config', () => {
      const result = agentMcpConfigSchema.safeParse({
        enabled: true,
        transport: 'stdio',
        command: ['node', '/app/mcp-server.js'],
        container: 'main',
      });
      expect(result.success).toBe(true);
    });

    it('should default transport to sse', () => {
      const result = agentMcpConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.transport).toBe('sse');
      }
    });
  });

  describe('agentConfigSchema', () => {
    it('should accept full agent config with all three layers', () => {
      const result = agentConfigSchema.safeParse({
        skill: true,
        openapi: {
          enabled: true,
          spec_path: 'agents/openapi.yaml',
        },
        mcp: {
          enabled: true,
          transport: 'sse',
          url: 'http://localhost/mcp',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept config with only skill', () => {
      const result = agentConfigSchema.safeParse({
        skill: true,
      });
      expect(result.success).toBe(true);
    });

    it('should accept undefined (optional)', () => {
      const result = agentConfigSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('should accept inline skill string', () => {
      const result = agentConfigSchema.safeParse({
        skill: '# My App\nSome instructions',
      });
      expect(result.success).toBe(true);
    });
  });
});
