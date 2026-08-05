import { describe, expect, it } from 'vitest';
import { buildMcpInstallSchema, isMcpOptionalOnlyInstall } from '../mcp-install-schema.js';
import type { AppInfo } from '../../schemas/app-info.js';

const n8nLikeInfo = {
  form_fields: [
    { env_variable: 'N8N_API_URL', label: 'n8n API URL', type: 'text' as const, required: false, default: 'http://n8n:5678' },
    { env_variable: 'N8N_API_KEY', label: 'n8n API key', type: 'password' as const, required: false },
  ],
  mcp: {
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'n8n-mcp'],
    env: [{ key: 'N8N_API_URL', label: 'n8n API URL', required: false }],
    tags: ['n8n'],
    manifest: { tools: [{ name: 'tools_documentation' }] },
  },
} satisfies Pick<AppInfo, 'form_fields' | 'mcp'>;

describe('buildMcpInstallSchema', () => {
  it('merges form_fields over mcp.env', () => {
    const schema = buildMcpInstallSchema(n8nLikeInfo);
    expect(schema?.fields.find((f) => f.key === 'N8N_API_URL')?.default).toBe('http://n8n:5678');
    expect(schema?.bridgeable).toBe(true);
    expect(schema?.toolCount).toBe(1);
  });

  it('flags http transport without url as not bridgeable', () => {
    const schema = buildMcpInstallSchema({
      form_fields: [],
      mcp: { transport: 'http', command: 'node', args: [], tags: [] },
    });
    expect(schema?.bridgeable).toBe(false);
    expect(schema?.bridgeWarning).toBeTruthy();
  });
});

describe('isMcpOptionalOnlyInstall', () => {
  it('returns true for n8n-mcp style apps', () => {
    expect(isMcpOptionalOnlyInstall(n8nLikeInfo)).toBe(true);
  });

  it('returns false when a required field exists', () => {
    expect(
      isMcpOptionalOnlyInstall({
        ...n8nLikeInfo,
        form_fields: [{ env_variable: 'PATH', label: 'Path', type: 'text', required: true, default: '/data' }],
      }),
    ).toBe(false);
  });
});
