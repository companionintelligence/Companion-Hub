import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts is copied to fleet nodes and starts its worker on import. Extract the self-contained
// policy block so these tests exercise the exact shipped implementation without touching Docker.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <qa-route-policy>([\s\S]*?)\/\/ <\/qa-route-policy>/.exec(source);
if (!block) throw new Error('the <qa-route-policy> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const {
  classifyQaRoute,
  scoreReadyQaApp,
  hasKnownProtocolListener,
  acceptsWireProtocolReadiness,
  isKnownWireProtocolEndpoint,
  listenerProbeFailureNote,
  unsupportedHeadlessProbeNote,
  isUnsupportedSilentHeadlessTcp,
  hasValidTcpProcSnapshot,
  tcpListenerFromProcSnapshot,
  isKnownWireProtocolImage,
} = new Function(
  `${js}\nreturn { classifyQaRoute, scoreReadyQaApp, hasKnownProtocolListener, acceptsWireProtocolReadiness, isKnownWireProtocolEndpoint, listenerProbeFailureNote, unsupportedHeadlessProbeNote, isUnsupportedSilentHeadlessTcp, hasValidTcpProcSnapshot, tcpListenerFromProcSnapshot, isKnownWireProtocolImage };`,
)() as {
  classifyQaRoute: (
    config: { no_gui?: boolean; mcp?: unknown },
    compose?: { services?: unknown[] },
  ) => { kind: 'mcp' } | { kind: 'http' } | { kind: 'headless'; port: number } | { kind: 'skip'; reason: string };
  scoreReadyQaApp: (hasScreenshot: boolean, noGui: boolean, backendHealthy: boolean) => 'pass' | 'warn';
  hasKnownProtocolListener: (
    noGui: boolean,
    httpStatus: number,
    listener: 'listening' | 'not-listening' | 'unknown',
    knownWireProtocol: boolean,
    publishedEndpointReachable: boolean,
  ) => boolean;
  acceptsWireProtocolReadiness: (
    httpStatus: number,
    listener: 'listening' | 'not-listening' | 'unknown',
    greeted: boolean,
    knownWireProtocolEndpoint: boolean,
  ) => boolean;
  isKnownWireProtocolEndpoint: (image: string, port: number) => boolean;
  listenerProbeFailureNote: (detail: string) => string;
  unsupportedHeadlessProbeNote: (listener: 'listening' | 'not-listening' | 'unknown', detail: string, port: number) => string;
  isUnsupportedSilentHeadlessTcp: (
    noGui: boolean,
    httpStatus: number,
    listener: 'listening' | 'not-listening' | 'unknown',
    greeted: boolean,
    knownWireProtocol: boolean,
  ) => boolean;
  hasValidTcpProcSnapshot: (output: string) => boolean;
  tcpListenerFromProcSnapshot: (output: string, port: number, reachableAddresses?: string[]) => 'listening' | 'not-listening' | 'unknown';
  isKnownWireProtocolImage: (image: string) => boolean;
};

