import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSessionRegistry } from '../mcp-session.registry';

// ISSUE-MCP-2: resolveAllowedHosts() always returns localhost/container defaults (never empty), so
// the old "no allowed hosts resolved" warning was dead code. The warning is now reachable and
// meaningful: it fires only when DNS-rebinding protection is on but the operator configured no
// DOMAIN/LOCAL_DOMAIN/MCP_ALLOWED_HOSTS (so only the defaults will be accepted). We call the private
// resolver on a bare instance to avoid the SDK transport + timers the constructor would spin up.

function makeRegistry() {
  const r = Object.create(McpSessionRegistry.prototype) as unknown as {
    logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
    resolveAllowedHosts: () => string[];
  };
  r.logger = { warn: vi.fn(), info: vi.fn() };
  return r;
}

describe('McpSessionRegistry.resolveAllowedHosts', () => {
  const saved = { DOMAIN: process.env.DOMAIN, LOCAL_DOMAIN: process.env.LOCAL_DOMAIN, MCP_ALLOWED_HOSTS: process.env.MCP_ALLOWED_HOSTS };

  beforeEach(() => {
    delete process.env.DOMAIN;
    delete process.env.LOCAL_DOMAIN;
    delete process.env.MCP_ALLOWED_HOSTS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('always includes localhost defaults and warns when no operator hosts are configured', () => {
    const r = makeRegistry();
    const hosts = r.resolveAllowedHosts();
    expect(hosts).toContain('localhost');
    expect(hosts).toContain('127.0.0.1');
    expect(hosts.length).toBeGreaterThan(0);
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('MCP_DNS_REBINDING_PROTECTION'));
  });

  it('does not warn when an operator host is configured, and includes it with a :port variant', () => {
    process.env.DOMAIN = 'hub.example.com';
    const r = makeRegistry();
    const hosts = r.resolveAllowedHosts();
    expect(hosts).toContain('hub.example.com');
    // A :port variant is added so a non-default-port Host header (domain:<port>) still matches.
    expect(hosts.some((h) => h.startsWith('hub.example.com:'))).toBe(true);
    expect(r.logger.warn).not.toHaveBeenCalled();
  });

  it('includes custom MCP_ALLOWED_HOSTS entries without warning', () => {
    process.env.MCP_ALLOWED_HOSTS = 'a.example.com, b.example.com';
    const r = makeRegistry();
    const hosts = r.resolveAllowedHosts();
    expect(hosts).toContain('a.example.com');
    expect(hosts).toContain('b.example.com');
    expect(r.logger.warn).not.toHaveBeenCalled();
  });
});
