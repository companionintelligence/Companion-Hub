import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExposureSyncService } from '../exposure-sync.service';
import { TailscaleService } from '../../tailscale/tailscale.service';
import {
  CORE_6_SERVE_STATUS,
  CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR,
  CORE_17_SERVE_STATUS_BEFORE_REPAIR,
  SERVE_CONFIG_DENIED_STDERR,
} from '../../tailscale/__tests__/serve-captures';

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
};

/**
 * A host tailscaled, reduced to what the Private VPN sync touches.
 *
 * `serve status --json` returns the fleet captures verbatim, and a `serve` write adds a listener
 * under the node's current name the way the CLI does, so the real `TailscaleService` parser and
 * the real sync run against the output shape the appliances produce.
 */
class FakeHostTailscaled {
  readonly writes: string[][] = [];
  readonly calls: string[][] = [];
  deniesServeWrites = false;
  private config: ServeConfig;

  constructor(
    private readonly selfDnsName: string,
    serveStatusJson: string,
  ) {
    this.config = JSON.parse(serveStatusJson) as ServeConfig;
  }

  /** What `tailscale serve reset` leaves behind. */
  reset(): void {
    this.config = {};
  }

  serveConfig(): ServeConfig {
    return JSON.parse(JSON.stringify(this.config)) as ServeConfig;
  }