describe('qa-stream route policy', () => {
  it('keeps GUI apps on the normal HTTP and screenshot lane', () => {
    expect(classifyQaRoute({ no_gui: false })).toEqual({ kind: 'http' });
  });

  it('routes MCP apps to the stdio protocol lane', () => {
    expect(classifyQaRoute({ no_gui: true, mcp: { transport: 'stdio' } })).toEqual({ kind: 'mcp' });
  });

  it('keeps GUI apps on the HTTP lane even if they also declare MCP support', () => {
    expect(classifyQaRoute({ no_gui: false, mcp: { transport: 'stdio' } })).toEqual({ kind: 'http' });
  });

  it('probes a no-GUI service by its main internal port', () => {
    expect(classifyQaRoute({ no_gui: true }, { services: [{ name: 'ci-ha-voice-server', isMain: true, internalPort: 8080 }] })).toEqual({
      kind: 'headless',
      port: 8080,
    });
  });

  it('uses the explicitly marked main service instead of the first compose service', () => {
    expect(
      classifyQaRoute(
        { no_gui: true },
        {
          services: [
            { name: 'database', internalPort: 5432 },
            { name: 'web', isMain: true, internalPort: 8080 },
          ],
        },
      ),
    ).toEqual({ kind: 'headless', port: 8080 });
  });

  it('skips services without a declared probe port', () => {
    expect(classifyQaRoute({ no_gui: true }, { services: [{ name: 'cloudflared' }] })).toEqual({
      kind: 'skip',
      reason: 'no declared main-service probe port',
    });
  });

  it('skips a main service declared UDP-only', () => {
    expect(
      classifyQaRoute(
        { no_gui: true },
        { services: [{ name: 'chrony', isMain: true, internalPort: 123, addPorts: [{ containerPort: 123, udp: true }] }] },
      ),
    ).toEqual({ kind: 'skip', reason: 'main-service port 123 is declared UDP-only' });
  });

  it('tests a dual TCP and UDP service over TCP', () => {
    expect(
      classifyQaRoute(
        { no_gui: true },
        {
          services: [
            {
              name: 'dnsmasq',
              isMain: true,
              internalPort: 53,
              addPorts: [
                { containerPort: 53, udp: true },
                { containerPort: 53, tcp: true },
              ],
            },
          ],
        },
      ),
    ).toEqual({ kind: 'headless', port: 53 });
  });

  it('recognizes a compose UDP port with a variable fallback', () => {
    expect(
      classifyQaRoute(
        { no_gui: true },
        {
          services: [
            {
              name: 'zerotier-one',
              isMain: true,
              internalPort: 9993,
              addPorts: [{ containerPort: '${ZT_PRIMARY_PORT:-9993}', udp: true }],
            },
          ],
        },
      ),
    ).toEqual({ kind: 'skip', reason: 'main-service port 9993 is declared UDP-only' });
  });

  it('skips an internal port shape the runner cannot publish', () => {
    expect(classifyQaRoute({ no_gui: true }, { services: [{ name: 'templated', isMain: true, internalPort: '${PORT:-8080}' }] })).toEqual({
      kind: 'skip',
      reason: 'no declared main-service probe port',
    });
  });
});

