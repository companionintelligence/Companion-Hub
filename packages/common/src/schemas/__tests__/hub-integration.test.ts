import { describe, expect, it } from 'vitest';
import { manifestDefaultsEdgeAuthOn, hubIntegrationSchema } from '../app-info';
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

    it('should accept a valid lowercase issuer_env', () => {
      const result = hubIntegrationSchema.safeParse({ oidc: { issuer_env: 'ci_oidc_issuer' } });
      expect(result.success).toBe(true);
    });

    it('should reject an issuer_path containing whitespace or a newline (env-injection guard)', () => {
      // The composed issuer is written verbatim into app.env; a newline would inject an extra env line.
      expect(hubIntegrationSchema.safeParse({ oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: 'api/auth\nHUB_API_KEY=evil' } }).success).toBe(
        false,
      );
      expect(hubIntegrationSchema.safeParse({ oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api /auth' } }).success).toBe(false);
    });

    it('should accept an issuer_path without a leading slash', () => {
      const result = hubIntegrationSchema.safeParse({ oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: 'api/auth' } });
      expect(result.success).toBe(true);
    });

    it('should leave oidc undefined when not declared', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.oidc).toBeUndefined();
      }
    });
  });

  describe('R-SCH-4: inference env mapping', () => {
    // The mapping is opt-in per variable, so a partial declaration is the normal
    // case — not an edge case. Zod 4 made enum-keyed `z.record` exhaustive, which
    // silently rejected every real manifest and dropped those apps from the store
    // catalog; `z.partialRecord` is what keeps this passing.
    it('should accept a partial mapping declaring only the variables an app consumes', () => {
      const result = hubIntegrationSchema.safeParse({
        inference: {
          llm_base_url: 'LLM_API_BASE',
          llm_api_key: 'LLM_API_KEY',
          chat_model: 'LLM_DEFAULT_CHAT_MODEL',
          embedding_model: 'LLM_DEFAULT_EMBEDDING_MODEL',
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.inference?.chat_model).toBe('LLM_DEFAULT_CHAT_MODEL');
        expect(result.data?.inference?.vision_model).toBeUndefined();
      }
    });

    it('should accept a single-variable mapping', () => {
      const result = hubIntegrationSchema.safeParse({ inference: { ollama_host: 'OLLAMA_HOST' } });
      expect(result.success).toBe(true);
    });

    it('should accept a mapping declaring every inference variable', () => {
      const result = hubIntegrationSchema.safeParse({
        inference: {
          llm_base_url: 'A',
          llm_api_key: 'B',
          chat_model: 'C',
          embedding_model: 'D',
          vision_model: 'E',
          ollama_host: 'F',
          num_ctx: 'G',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept an empty mapping', () => {
      expect(hubIntegrationSchema.safeParse({ inference: {} }).success).toBe(true);
    });

    it('should reject an unknown inference variable name', () => {
      expect(hubIntegrationSchema.safeParse({ inference: { not_a_variable: 'X' } }).success).toBe(false);
    });

    it('should reject an empty env variable name', () => {
      // An empty value would be written to app.env as a nameless key.
      expect(hubIntegrationSchema.safeParse({ inference: { chat_model: '' } }).success).toBe(false);
    });

    it('should leave inference undefined when not declared', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.inference).toBeUndefined();
      }
    });

    it('should accept inference_provider for dual-provider apps', () => {
      const result = hubIntegrationSchema.safeParse({
        inference: {
          llm_base_url: 'APP_OPENAI_COMPATIBLE_URL',
          llm_api_key: 'APP_OPENAI_API_KEY',
          ollama_host: 'APP_OLLAMA_BASE_PATH',
        },
        inference_provider: {
          env: 'APP_LLM_PROVIDER',
          ollama: 'ollama',
          openai_compatible: 'generic-openai',
        },
        llm_base_url_strip_v1: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.inference_provider?.env).toBe('APP_LLM_PROVIDER');
        expect(result.data?.llm_base_url_strip_v1).toBe(true);
      }
    });

    it('should reject inference_provider with an invalid env name', () => {
      expect(
        hubIntegrationSchema.safeParse({
          inference_provider: { env: '1_BAD', ollama: 'ollama', openai_compatible: 'generic-openai' },
        }).success,
      ).toBe(false);
    });
  });

  describe('readiness endpoint (CI-Hub#1556)', () => {
    it('should accept the ci-hermes descriptor and keep every field', () => {
      const result = hubIntegrationSchema.safeParse({
        readiness: { service: 'ci-hermes-gateway', port: 8642, path: '/health/detailed', bearer_env: 'APP_SEED' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.readiness).toEqual({ service: 'ci-hermes-gateway', port: 8642, path: '/health/detailed', bearer_env: 'APP_SEED' });
      }
    });

    it('should default path to /health and leave bearer_env undefined (an unauthenticated probe)', () => {
      const result = hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8080 } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.readiness?.path).toBe('/health');
        expect(result.data?.readiness?.bearer_env).toBeUndefined();
      }
    });

    it('should leave readiness undefined when not declared, so nothing is probed', () => {
      const result = hubIntegrationSchema.safeParse({ mcp_client: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.readiness).toBeUndefined();
      }
    });

    it('should require service and a valid port', () => {
      expect(hubIntegrationSchema.safeParse({ readiness: { port: 8642 } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: '', port: 8642 } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 0 } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 65536 } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 80.5 } }).success).toBe(false);
    });

    it('should reject a service that is a hostname or an authority rather than a compose service name', () => {
      // The bearer is sent to whatever `service` names, so only a shape that can be one of the
      // app's own compose services is allowed; the monitor then checks it against the compose.
      for (const service of ['evil.example.com', 'host.docker.internal', 'ci-memory:8642', 'Gateway', '-gateway', 'gate way', 'a/b', 'gateway.']) {
        expect(hubIntegrationSchema.safeParse({ readiness: { service, port: 8642 } }).success).toBe(false);
      }
      for (const service of ['ci-hermes-gateway', 'gateway', 'db_1', '0api']) {
        expect(hubIntegrationSchema.safeParse({ readiness: { service, port: 8642 } }).success).toBe(true);
      }
    });

    it('should reject a relative path or one containing whitespace (it is interpolated into the probe URL)', () => {
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, path: 'health' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, path: '/health detailed' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, path: '/health\n' } }).success).toBe(false);
    });

    it('should reject a malformed bearer_env (must be a valid env var name)', () => {
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, bearer_env: '' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, bearer_env: '1_BAD' } }).success).toBe(false);
      expect(hubIntegrationSchema.safeParse({ readiness: { service: 'gateway', port: 8642, bearer_env: 'APP SEED' } }).success).toBe(false);
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

    it('should parse appInfoSchema with a partial hub_integration.inference', () => {
      const result = appInfoSchema.safeParse({
        ...minimalAppInfo,
        hub_integration: { inference: { llm_base_url: 'LLM_API_BASE', chat_model: 'LLM_DEFAULT_CHAT_MODEL' } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration?.inference?.llm_base_url).toBe('LLM_API_BASE');
        expect(result.data.hub_integration?.inference?.num_ctx).toBeUndefined();
      }
    });

    it('should parse appInfoSchema with hub_integration.readiness', () => {
      const result = appInfoSchema.safeParse({
        ...minimalAppInfo,
        hub_integration: { readiness: { service: 'ci-hermes-gateway', port: 8642, path: '/health/detailed', bearer_env: 'APP_SEED' } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration?.readiness?.service).toBe('ci-hermes-gateway');
        expect(result.data.hub_integration?.readiness?.bearer_env).toBe('APP_SEED');
      }
    });

    it('should parse legacy cihub_version as cihub_app_version', () => {
      const { cihub_app_version: _, ...legacyAppInfo } = minimalAppInfo;
      const result = appInfoSchema.safeParse({
        ...legacyAppInfo,
        cihub_version: 3,
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

  describe('edge_auth (CI-Engineering#74)', () => {
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

    it('parses an edge_auth default-on declaration', () => {
      const result = appInfoSchema.safeParse({
        ...minimalAppInfo,
        hub_integration: { edge_auth: { default: true } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hub_integration?.edge_auth?.default).toBe(true);
      }
    });

    it('parses default:false and absence harmlessly (both are no-ops, never install-breaking)', () => {
      expect(appInfoSchema.safeParse({ ...minimalAppInfo, hub_integration: { edge_auth: { default: false } } }).success).toBe(true);
      expect(appInfoSchema.safeParse({ ...minimalAppInfo, hub_integration: { edge_auth: {} } }).success).toBe(true);
    });

    describe('manifestDefaultsEdgeAuthOn', () => {
      it('is true only for an exposable app with an explicit default:true', () => {
        expect(manifestDefaultsEdgeAuthOn({ exposable: true, hub_integration: { edge_auth: { default: true } } })).toBe(true);
      });

      it('is false for non-exposable apps, absent blocks, and default:false', () => {
        expect(manifestDefaultsEdgeAuthOn({ exposable: false, hub_integration: { edge_auth: { default: true } } })).toBe(false);
        expect(manifestDefaultsEdgeAuthOn({ exposable: true })).toBe(false);
        expect(manifestDefaultsEdgeAuthOn({ exposable: true, hub_integration: {} })).toBe(false);
        expect(manifestDefaultsEdgeAuthOn({ exposable: true, hub_integration: { edge_auth: {} } })).toBe(false);
        expect(manifestDefaultsEdgeAuthOn({ exposable: true, hub_integration: { edge_auth: { default: false } } })).toBe(false);
      });
    });
  });
});
