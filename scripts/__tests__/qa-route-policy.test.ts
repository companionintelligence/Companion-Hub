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
const { classifyQaRoute, scoreReadyQaApp, isUnsupportedSilentHeadlessTcp, hasValidTcpProcSnapshot } = new Function(
  `${js}\nreturn { classifyQaRoute, scoreReadyQaApp, isUnsupportedSilentHeadlessTcp, hasValidTcpProcSnapshot };`,
)() as {
  classifyQaRoute: (
    config: { no_gui?: boolean; mcp?: unknown },
    compose?: { services?: unknown[] },
  ) => { kind: 'mcp' } | { kind: 'http' } | { kind: 'headless'; port: number } | { kind: 'skip'; reason: string };
  scoreReadyQaApp: (hasScreenshot: boolean, noGui: boolean, backendHealthy: boolean) => 'pass' | 'warn';
  isUnsupportedSilentHeadlessTcp: (
    noGui: boolean,
    httpStatus: number,
    listener: 'listening' | 'not-listening' | 'unknown',
    greeted: boolean,
    knownWireProtocol: boolean,
  ) => boolean;
  hasValidTcpProcSnapshot: (output: string) => boolean;
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
});

describe('qa-stream wiring', () => {
  it('keeps no-GUI screenshots suppressed and applies the headless score policy', () => {
    expect(source).toContain('classifyQaRoute(config, config.no_gui && !config.mcp ? loadComposeConfig() : undefined)');
    expect(source).toContain('if (SKIP_SCREENSHOT || config.no_gui)');
    expect(source).toContain("if (route.kind === 'headless') result.port = route.port;");
    expect(source).toContain('unsupportedHeadlessTcp && bh.healthy && !deadReason');
    expect(source).toContain('httpStatus === 0 && listening && (greets || knownWireProtocol)');
    expect(source).toContain('cat "$file" || exit 43');
    expect(source).toContain('[ -e "$file" ]');
    expect(source).toContain('[ -r "$file" ] || exit 44');
    expect(source).toContain('!proc.ok || !hasValidTcpProcSnapshot(proc.out)');
    expect(source).toContain("result.failKind = 'unsupported-probe';");
    expect(source).toContain("result.score = 'skip' as Score;");
    expect(source).toMatch(/scoreReadyQaApp\(result\.hasScreenshot === true,\s*config\.no_gui === true,\s*result\.backendHealthy !== false\)/);
    expect(source).not.toContain("from './qa-route-policy.ts'");
  });
});
