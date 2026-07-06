import { describe, expect, it } from 'vitest';
import { hubIntegrationSchema } from '../app-info';
import { appInfoSchema } from '../app-info';

describe('hubIntegrationSchema', () => {
  describe('R-SCH-1: schema fields', () => {
    it('should accept a full hub_integration object', () => {
      const result = hubIntegrationSchema.safeParse({
        mcp_client: true,
        wake_endpoint: '/hooks/hub-wake',
        wake_port: 3000,
        sse_events: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.mcp_client).toBe(true);
        expect(result.data?.wake_endpoint).toBe('/hooks/hub-wake');
        expect(result.data?.wake_port).toBe(3000);
        expect(result.data?.sse_events).toBe(false);
      }
    });

    it('should default mcp_client to false', () => {
      const result = hubIntegrationSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.mcp_client).toBe(false);
      }
    });

    it('should default wake_endpoint to /hooks/hub-wake', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.wake_endpoint).toBe('/hooks/hub-wake');
      }
    });

    it('should default sse_events to false', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.sse_events).toBe(false);
      }
    });

    it('should accept undefined (field is optional)', () => {
      const result = hubIntegrationSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('should allow custom wake_endpoint', () => {
      const result = hubIntegrationSchema.safeParse({
        mcp_client: true,
        wake_endpoint: '/api/wake',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.wake_endpoint).toBe('/api/wake');
      }
    });

    it('should allow custom wake_port', () => {
      const result = hubIntegrationSchema.safeParse({
        mcp_client: true,
        wake_port: 8080,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.wake_port).toBe(8080);
      }
    });
  });

  describe('R-SCH-3: oidc issuer mapping', () => {
    it('should accept an oidc block with issuer_env and issuer_path', () => {
      const result = hubIntegrationSchema.safeParse({
        oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.oidc?.issuer_env).toBe('CI_OIDC_ISSUER');
        expect(result.data?.oidc?.issuer_path).toBe('/api/auth');
      }
    });

    it('should accept an oidc block with only issuer_env (bare-origin issuer)', () => {
      const result = hubIntegrationSchema.safeParse({
        oidc: { issuer_env: 'OIDC_ISSUER_URL' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.oidc?.issuer_env).toBe('OIDC_ISSUER_URL');
        expect(result.data?.oidc?.issuer_path).toBeUndefined();
      }
    });

    it('should reject an oidc block missing issuer_env', () => {
      const result = hubIntegrationSchema.safeParse({ oidc: { issuer_path: '/api/auth' } });
      expect(result.success).toBe(false);
    });

    it('should reject an empty issuer_env', () => {
      const result = hubIntegrationSchema.safeParse({ oidc: { issuer_env: '' } });
      expect(result.success).toBe(false);
    });

    it('should reject a whitespace-only or malformed issuer_env (must be a valid env var name)', () => {
      expect(hubIntegrationSchema.safeParse({ oidc: { issuer_env: '   ' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ oidc: { issuer_env: 'CI_OIDC_ISSUER ' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ oidc: { issuer_env: '1_BAD_NAME' } }).success).toBe(false);
    });

    it('should leave oidc undefined when not declared', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.oidc).toBeUndefined();
      }
    });
  });

  describe('R-SCH-2: appInfoSchema integration', () => {
    const minimalAppInfo = {
      id: 'test-app',
      urn: 'test-app:test-store',
      available: true,
      port: 8080,
      name: 'Test',
      short_desc: 'Test app',
      author: 'Test',
      source: 'https://example.com',
      cihub_app_version: 1,
    };

    it('should parse appInfoSchema with hub_integration', () => {
      const result = appInfoSchema.safeParse({
        ...minimalAppInfo,
        hub_integration: {
          mcp_client: true,
          wake_endpoint: '/hooks/hub-wake',
          wake_port: 3000,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration?.mcp_client).toBe(true);
      }
    });

    it('should parse appInfoSchema with hub_integration.oidc', () => {
      const result = appInfoSchema.safeParse({
        ...minimalAppInfo,
        hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth' } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration?.oidc?.issuer_env).toBe('CI_OIDC_ISSUER');
        expect(result.data.hub_integration?.oidc?.issuer_path).toBe('/api/auth');
      }
    });

    it('should parse legacy tipi_version as cihub_app_version', () => {
      const { cihub_app_version: _, ...legacyAppInfo } = minimalAppInfo;
      const result = appInfoSchema.safeParse({
        ...legacyAppInfo,
        tipi_version: 3,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cihub_app_version).toBe(3);
      }
    });

    it('should default cihub_app_version to 1 when omitted', () => {
      const { cihub_app_version: _, ...withoutVersion } = minimalAppInfo;
      const result = appInfoSchema.safeParse(withoutVersion);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cihub_app_version).toBe(1);
      }
    });

    it('should parse appInfoSchema without hub_integration', () => {
      const result = appInfoSchema.safeParse(minimalAppInfo);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration).toBeUndefined();
      }
    });
  });
});
