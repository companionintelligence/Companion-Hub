import { describe, expect, it } from 'vitest';
import { runStdioMcpHandshake } from '../mcp-handshake';

describe('runStdioMcpHandshake', () => {
  it('is exported for QA and runtime reuse', () => {
    expect(typeof runStdioMcpHandshake).toBe('function');
  });

  it('times out when docker args are invalid', async () => {
    const result = await runStdioMcpHandshake(['exec', '-i', 'nonexistent-container-xyz', 'echo'], {}, 500);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  }, 10_000);
});
