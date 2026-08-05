import { describe, expect, it } from 'vitest';
import { inferMcpLaunchMode } from '../mcp-launch.js';

describe('inferMcpLaunchMode', () => {
  it('returns host_docker for docker run commands', () => {
    expect(inferMcpLaunchMode(['docker', 'run', '-i', '--rm', 'image:tag'])).toBe('host_docker');
  });

  it('returns container_exec for in-container commands', () => {
    expect(inferMcpLaunchMode(['npx', '-y', 'n8n-mcp'])).toBe('container_exec');
    expect(inferMcpLaunchMode(['uvx', 'mcp-server-fetch'])).toBe('container_exec');
  });
});
