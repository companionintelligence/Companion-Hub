import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ExposureSyncService } from '../exposure-sync.service';
import { TailscaleServeOwnership } from '../tailscale-serve-ownership';
import { servePermissionCommand, TailscaleService } from '../../tailscale/tailscale.service';
import {
  CORE_6_SERVE_STATUS,
  CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR,
  CORE_17_SERVE_STATUS_BEFORE_REPAIR,
  FZZY_SERVE_STATUS,
  FZZY_SERVE_STATUS_WITH_MANUAL_3081,
  SERVE_CONFIG_DENIED_STDERR,
} from '../../tailscale/__tests__/serve-captures';

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
  Services?: Record<string, unknown>;
};

/** A Private VPN app as `AppsRepository.getApps` returns it, plus the container target Docker reports for it. */
interface PrivateVpnApp {
  appName: string;
  appStoreSlug: string;
  exposureMode: 'tailscale';
  status: string;
  port: number;
  localSubdomain: string | null;
  target: string;
}

function privateVpnApp(appName: string, port: number, target: string): PrivateVpnApp {
  return { appName, appStoreSlug: 'companion', exposureMode: 'tailscale', status: 'running', port, localSubdomain: null, target };
}

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
        MagicDNSSuffix: 'tailxyz.ts.net',
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
        // Like the CLI, `off` only looks under the node's current name.
        if (!this.config.Web?.[listener]) {
          throw Object.assign(new Error(`Command failed: /usr/bin/tailscale ${args.join(' ')}\nerror: handler does not exist`), {
            stderr: 'error: handler does not exist\n',
          });
        }
        delete this.config.Web[listener];
        if (!Object.keys(this.config.Web).some((key) => key.endsWith(`:${port}`))) {
          delete this.config.TCP?.[String(port)];
        }
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
  const savedEnv = {
    API_PORT: process.env.API_PORT,
    PRIVATE_VPN_USER_DISABLED: process.env.PRIVATE_VPN_USER_DISABLED,
    TAILSCALE_SERVE_USER_DISABLED: process.env.TAILSCALE_SERVE_USER_DISABLED,
  };

  beforeEach(() => {
    // The fleet appliances run the Hub in host mode on API_PORT=5002, which is where the captured
    // `Proxy: http://localhost:5002` comes from.
    process.env.API_PORT = '5002';
    delete process.env.PRIVATE_VPN_USER_DISABLED;
    delete process.env.TAILSCALE_SERVE_USER_DISABLED;
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The `TailscaleService` and SSE stand-in of the Hub process the last `buildSync` made. */
  let tailscale: TailscaleService;
  let sse: { emit: ReturnType<typeof vi.fn> };

  /** A fresh Hub process over `tailscaled`; `apps` is read on every pass, so tests can stop an app between passes. */
  function buildSync(tailscaled: FakeHostTailscaled, apps: PrivateVpnApp[] = []): ExposureSyncService {
    tailscale = new TailscaleService();
    sse = { emit: vi.fn() };
    vi.spyOn(tailscale, 'isInstalled').mockResolvedValue(true);
    vi.spyOn(tailscale, 'isSocketAvailable').mockResolvedValue(true);
    vi.spyOn(tailscale as unknown as { execHost: (args: string[]) => Promise<{ stdout: string; stderr: string }> }, 'execHost').mockImplementation(
      async (args: string[]) => tailscaled.run(args),
    );

    const moduleRef = { get: vi.fn((token: unknown) => (token === TailscaleService ? tailscale : null)) };
    const appRepository = { getApps: vi.fn(async () => apps) };
    const dockerReadFacade = {
      getAppNetworkTarget: vi.fn(async (appUrn: string) => {
        const app = apps.find((candidate) => createAppUrn(candidate.appName, candidate.appStoreSlug) === appUrn);
        return app ? { url: app.target } : null;
      }),
    };

    return new ExposureSyncService(
      logger as never,
      appRepository as never,
      {} as never,
      sse as never,
      {} as never,
      {} as never,
      dockerReadFacade as never,
      moduleRef as never,
    );
  }

  it('does not re-run tailscale serve on every pass once the Hub is published (core-6)', async () => {
    const tailscaled = new FakeHostTailscaled('core-6.tailxyz.ts.net', CORE_6_SERVE_STATUS);
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
    const tailscaled = new FakeHostTailscaled('core-17.tailxyz.ts.net', CORE_17_SERVE_STATUS_BEFORE_REPAIR);
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
    expect(tailscaled.serveConfig()).toEqual(JSON.parse(CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('served for bench-1.tailxyz.ts.net but this node is now core-17.tailxyz.ts.net'),
    );

    // The leftover bench-1 listener must not read as missing, or the rename repair becomes a loop.
    await sync.syncTailscaleExposurePublic();
    expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
  });

  it('leaves Tailscale Serve alone when TAILSCALE_SERVE_USER_DISABLED=true and the Hub is already published', async () => {
    process.env.TAILSCALE_SERVE_USER_DISABLED = 'true';
    const tailscaled = new FakeHostTailscaled('core-6.tailxyz.ts.net', CORE_6_SERVE_STATUS);
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([]);
    expect(tailscaled.serveConfig()).toEqual(JSON.parse(CORE_6_SERVE_STATUS));
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('TAILSCALE_SERVE_USER_DISABLED=true'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not republish a renamed node that opted out, but says once why its peers fail TLS', async () => {
    process.env.TAILSCALE_SERVE_USER_DISABLED = 'true';
    // Without the opt-out this state gets a publish, as the rename test shows. An opted-out Hub
    // cannot repair it; it can only say so.
    const tailscaled = new FakeHostTailscaled('core-17.tailxyz.ts.net', CORE_17_SERVE_STATUS_BEFORE_REPAIR);
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([]);
    expect(tailscaled.serveConfig()).toEqual(JSON.parse(CORE_17_SERVE_STATUS_BEFORE_REPAIR));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('only bench-1.tailxyz.ts.net'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sudo tailscale serve --bg --yes --https=443 http://localhost:5002'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('remove TAILSCALE_SERVE_USER_DISABLED'));

    // The operator publishes by hand, as on core-17; a later loss of the entry must warn again.
    tailscaled.run(HUB_PUBLISH);
    await sync.syncTailscaleExposurePublic();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    tailscaled.reset();
    await sync.syncTailscaleExposurePublic();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('publishes the Hub and its Private VPN apps when PRIVATE_VPN_USER_DISABLED=true, which only keeps the sidecar off (CI-Hub#1757)', async () => {
    // Desktop installs wrote this on every start without a Tailscale key, and fleet nodes set it to
    // stop the sidecar's crash loop. Neither means "leave Tailscale Serve alone".
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    const tailscaled = new FakeHostTailscaled('laptop.tailxyz.ts.net', '{}');
    const sync = buildSync(tailscaled, [privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001')]);

    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([['serve', '--bg', '--yes', '--https=3001', 'http://172.18.0.10:3001'], HUB_PUBLISH]);
    expect(tailscaled.serveConfig().Web?.['laptop.tailxyz.ts.net:3001']).toEqual({ Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('turned off'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('publishes and removes nothing, apps included, when TAILSCALE_SERVE_USER_DISABLED=true', async () => {
    const apps = [privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001')];
    const tailscaled = new FakeHostTailscaled('laptop.tailxyz.ts.net', '{}');
    const sync = buildSync(tailscaled, apps);
    await sync.syncTailscaleExposurePublic();
    const published = tailscaled.serveConfig();
    const writesBefore = tailscaled.writes.length;

    // Once the operator opts out, a stopped app keeps the listener the Hub gave it, and a new
    // Private VPN app gets none.
    process.env.TAILSCALE_SERVE_USER_DISABLED = 'true';
    apps[0].status = 'stopped';
    apps.push(privateVpnApp('open-webui', 3002, 'http://172.18.0.11:8080'));
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes.slice(writesBefore)).toEqual([]);
    expect(tailscaled.serveConfig()).toEqual(published);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('TAILSCALE_SERVE_USER_DISABLED=true'));
  });

  it('logs the operator refusal once with the command that fixes it, instead of the CLI error every five minutes', async () => {
    const withStaleAppListener = JSON.stringify({
      Web: { 'beta-ms-a2.tailxyz.ts.net:3001': { Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } } },
    });
    const tailscaled = new FakeHostTailscaled('beta-ms-a2.tailxyz.ts.net', withStaleAppListener);
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
    const tailscaled = new FakeHostTailscaled('beta-nas.tailxyz.ts.net', '{}');
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

  describe("tells the Hub's pages when tailscaled refuses its changes (CI-Hub#1766)", () => {
    const servePermissionEvents = () => sse.emit.mock.calls.filter(([, data]) => data.event === 'tailscale_serve_permission').map(([, data]) => data);

    it('records the refusal with the command that ends it and when it began, and tells open pages once', async () => {
      const tailscaled = new FakeHostTailscaled('beta-nas.tailxyz.ts.net', '{}');
      tailscaled.deniesServeWrites = true;
      const sync = buildSync(tailscaled, [privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001')]);

      await sync.syncTailscaleExposurePublic();
      const first = tailscale.getServePermission();
      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(first).toEqual({ denied: true, remedy: servePermissionCommand(), deniedSince: expect.any(String) });
      expect(Number.isNaN(Date.parse(first.deniedSince ?? ''))).toBe(false);
      // Later refusals are the same refusal: it still began on the first pass.
      expect(tailscale.getServePermission()).toEqual(first);
      expect(servePermissionEvents()).toEqual([{ event: 'tailscale_serve_permission', denied: true }]);
    });

    it('clears it once a publish goes through, and tells open pages', async () => {
      const tailscaled = new FakeHostTailscaled('beta-nas.tailxyz.ts.net', '{}');
      tailscaled.deniesServeWrites = true;
      const sync = buildSync(tailscaled);
      await sync.syncTailscaleExposurePublic();

      // Someone runs the command on the host.
      tailscaled.deniesServeWrites = false;
      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(tailscale.getServePermission()).toEqual({ denied: false, remedy: null, deniedSince: null });
      expect(servePermissionEvents()).toEqual([
        { event: 'tailscale_serve_permission', denied: true },
        { event: 'tailscale_serve_permission', denied: false },
      ]);
    });

    it('clears it when the only write a pass makes is a removal', async () => {
      // The Hub is published already, so removing the stopped app's listener is the pass's only write.
      const config = JSON.parse(CORE_6_SERVE_STATUS) as ServeConfig;
      config.Web = { ...config.Web, 'core-6.tailxyz.ts.net:3001': { Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } } };
      const tailscaled = new FakeHostTailscaled('core-6.tailxyz.ts.net', JSON.stringify(config));
      tailscaled.deniesServeWrites = true;
      const ownership = await new TailscaleServeOwnership().load();
      ownership.record(3001, 'http://172.18.0.10:3001');
      await ownership.save();
      const sync = buildSync(tailscaled);
      await sync.syncTailscaleExposurePublic();
      expect(tailscale.getServePermission().denied).toBe(true);

      tailscaled.deniesServeWrites = false;
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes.at(-1)).toEqual(['serve', '--https=3001', 'off']);
      expect(tailscale.getServePermission().denied).toBe(false);
      expect(servePermissionEvents().map(({ denied }) => denied)).toEqual([true, false]);
    });

    it('records nothing while tailscaled accepts every write', async () => {
      const tailscaled = new FakeHostTailscaled('beta-nas.tailxyz.ts.net', '{}');
      const sync = buildSync(tailscaled, [privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001')]);

      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes).toHaveLength(2);
      expect(tailscale.getServePermission().denied).toBe(false);
      expect(servePermissionEvents()).toEqual([]);
    });
  });

  it('reports a refused leftover-listener removal once when the Hub itself is already published', async () => {
    // The Hub entry needs no write, so the only write in the pass is the cleanup; before, that
    // refusal was logged by the cleanup on every pass even though the publish path went quiet.
    const config = JSON.parse(CORE_6_SERVE_STATUS) as ServeConfig;
    config.Web = { ...config.Web, 'core-6.tailxyz.ts.net:3001': { Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } } };
    const tailscaled = new FakeHostTailscaled('core-6.tailxyz.ts.net', JSON.stringify(config));
    tailscaled.deniesServeWrites = true;
    // The Hub published :3001 for an app that has since stopped, so the listener is its to remove.
    const ownership = await new TailscaleServeOwnership().load();
    ownership.record(3001, 'http://172.18.0.10:3001');
    await ownership.save();
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    const unserve3001 = ['serve', '--https=3001', 'off'];
    expect(tailscaled.writes).toEqual([unserve3001, unserve3001, unserve3001]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tailscale set --operator='));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a rename once while tailscaled keeps refusing the republish (core-17 before its operator was set)', async () => {
    const tailscaled = new FakeHostTailscaled('core-17.tailxyz.ts.net', CORE_17_SERVE_STATUS_BEFORE_REPAIR);
    tailscaled.deniesServeWrites = true;
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    expect(tailscaled.writes).toEqual([HUB_PUBLISH, HUB_PUBLISH, HUB_PUBLISH]);
    expect(logger.info.mock.calls.filter(([line]) => String(line).includes('served for bench-1'))).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a listener under the pre-rename name alone, which tailscale serve off cannot reach', async () => {
    const config = JSON.parse(CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR) as ServeConfig;
    config.Web = { ...config.Web, 'bench-1.tailxyz.ts.net:3001': { Handlers: { '/': { Proxy: 'http://172.18.0.10:3001' } } } };
    const tailscaled = new FakeHostTailscaled('core-17.tailxyz.ts.net', JSON.stringify(config));
    const sync = buildSync(tailscaled);

    await sync.syncTailscaleExposurePublic();
    await sync.syncTailscaleExposurePublic();

    // Trying would fail with `handler does not exist` on every pass and change nothing.
    expect(tailscaled.writes).toEqual([]);
  });

  describe('removes only the listeners the Hub published', () => {
    const FZZY = 'fzzy.example.ts.net';
    const UNSERVE_3001 = ['serve', '--https=3001', 'off'];

    it("leaves someone else's listener in place (fzzy, where a manual :3081 was gone 84 seconds later)", async () => {
      const tailscaled = new FakeHostTailscaled(FZZY, FZZY_SERVE_STATUS_WITH_MANUAL_3081);
      const sync = buildSync(tailscaled);

      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes).toEqual([]);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS_WITH_MANUAL_3081));
    });

    it('leaves Tailscale Services in place, since the Hub no longer creates any', async () => {
      // Hand-written in the shape of ipn.ServiceConfig; not captured from a host.
      const config = JSON.parse(FZZY_SERVE_STATUS) as ServeConfig;
      config.Services = {
        'svc:grafana': {
          TCP: { '443': { HTTPS: true } },
          Web: { 'grafana.tailxyz.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:3000' } } } },
        },
      };
      const tailscaled = new FakeHostTailscaled(FZZY, JSON.stringify(config));
      const sync = buildSync(tailscaled);

      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('removes the listener it published for an app once the app stops, and nothing else', async () => {
      const app = privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001');
      const tailscaled = new FakeHostTailscaled(FZZY, FZZY_SERVE_STATUS_WITH_MANUAL_3081);
      const sync = buildSync(tailscaled, [app]);

      await sync.syncTailscaleExposurePublic();
      expect(tailscaled.writes).toEqual([['serve', '--bg', '--yes', '--https=3001', 'http://172.18.0.10:3001']]);

      app.status = 'stopped';
      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes.slice(1)).toEqual([UNSERVE_3001]);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS_WITH_MANUAL_3081));
    });

    it("still removes a stopped app's listener after the Hub restarts", async () => {
      const apps = [privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001')];
      const tailscaled = new FakeHostTailscaled(FZZY, FZZY_SERVE_STATUS);
      await buildSync(tailscaled, apps).syncTailscaleExposurePublic();

      apps[0].status = 'stopped';
      await buildSync(tailscaled, apps).syncTailscaleExposurePublic();

      expect(tailscaled.writes.at(-1)).toEqual(UNSERVE_3001);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS));
    });

    it('lets go of a port once someone else serves something else on it', async () => {
      const app = privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001');
      const tailscaled = new FakeHostTailscaled(FZZY, FZZY_SERVE_STATUS);
      const sync = buildSync(tailscaled, [app]);
      await sync.syncTailscaleExposurePublic();

      app.status = 'stopped';
      tailscaled.run(['serve', '--bg', '--yes', '--https=3001', 'http://127.0.0.1:9000']);
      const writesBefore = tailscaled.writes.length;
      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes.slice(writesBefore)).toEqual([]);
      expect(tailscaled.serveConfig().Web?.[`${FZZY}:3001`]).toEqual({ Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } });
    });

    it('keeps retrying the removal while tailscaled fails it', async () => {
      const app = privateVpnApp('anything-llm', 3001, 'http://172.18.0.10:3001');
      const tailscaled = new FakeHostTailscaled(FZZY, FZZY_SERVE_STATUS);
      const sync = buildSync(tailscaled, [app]);
      await sync.syncTailscaleExposurePublic();

      app.status = 'stopped';
      const run = tailscaled.run.bind(tailscaled);
      const failOff = vi.spyOn(tailscaled, 'run').mockImplementation((args) => {
        if (args.at(-1) === 'off') {
          tailscaled.calls.push(args);
          throw new Error('Command failed: tailscale serve --https=3001 off\ncontext deadline exceeded');
        }
        return run(args);
      });
      await sync.syncTailscaleExposurePublic();
      failOff.mockRestore();
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.calls.filter((args) => args.join(' ') === UNSERVE_3001.join(' '))).toHaveLength(2);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS));
    });

    it('still takes back :443 for the Hub when someone points it elsewhere', async () => {
      const config = JSON.parse(FZZY_SERVE_STATUS) as ServeConfig;
      config.Web = { [`${FZZY}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } };
      const tailscaled = new FakeHostTailscaled(FZZY, JSON.stringify(config));
      const sync = buildSync(tailscaled);

      await sync.syncTailscaleExposurePublic();
      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS));
    });

    it("still keeps an app configured on :443 off the Hub's entry", async () => {
      const tailscaled = new FakeHostTailscaled(FZZY, '{}');
      const sync = buildSync(tailscaled, [privateVpnApp('clashing-app', 443, 'http://172.18.0.10:443')]);

      await sync.syncTailscaleExposurePublic();

      expect(tailscaled.writes).toEqual([HUB_PUBLISH]);
      expect(tailscaled.serveConfig()).toEqual(JSON.parse(FZZY_SERVE_STATUS));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('port 443 is reserved'));
    });
  });
});
