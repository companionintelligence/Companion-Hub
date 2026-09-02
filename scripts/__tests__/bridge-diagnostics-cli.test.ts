import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
const parseEnvFile = vi.fn();

/** Ports considered to have a listener on the host. Keeps the suite off the real network. */
let listeningHostPorts = new Set<number>();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

vi.mock('../env-file', () => ({
  parseEnvFile: (...args: unknown[]) => parseEnvFile(...args),
}));

vi.mock('node:net', () => {
  class FakeSocket {
    private handlers = new Map<string, () => void>();
    setTimeout() {}
    destroy() {}
    once(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    }
    connect(port: number) {
      const event = listeningHostPorts.has(port) ? 'connect' : 'error';
      queueMicrotask(() => this.handlers.get(event)?.());
      return this;
    }
  }
  return { default: { Socket: FakeSocket }, Socket: FakeSocket };
});

const { formatBridgeLines, resolveBridgeServices, resolveHubContainerCidr, runBridgeDoctorSection } = await import('../bridge-diagnostics-cli');

/** Route each `docker ...` invocation to a canned result keyed by the first arg. */
function mockDocker(handlers: { inspect?: string; exec?: (script: string) => number; ps?: string }) {
  spawnSync.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'ps') return { status: 0, stdout: handlers.ps ?? '' };
    if (args[0] === 'inspect') return { status: handlers.inspect ? 0 : 1, stdout: handlers.inspect ?? '' };
    if (args[0] === 'exec') {
      const script = String(args[args.length - 1]);
      // The dns lookup probe prints the gateway; the net.connect probe only exits.
      if (script.includes('dns')) return { status: 0, stdout: '172.17.0.1' };
      return { status: handlers.exec ? handlers.exec(script) : 10, stdout: '' };
    }
    return { status: 1, stdout: '' };
  });
}