  run(args: string[]): { stdout: string; stderr: string } {
    this.calls.push(args);
    const [verb, ...rest] = args;

    if (verb === 'version') {
      return { stdout: '1.102.3\n', stderr: '' };
    }
    if (verb === 'status' && rest[0] === '--json') {
      const stdout = JSON.stringify({
        Version: '1.102.3',
        BackendState: 'Running',
        Self: { HostName: this.selfDnsName.split('.')[0], DNSName: `${this.selfDnsName}.`, TailscaleIPs: ['100.64.0.17'] },
        CertDomains: [this.selfDnsName],
        MagicDNSSuffix: 'capybara-ulmer.ts.net',
      });
      return { stdout, stderr: '' };
    }
    if (verb === 'serve' && rest[0] === 'status' && rest[1] === '--json') {
      return { stdout: JSON.stringify(this.config, null, 2), stderr: '' };
    }
    if (verb === 'serve') {
      this.writes.push(args);
      if (this.deniesServeWrites) {
        throw Object.assign(new Error(`Command failed: /usr/bin/tailscale ${args.join(' ')}\n${SERVE_CONFIG_DENIED_STDERR}`), {
          stderr: SERVE_CONFIG_DENIED_STDERR,
        });
      }
      const port = rest.find((arg) => arg.startsWith('--https='))?.slice('--https='.length);
      const listener = `${this.selfDnsName}:${port}`;
      if (rest.at(-1) === 'off') {
        delete this.config.Web?.[listener];
      } else {
        this.config.TCP = { ...this.config.TCP, [String(port)]: { HTTPS: true } };
        this.config.Web = { ...this.config.Web, [listener]: { Handlers: { '/': { Proxy: rest.at(-1) } } } };
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected tailscale ${args.join(' ')}`);
  }
}

describe('Private VPN exposure sync against real tailscale serve output', () => {
  const HUB_PUBLISH = ['serve', '--bg', '--yes', '--https=443', 'http://localhost:5002'];

  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  const savedEnv = { API_PORT: process.env.API_PORT, PRIVATE_VPN_USER_DISABLED: process.env.PRIVATE_VPN_USER_DISABLED };

  beforeEach(() => {
    // The fleet appliances run the Hub in host mode on API_PORT=5002, which is where the captured
    // `Proxy: http://localhost:5002` comes from.
    process.env.API_PORT = '5002';
    delete process.env.PRIVATE_VPN_USER_DISABLED;
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function buildSync(tailscaled: FakeHostTailscaled): ExposureSyncService {
    const tailscale = new TailscaleService();
    vi.spyOn(tailscale, 'isInstalled').mockResolvedValue(true);
    vi.spyOn(tailscale, 'isSocketAvailable').mockResolvedValue(true);
    vi.spyOn(tailscale as unknown as { execHost: (args: string[]) => Promise<{ stdout: string; stderr: string }> }, 'execHost').mockImplementation(
      async (args: string[]) => tailscaled.run(args),
    );

    const moduleRef = { get: vi.fn((token: unknown) => (token === TailscaleService ? tailscale : null)) };
    const appRepository = { getApps: vi.fn().mockResolvedValue([]) };

    return new ExposureSyncService(
      logger as never,
      appRepository as never,
      {} as never,
      { emit: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      moduleRef as never,
    );
  }

  it('does not re-run tailscale serve on every pass once the Hub is published (core-6)', async () => {
    const tailscaled = new FakeHostTailscaled('core-6.capybara-ulmer.ts.net', CORE_6_SERVE_STATUS);
    const sync = buildSync(tailscaled);

    // Three passes stand in for fifteen minutes of the exposure poll.
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.calls.filter((args) => args.join(' ') === 'serve status --json')).toHaveLength(3);
    expect(tailscaled.writes).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('republishes the Hub under the new name after a tailnet rename, as the operator had to by hand on core-17', async () => {
    const tailscaled = new FakeHostTailscaled('core-17.capybara-ulmer.ts.net', CORE_17_SERVE_STATUS_BEFORE_REPAIR);
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
    expect(tailscaled.serveConfig()).toEqual(JSON.parse(CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('served for bench-1.capybara-ulmer.ts.net but this node is now core-17.capybara-ulmer.ts.net'),
    );

    // The leftover bench-1 listener must not read as missing, or the rename repair becomes a loop.
    await sync.syncTailscaleExposurePublic();
    expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
  });

  it('leaves Tailscale Serve alone when PRIVATE_VPN_USER_DISABLED=true (core-17, beta-ms-a2, beta-nas)', async () => {
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    // Without the opt-out this state gets a publish, as the rename test shows.
    const tailscaled = new FakeHostTailscaled('core-17.capybara-ulmer.ts.net', CORE_17_SERVE_STATUS_BEFORE_REPAIR);
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.calls).toEqual([]);
    expect(tailscaled.serveConfig()).toEqual(JSON.parse(CORE_17_SERVE_STATUS_BEFORE_REPAIR));
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('PRIVATE_VPN_USER_DISABLED=true'));
  });

  it('logs the operator refusal once with the command that fixes it, instead of the CLI error every five minutes', async () => {
    const withStaleAppListener = JSON.stringify({
      Web: { 'beta-ms-a2.capybara-ulmer.ts.net:3001': { Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } } },
    });
    const tailscaled = new FakeHostTailscaled('beta-ms-a2.capybara-ulmer.ts.net', withStaleAppListener);
    tailscaled.deniesServeWrites = true;
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('serve config denied'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sudo tailscale set --operator='));
    expect(logger.error).not.toHaveBeenCalled();
    // One publish attempt per pass and no `off` for the stale :3001 listener, which tailscaled
    // would refuse the same way.
    expect(tailscaled.writes).toEqual([HUB_PUBLISH, HUB_PUBLISH, HUB_PUBLISH]);
  });

  it('warns again if the refusal returns after a publish has succeeded', async () => {
    const tailscaled = new FakeHostTailscaled('beta-nas.capybara-ulmer.ts.net', '{}');
    tailscaled.deniesServeWrites = true;
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The operator runs the suggested command, and the next pass publishes.
    tailscaled.deniesServeWrites = false;
    await sync.syncTailscaleExposurePublic();
    expect(tailscaled.writes).toHaveLength(2);

    // Someone later resets Serve and removes the operator role; that regression must be visible.
    tailscaled.reset();
    tailscaled.deniesServeWrites = true;
    await sync.syncTailscaleExposurePublic();

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