describe('ready QA scoring', () => {
  it('passes a healthy headless app without a screenshot', () => {
    expect(scoreReadyQaApp(false, true, true)).toBe('pass');
  });

  it('warns when a GUI app has no screenshot', () => {
    expect(scoreReadyQaApp(false, false, true)).toBe('warn');
  });

  it('warns when the backend is degraded, including for a headless app', () => {
    expect(scoreReadyQaApp(false, true, false)).toBe('warn');
  });

  it('accepts a verified listener promptly only for known headless wire-protocol images', () => {
    expect(hasKnownProtocolListener(true, 0, 'listening', true, true)).toBe(true);
    expect(hasKnownProtocolListener(true, 0, 'listening', true, false)).toBe(false);
    expect(hasKnownProtocolListener(true, 503, 'listening', true, true)).toBe(false);
    expect(hasKnownProtocolListener(true, 0, 'unknown', true, true)).toBe(false);
    expect(hasKnownProtocolListener(true, 0, 'not-listening', true, true)).toBe(false);
    expect(hasKnownProtocolListener(true, 0, 'listening', false, true)).toBe(false);
    expect(hasKnownProtocolListener(false, 0, 'listening', true, true)).toBe(false);
  });

  it('only treats the declared wire-protocol port as an early readiness endpoint', () => {
    expect(isKnownWireProtocolEndpoint('postgres:18.4@sha256:abc', 5432)).toBe(true);
    expect(isKnownWireProtocolEndpoint('mcr.microsoft.com/mssql/server:2022@sha256:abc', 1433)).toBe(true);
    expect(isKnownWireProtocolEndpoint('elasticsearch:9.2@sha256:abc', 9200)).toBe(false);
    expect(isKnownWireProtocolEndpoint('elasticsearch:9.2@sha256:abc', 9300)).toBe(true);
    expect(isKnownWireProtocolEndpoint('quay.io/coreos/etcd:v3.6', 2379)).toBe(false);
  });

  it('does not let a known image listener override an observed HTTP failure', () => {
    expect(acceptsWireProtocolReadiness(0, 'listening', false, true)).toBe(true);
    expect(acceptsWireProtocolReadiness(0, 'listening', true, false)).toBe(true);
    expect(acceptsWireProtocolReadiness(503, 'listening', false, true)).toBe(false);
    expect(acceptsWireProtocolReadiness(0, 'not-listening', true, true)).toBe(false);
    expect(acceptsWireProtocolReadiness(0, 'unknown', false, true)).toBe(false);
  });

  it('preserves a bounded container listener probe diagnostic', () => {
    expect(listenerProbeFailureNote('EPERM while reading /proc/123/net/tcp')).toContain('EPERM');
    expect(listenerProbeFailureNote('x'.repeat(500)).length).toBeLessThanOrEqual(210);
    expect(listenerProbeFailureNote('')).toBe('container listener could not be verified');
    expect(unsupportedHeadlessProbeNote('unknown', 'EPERM reading /proc/123/net/tcp', 5432)).toContain('EPERM');
    expect(unsupportedHeadlessProbeNote('listening', '', 5432)).toContain('TCP listener on :5432 is live');
  });

  it('marks only silent headless protocols without a supported HTTP or wire probe as unsupported', () => {
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'listening', false, false)).toBe(true);
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'unknown', false, false)).toBe(true);
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'unknown', false, true)).toBe(true);
    expect(isUnsupportedSilentHeadlessTcp(true, 500, 'listening', false, false)).toBe(false);
    expect(isUnsupportedSilentHeadlessTcp(true, 503, 'listening', false, true)).toBe(false);
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'not-listening', false, false)).toBe(false);
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'listening', true, false)).toBe(false);
    expect(isUnsupportedSilentHeadlessTcp(true, 0, 'listening', false, true)).toBe(false);
    expect(isUnsupportedSilentHeadlessTcp(false, 0, 'listening', false, false)).toBe(false);
  });

  it('treats missing, unreadable, or incomplete procfs TCP snapshots as unknown', () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    expect(hasValidTcpProcSnapshot(`__PROC__:/proc/net/tcp\n${header}\n`)).toBe(true);
    expect(hasValidTcpProcSnapshot(`__PROC__:/proc/net/tcp6\n${header}\n`)).toBe(true);
    expect(hasValidTcpProcSnapshot('')).toBe(false);
    expect(hasValidTcpProcSnapshot('__PROC__:/proc/net/tcp\n')).toBe(false);
    expect(hasValidTcpProcSnapshot(`__PROC__:/tmp/tcp\n${header}\n`)).toBe(false);
    expect(hasValidTcpProcSnapshot(`__PROC__:/proc/net/tcp\n${header}\n__PROC__:/proc/net/tcp6\n`)).toBe(false);
  });

  it('finds a listening port from the procfs TCP state instead of requiring a shell in the image', () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const listener = '   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345';
    const snapshot = `__PROC__:/proc/net/tcp\n${header}\n${listener}\n`;
    expect(tcpListenerFromProcSnapshot(snapshot, 5432)).toBe('listening');
    expect(tcpListenerFromProcSnapshot(snapshot, 1433)).toBe('not-listening');
    expect(tcpListenerFromProcSnapshot('', 5432)).toBe('unknown');
    const ipv6WildcardListener = listener.replace('00000000:1538', '00000000000000000000000000000000:0599');
    expect(tcpListenerFromProcSnapshot(`__PROC__:/proc/net/tcp6\n${header}\n${ipv6WildcardListener}\n`, 1433)).toBe('unknown');
    expect(tcpListenerFromProcSnapshot(`__PROC__:/proc/net/tcp\n${header}\nmalformed row\n`, 5432)).toBe('not-listening');
  });

  it('does not pass a Docker proxy handshake when the container listener is loopback-only', () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const loopbackListener = '   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345';
    const snapshot = `__PROC__:/proc/net/tcp\n${header}\n${loopbackListener}\n`;
    expect(tcpListenerFromProcSnapshot(snapshot, 5432, ['172.17.0.2'])).toBe('not-listening');
    // Docker can accept the host-side handshake even though the mapped container address cannot reach loopback.
    expect(hasKnownProtocolListener(true, 0, 'not-listening', true, true)).toBe(false);
  });

  it('matches a listener bound to the container IP as well as wildcard binds', () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const containerIpListener = '   0: 020011AC:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345';
    const snapshot = `__PROC__:/proc/net/tcp\n${header}\n${containerIpListener}\n`;
    expect(tcpListenerFromProcSnapshot(snapshot, 5432, ['172.17.0.2'])).toBe('listening');
    expect(tcpListenerFromProcSnapshot(snapshot, 5432, ['172.17.0.3'])).toBe('not-listening');
  });

  it('does not infer published IPv4 reachability from a specific IPv6 listener', () => {
    const header =
      '  sl  local_address                         rem_address                           st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const listener =
      '   0: B80D0120000000000000000002000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345';
    const snapshot = `__PROC__:/proc/net/tcp6\n${header}\n${listener}\n`;
    expect(tcpListenerFromProcSnapshot(snapshot, 5432, ['2001:db8::2'])).toBe('unknown');
    expect(tcpListenerFromProcSnapshot(snapshot, 5432, ['2001:db8::3'])).toBe('unknown');
  });

  it('keeps an IPv6 wildcard listener unknown when the published probe is IPv4', () => {
    const header =
      '  sl  local_address                         rem_address                           st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const listener =
      '   0: 00000000000000000000000000000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345';
    const snapshot = `__PROC__:/proc/net/tcp6\n${header}\n${listener}\n`;
    const state = tcpListenerFromProcSnapshot(snapshot, 5432, ['172.17.0.2']);
    expect(state).toBe('unknown');
    expect(hasKnownProtocolListener(true, 0, state, true, true)).toBe(false);
  });

  it('recognizes SQL Server images as supported silent wire-protocol services', () => {
    expect(isKnownWireProtocolImage('postgres:16')).toBe(true);
    expect(isKnownWireProtocolImage('mcr.microsoft.com/mssql/server:2022-latest')).toBe(true);
    expect(isKnownWireProtocolImage('mcr.microsoft.com/mssql/server@sha256:abc')).toBe(true);
    expect(isKnownWireProtocolImage('microsoft/mssql-server-linux:latest')).toBe(true);
    expect(isKnownWireProtocolImage('ghcr.io/acme/mssql:latest')).toBe(false);
    expect(isKnownWireProtocolImage('ghcr.io/acme/sqlserver:latest')).toBe(false);
    expect(isKnownWireProtocolImage('mcr.microsoft.com/azure-sql-edge:latest')).toBe(false);
    expect(isKnownWireProtocolImage('nginx:latest')).toBe(false);
  });
});