describe('bridge-diagnostics-cli', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    parseEnvFile.mockReset();
    parseEnvFile.mockReturnValue({});
    listeningHostPorts = new Set();
  });

  describe('resolveBridgeServices', () => {
    it('falls back to stock ports when the env file has none', () => {
      expect(resolveBridgeServices('.env.prod')).toEqual([
        { label: 'Hub API (cloudflared origin)', port: 5002 },
        { label: 'Ollama', port: 11434 },
        { label: 'vLLM', port: 8000 },
        { label: 'Lemonade', port: 13305 },
        { label: 'Speculative inference', port: 8000 },
      ]);
    });

    it('reads ports from the env file, including URL-shaped values', () => {
      parseEnvFile.mockReturnValue({
        API_PORT: '5999',
        OLLAMA_URL: 'http://host.docker.internal:12000',
      });

      const services = resolveBridgeServices('.env.prod');
      expect(services[0]).toEqual({ label: 'Hub API (cloudflared origin)', port: 5999 });
      expect(services[1]).toEqual({ label: 'Ollama', port: 12000 });
    });

    it('falls back when a port is out of range rather than handing net.connect a bad port', () => {
      parseEnvFile.mockReturnValue({ API_PORT: '99999' });
      expect(resolveBridgeServices('.env.prod')[0]).toEqual({ label: 'Hub API (cloudflared origin)', port: 5002 });
    });
  });

  describe('resolveHubContainerCidr', () => {
    it('derives the container network from its address and prefix', () => {
      mockDocker({ inspect: '172.18.0.7/16' });
      expect(resolveHubContainerCidr()).toBe('172.18.0.0/16');
    });

    it('handles a /24 app network', () => {
      mockDocker({ inspect: '10.128.12.5/24' });
      expect(resolveHubContainerCidr()).toBe('10.128.12.0/24');
    });

    it('returns undefined when inspect fails or output is malformed', () => {
      mockDocker({});
      expect(resolveHubContainerCidr()).toBeUndefined();
      mockDocker({ inspect: 'garbage' });
      expect(resolveHubContainerCidr()).toBeUndefined();
    });
  });

  describe('formatBridgeLines', () => {
    it('omits services that are not listening on the host', () => {
      const lines = formatBridgeLines([
        { label: 'Ollama', port: 11434, hostReachable: true, containerReachable: true, verdict: 'ok' },
        { label: 'vLLM', port: 8000, hostReachable: false, containerReachable: false, verdict: 'absent' },
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Ollama');
    });

    it('marks a filtered port as blocked and says it answers on the host', () => {
      const [line] = formatBridgeLines([{ label: 'Ollama', port: 11434, hostReachable: true, containerReachable: false, verdict: 'filtered' }]);
      expect(line).toContain('BLOCKED');
      expect(line).toContain('answers on the host but not from the Hub container');
    });

    // A refusal is an instant RST, so it proves the bridge works. Labelling it
    // BLOCKED would send the operator after a firewall rule that cannot help.
    it('distinguishes a refused port from a filtered one', () => {
      const [line] = formatBridgeLines([{ label: 'Ollama', port: 11434, hostReachable: true, containerReachable: false, verdict: 'refused' }]);
      expect(line).toContain('REFUSED');
      expect(line).toContain('loopback only');
      expect(line).not.toContain('BLOCKED');
    });
  });

  describe('runBridgeDoctorSection', () => {
    it('skips cleanly when the Hub container is not running', async () => {
      mockDocker({ ps: '' });
      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(0);
      expect(section.lines[0]).toContain('Hub container not running');
    });

    it('reports no issues when nothing is listening on the host', async () => {
      // No host listeners → every service is 'absent', so there is nothing to blame.
      mockDocker({ ps: 'ci-os-hub' });
      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(0);
      expect(section.remediationCommands).toEqual([]);
    });

    it('reports ok when the container can reach every listening host service', async () => {
      listeningHostPorts = new Set([11434]);
      mockDocker({ ps: 'ci-os-hub', inspect: '172.18.0.7/16', exec: () => 0 });

      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(0);
      expect(section.lines[0]).toContain('ok');
      expect(section.remediationCommands).toEqual([]);
    });

    // The core case: the service answers on the host but not from the container.
    // That asymmetry is only visible from inside the container, which is why the
    // check exists at all.
    it('flags a host-reachable but container-unreachable port and emits the fix', async () => {
      listeningHostPorts = new Set([11434, 5002]);
      mockDocker({ ps: 'ci-os-hub', inspect: '172.18.0.7/16', exec: () => 10 });

      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(2);
      expect(section.remediationCommands).toEqual([
        'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 5002 proto tcp',
        'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp',
      ]);
      expect(section.lines.join('\n')).toContain('the services themselves are running');
    });

    it('still explains the problem when the rule addresses cannot be derived', async () => {
      listeningHostPorts = new Set([11434]);
      mockDocker({ ps: 'ci-os-hub', exec: () => 10 });

      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(1);
      expect(section.remediationCommands).toEqual([]);
      expect(section.lines.join('\n')).toContain('Allow the Hub container network to reach the host gateway');
    });

    // Regression: a service bound to 127.0.0.1 (Ollama's default) answers the
    // host probe and refuses over the bridge. That is a bind problem, and a ufw
    // rule cannot fix it — so it must not be reported as a firewall block.
    it('reports a loopback-bound service as refused, not as a firewall block', async () => {
      listeningHostPorts = new Set([11434]);
      mockDocker({ ps: 'ci-os-hub', inspect: '172.18.0.7/16', exec: () => 11 });

      const section = await runBridgeDoctorSection('.env.prod');
      const text = section.lines.join('\n');
      expect(section.issueCount).toBe(1);
      expect(section.remediationCommands).toEqual([]);
      expect(text).toContain('bound to loopback');
      expect(text).toContain('OLLAMA_HOST=0.0.0.0');
      expect(text).not.toContain('A host firewall is dropping these');
      expect(text).not.toContain('sudo ufw allow');
    });

    it('points at the missing host-gateway mapping when the name does not resolve', async () => {
      listeningHostPorts = new Set([11434]);
      mockDocker({ ps: 'ci-os-hub', inspect: '172.18.0.7/16', exec: () => 12 });

      const section = await runBridgeDoctorSection('.env.prod');
      expect(section.issueCount).toBe(1);
      expect(section.lines.join('\n')).toContain('extra_hosts');
      expect(section.remediationCommands).toEqual([]);
    });

    // Regression: `docker exec` exits 1 when the daemon rejects the call (the
    // container stopped after the running-check), and node exits 1 on an
    // uncaught exception. Neither tested the bridge, so neither may surface as
    // `filtered` — that is the verdict that tells the operator to open a port.
    it('does not read a failed probe as a firewall block', async () => {
      listeningHostPorts = new Set([11434]);
      mockDocker({ ps: 'ci-os-hub', inspect: '172.18.0.7/16', exec: () => 1 });

      const section = await runBridgeDoctorSection('.env.prod');
      const text = section.lines.join('\n');
      // Counted so the doctor box warns, but reported as unverified rather than
      // blocked — and the header must not claim `ok` for a check that never ran.
      expect(section.issueCount).toBe(1);
      expect(section.lines[0]).toContain('1 unverified');
      expect(section.lines[0]).not.toMatch(/\bok\b/);
      expect(section.remediationCommands).toEqual([]);
      expect(text).toContain('the container probe did not complete');
      expect(text).toContain('they were NOT checked');
      expect(text).not.toContain('A host firewall is dropping these');
      expect(text).not.toContain('sudo ufw allow');
    });
  });
});
