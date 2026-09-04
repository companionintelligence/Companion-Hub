import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HUB_CONTAINER_NAMES, hubContainerName } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { McpServerFactory } from './mcp-server.factory';

/** Idle time before a session is reaped, and how often the reaper runs (ms). */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/**
 * BUG-MCP-1 / REL-MCP-7: owns the live MCP Streamable HTTP sessions (one transport + SDK server per
 * `Mcp-Session-Id`). Extracted from the controller so session state is unit-testable and so the MCP
 * admin surface (ENH-MCP-4) can report the live session count. A periodic reaper drops idle sessions
 * so abandoned SSE streams don't accumulate.
 */
@Injectable()
export class McpSessionRegistry implements OnModuleDestroy {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private readonly serverFactory: McpServerFactory,
    private readonly logger: LoggerService,
  ) {
    this.reaper = setInterval(() => this.reapStaleSessions(), REAP_INTERVAL_MS);
    // Never let the reaper keep the process alive during shutdown.
    this.reaper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.reaper);
    for (const { transport } of this.sessions.values()) {
      // Best-effort close: swallow rejections so shutdown can't die on an unhandledRejection.
      transport.close().catch(() => undefined);
    }
    this.sessions.clear();
  }

  /** Look up an existing session and mark it active. */
  get(sessionId: string): StreamableHTTPServerTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }
    entry.lastActivity = Date.now();
    return entry.transport;
  }

  /**
   * Build a transport for a brand-new session and connect a fresh SDK server to it. The transport is
   * not stored until {@link store} is called (the SDK assigns the session id only while handling the
   * `initialize` request).
   */
  async createConnectedTransport(): Promise<StreamableHTTPServerTransport> {
    const transport = this.buildTransport();
    const server = this.serverFactory.create();
    try {
      await server.connect(transport);
    } catch (error) {
      // Release the half-constructed pair so a failed connect doesn't leak the transport/server.
      transport.close().catch(() => undefined);
      throw error;
    }
    return transport;
  }

  /** Record a transport once its session id has been assigned (after the initialize request). */
  store(transport: StreamableHTTPServerTransport): void {
    if (!transport.sessionId) {
      return;
    }
    this.sessions.set(transport.sessionId, { transport, lastActivity: Date.now() });
    this.logger.info('MCP session created', transport.sessionId);
  }

  /** Terminate and forget a session (client DELETE). The registry entry is removed even when the
   *  transport's close fails — a client-requested teardown must never leave a dead session behind
   *  (the close error still propagates so the caller can log it). */
  async remove(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    try {
      await entry.transport.close();
    } finally {
      this.sessions.delete(sessionId);
      this.logger.info('MCP session terminated', sessionId);
    }
  }

  /** Live session count — surfaced to operators by the MCP admin status endpoint (ENH-MCP-4). */
  get activeSessions(): number {
    return this.sessions.size;
  }

  /**
   * Build a session transport. ISSUE-MCP-2: DNS-rebinding protection (Origin/Host validation) is
   * available but opt-in via MCP_DNS_REBINDING_PROTECTION=true, since the endpoint is already
   * Bearer-key protected and CORS-restricted, and the appliance is reached under several hosts
   * (localhost, the container name, the public domain). When enabled, allowed hosts come from
   * MCP_ALLOWED_HOSTS plus sensible localhost/container defaults.
   */
  private buildTransport(): StreamableHTTPServerTransport {
    const dnsProtection = process.env.MCP_DNS_REBINDING_PROTECTION === 'true';
    const allowedHosts = dnsProtection ? this.resolveAllowedHosts() : undefined;
    return new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: dnsProtection,
      allowedHosts,
      onsessionclosed: (sessionId: string) => {
        this.sessions.delete(sessionId);
        this.logger.info('MCP session closed', sessionId);
      },
    });
  }

  /** Allowed Host header values when DNS-rebinding protection is enabled. Always includes localhost
   *  and container defaults, so the set is never empty; operator-configured domains/hosts are added
   *  on top. Warns when protection is on but no operator hosts were configured, since only the
   *  localhost/container defaults will then be accepted (the appliance's public domain would be
   *  rejected). */
  private resolveAllowedHosts(): string[] {
    const port = process.env.API_PORT || '3000';
    const hosts = new Set<string>();
    // Add a host and — unless it already carries an explicit port (bare `host:port` or IPv6) — its
    // `:<port>` variant, so a bare hostname still matches a `host:<port>` Host header on a non-default
    // port. Applied uniformly to localhost/container defaults, DOMAIN/LOCAL_DOMAIN, and MCP_ALLOWED_HOSTS.
    const addWithPortVariant = (host: string) => {
      hosts.add(host);
      if (!host.includes(':')) {
        hosts.add(`${host}:${port}`);
      }
    };
    for (const base of new Set(['localhost', '127.0.0.1', hubContainerName(), ...HUB_CONTAINER_NAMES])) {
      addWithPortVariant(base);
    }
    let operatorHostConfigured = false;
    for (const domain of [process.env.DOMAIN, process.env.LOCAL_DOMAIN]) {
      const trimmed = domain?.trim();
      if (trimmed) {
        addWithPortVariant(trimmed);
        operatorHostConfigured = true;
      }
    }
    for (const extra of (process.env.MCP_ALLOWED_HOSTS ?? '').split(',')) {
      const trimmed = extra.trim();
      if (trimmed) {
        addWithPortVariant(trimmed);
        operatorHostConfigured = true;
      }
    }
    if (!operatorHostConfigured) {
      this.logger.warn(
        'MCP_DNS_REBINDING_PROTECTION is on but no DOMAIN/LOCAL_DOMAIN/MCP_ALLOWED_HOSTS is configured; ' +
          'only localhost/container defaults will be accepted',
      );
    }
    return [...hosts];
  }

  private reapStaleSessions(): void {
    // NOTE: lastActivity is bumped when a request/stream is opened (get()), not continuously while a
    // server→client GET SSE stream is held open. A session whose only activity is a long-held GET
    // stream would therefore be reaped after SESSION_TTL_MS, closing that stream. This is harmless
    // today because the Hub sends no server-initiated notifications (the GET stream carries no data
    // and clients reconnect transparently). If notification flows are added, refresh lastActivity
    // for the lifetime of an open stream (or skip reaping sessions with an active stream).
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        // Best-effort close: swallow rejections so the reaper can't die on an unhandledRejection.
        entry.transport.close().catch(() => undefined);
        this.sessions.delete(sessionId);
        this.logger.info('MCP session reaped (idle timeout)', sessionId);
      }
    }
  }
}