describe('qa-stream wiring', () => {
  it('keeps no-GUI screenshots suppressed and applies the headless score policy', () => {
    expect(source).toContain('classifyQaRoute(config, config.no_gui && !config.mcp ? loadComposeConfig() : undefined)');
    expect(source).toContain('if (SKIP_SCREENSHOT || config.no_gui)');
    expect(source).toContain("if (route.kind === 'headless') result.port = route.port;");
    expect(source).toContain('unsupportedHeadlessTcp && bh.healthy && !deadReason');
    expect(source).toContain('acceptsWireProtocolReadiness(httpStatus, listener, greets, knownSilentEndpoint)');
    expect(source).toContain('hasKnownProtocolListener(true, httpStatus, probe.state, knownSilentEndpoint, publishedEndpointReachable)');
    expect(source).toContain('await tcpAccepts(hostPort, 1000)');
    expect(source).toContain('isKnownWireProtocolEndpoint(imageRef, Number(result.port))');
    expect(source).toContain('if (config.no_gui === true && knownSilentEndpoint) continue;');
    expect(source).toContain('result.notes = unsupportedHeadlessProbeNote(lastListenerState, listenerProbeDetail, Number(result.port));');
    expect(source).toContain('docker inspect ${shq(container)} --format');
    expect(source).toContain('/proc/${pid}/net/');
    expect(source).not.toContain('docker exec ${shq(container)} cat');
    expect(source).toContain('tcpListenerFromProcSnapshot(snapshots.join');
    expect(source).toContain("result.failKind = 'unsupported-probe';");
    expect(source).toContain("result.score = 'skip' as Score;");
    expect(source).toMatch(/scoreReadyQaApp\(result\.hasScreenshot === true,\s*config\.no_gui === true,\s*result\.backendHealthy !== false\)/);
    expect(source).not.toContain("from './qa-route-policy.ts'");
  });
});
