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
  const saved = {
    DOMAIN: process.env.DOMAIN,
    LOCAL_DOMAIN: process.env.LOCAL_DOMAIN,
    MCP_ALLOWED_HOSTS: process.env.MCP_ALLOWED_HOSTS,
    API_PORT: process.env.API_PORT,
  };
  // A distinctive, non-default port so the :port assertions prove the code uses API_PORT (not a
  // hardcoded 3000) and can't falsely pass on a port value leaked from another suite's env.
  const PORT = '7777';

  beforeEach(() => {
    delete process.env.DOMAIN;
    delete process.env.LOCAL_DOMAIN;
    delete process.env.MCP_ALLOWED_HOSTS;
    process.env.API_PORT = PORT;
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
    // The :port variant uses API_PORT, so a non-default-port Host header (domain:<port>) still matches.
    expect(hosts).toContain(`hub.example.com:${PORT}`);
    expect(r.logger.warn).not.toHaveBeenCalled();
  });

  it('includes custom MCP_ALLOWED_HOSTS entries (with :port variants) without warning', () => {
    process.env.MCP_ALLOWED_HOSTS = 'a.example.com, b.example.com';
    const r = makeRegistry();
    const hosts = r.resolveAllowedHosts();
    expect(hosts).toContain('a.example.com');
    expect(hosts).toContain('b.example.com');
    // Bare MCP_ALLOWED_HOSTS entries also get a :API_PORT variant so a non-default-port Host matches.
    expect(hosts).toContain(`a.example.com:${PORT}`);
    expect(hosts).toContain(`b.example.com:${PORT}`);
    expect(r.logger.warn).not.toHaveBeenCalled();
  });

  it('does not append a second port to an MCP_ALLOWED_HOSTS entry that already has one', () => {
    process.env.MCP_ALLOWED_HOSTS = 'c.example.com:8443';
    const r = makeRegistry();
    const hosts = r.resolveAllowedHosts();
    expect(hosts).toContain('c.example.com:8443');
    // No double-port entry like c.example.com:8443:3000.
    expect(hosts.some((h) => h.startsWith('c.example.com:8443:'))).toBe(false);
    expect(r.logger.warn).not.toHaveBeenCalled();
  });
});

describe('McpSessionRegistry.remove', () => {
  it('deregisters the session even when the transport close fails', async () => {
    const r = Object.create(McpSessionRegistry.prototype) as unknown as {
      logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      sessions: Map<string, { transport: { close: ReturnType<typeof vi.fn> }; lastActivity: number }>;
      remove: (sessionId: string) => Promise<void>;
    };
    r.logger = { warn: vi.fn(), info: vi.fn() };
    r.sessions = new Map([['s1', { transport: { close: vi.fn().mockRejectedValue(new Error('teardown failed')) }, lastActivity: 0 }]]);

    // The close error still propagates (the controller logs it), but the entry must be gone: a
    // client-requested teardown must never leave a dead session registered.
    await expect(r.remove('s1')).rejects.toThrow('teardown failed');
    expect(r.sessions.size).toBe(0);
  });
});
