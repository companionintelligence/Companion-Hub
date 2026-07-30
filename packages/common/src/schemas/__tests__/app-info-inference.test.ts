import { describe, expect, it } from 'vitest';
import { appInfoSchema, inferenceEnvMappingSchema } from '../app-info.js';

const baseApp = {
  id: 'ci-memory',
  urn: 'ci-memory:ci-marketplace',
  name: 'Companion Memory',
  author: 'Companion Intelligence',
  available: true,
  short_desc: 'Memory appliance',
  description: 'Self-hosted memory',
  categories: ['ai'],
  port: 8642,
  version: '2026.7.27.1',
  source: 'https://github.com/companionintelligence/CI-Server',
  cihub_app_version: 2,
};

describe('inferenceEnvMappingSchema', () => {
  it('accepts a partial mapping (ci-memory style)', () => {
    const parsed = inferenceEnvMappingSchema.safeParse({
      llm_base_url: 'LLM_API_BASE',
      llm_api_key: 'LLM_API_KEY',
      chat_model: 'LLM_DEFAULT_CHAT_MODEL',
      embedding_model: 'LLM_DEFAULT_EMBEDDING_MODEL',
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects unknown inference variable keys', () => {
    const parsed = inferenceEnvMappingSchema.safeParse({
      llm_base_url: 'LLM_API_BASE',
      not_a_real_var: 'X',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('appInfoSchema hub_integration.inference', () => {
  it('parses ci-memory when only a subset of inference vars are declared', () => {
    const parsed = appInfoSchema.safeParse({
      ...baseApp,
      hub_integration: {
        memory: {
          provider: { service: 'gateway', port: 8642 },
        },
        inference: {
          llm_base_url: 'LLM_API_BASE',
          llm_api_key: 'LLM_API_KEY',
          chat_model: 'LLM_DEFAULT_CHAT_MODEL',
          embedding_model: 'LLM_DEFAULT_EMBEDDING_MODEL',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hub_integration?.inference).toEqual({
        llm_base_url: 'LLM_API_BASE',
        llm_api_key: 'LLM_API_KEY',
        chat_model: 'LLM_DEFAULT_CHAT_MODEL',
        embedding_model: 'LLM_DEFAULT_EMBEDDING_MODEL',
      });
    }
  });
});
