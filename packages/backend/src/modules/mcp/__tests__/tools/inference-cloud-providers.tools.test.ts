import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { CloudProviderStatus } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { MemoryManagerService } from '@/modules/inference/memory-manager.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { InferenceTools } from '../../tools/inference.tools';

// hub_set_cloud_provider can set a base URL. hub_get_cloud_providers reports it the way
// GET /api/inference/cloud-providers does, so an agent can read back what it set.
describe('InferenceTools: hub_get_cloud_providers', () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
    const configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([
      {
        provider: 'openai',
        apiKey: 'sk-saved',
        enabled: true,
        defaultModel: 'gpt-4o',
        baseUrl: 'https://proxy-user:proxy-secret@llm-proxy.example.test/v1',
      },
      { provider: 'anthropic', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://llm-proxy.example.test/anthropic' },
      { provider: 'google', apiKey: 'AIza-saved', enabled: true, defaultModel: 'gemini-2.5-pro' },
    ]);
    const cloudFallback = new CloudFallbackService(mock<LoggerService>(), configuration);
    cloudFallback.onModuleInit();
    new InferenceTools(
      mock<LoggerService>(),
      registry,
      mock<HardwareInspectorService>(),
      mock<MemoryManagerService>(),
      mock<ModelPullerService>(),
      mock<InferenceRouterService>(),
      cloudFallback,
      mock<InferenceBackendRegistry>(),
    ).onModuleInit();
  });

  it('reports a base URL on another server without its password and none for the default', async () => {
    const tool = registry.getTool('hub_get_cloud_providers');
    if (!tool) throw new Error('hub_get_cloud_providers is not registered');

    const providers = (await tool.handler({})) as CloudProviderStatus[];

    expect(providers).toEqual([
      { provider: 'openai', enabled: true, configured: true, defaultModel: 'gpt-4o', baseUrl: 'https://llm-proxy.example.test/v1' },
      { provider: 'anthropic', enabled: true, configured: false, defaultModel: 'claude-opus-4', baseUrl: 'https://llm-proxy.example.test/anthropic' },
      { provider: 'google', enabled: true, configured: true, defaultModel: 'gemini-2.5-pro' },
    ]);
    expect(providers[2]).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(providers)).not.toMatch(/proxy-secret|sk-saved|AIza-saved/);
  });
});
