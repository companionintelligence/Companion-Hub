import { describe, expect, it } from 'vitest';
import { resolveMcpCommandParts, resolveMcpTemplateString } from '../mcp-command-resolver.js';

describe('resolveMcpTemplateString', () => {
  it('substitutes bare env keys', () => {
    expect(resolveMcpTemplateString('${ALLOWED_PATH}', { ALLOWED_PATH: '/data' })).toBe('/data');
  });

  it('supports shell-default form', () => {
    expect(resolveMcpTemplateString('${ALLOWED_PATH:-/data}', {})).toBe('/data');
    expect(resolveMcpTemplateString('${ALLOWED_PATH:-/data}', { ALLOWED_PATH: '/custom' })).toBe('/custom');
  });

  it('supports ENV: prefix', () => {
    expect(resolveMcpTemplateString('${ENV:N8N_API_URL}', { N8N_API_URL: 'http://n8n:5678' })).toBe('http://n8n:5678');
  });

  it('leaves unresolved placeholders intact', () => {
    expect(resolveMcpTemplateString('${MISSING}', {})).toBe('${MISSING}');
  });
});

describe('resolveMcpCommandParts', () => {
  it('expands command and args', () => {
    expect(
      resolveMcpCommandParts('npx', ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '${ALLOWED_PATH}'], { ALLOWED_PATH: '/data' }),
    ).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '/data']);
  });
});
