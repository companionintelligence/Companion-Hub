import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findManagedAppProjects,
  HUB_STACK_PROJECT_NAMES,
  getDesktopTunnelDir,
  getHubStateDirs,
  isCloudflaredTunnelToken,
  isRelatedVolume,
  isWithinPath,
  parseNames,
  planAppTeardown,
  removeManagedAppProjects,
  runHubCleanup,
} from '../hub-cleanup-lib';

type FakeDockerObject = { name: string; labels: Record<string, string>; networks?: string[] };

/**
 * A Docker engine the cleanup code can list from and remove from. Filters and `--format` templates
 * behave as Docker's do for the cases used here: every `label=` filter must match, any one
 * `network=` filter may, and `{{.Labels}}` joins each `key=value` with a comma without escaping a
 * comma inside a value. A container's ID is its name.
 */
function fakeDockerEngine(world: { containers: FakeDockerObject[]; networks?: FakeDockerObject[]; volumes?: FakeDockerObject[] }) {
  const calls: string[] = [];
  const filtersOf = (args: string[]) => args.filter((_arg, index) => args[index - 1] === '--filter');
  const formatOf = (args: string[]) => (args.includes('--format') ? args[args.indexOf('--format') + 1] : undefined);
  const hasLabel = (labels: Record<string, string>, filter: string) => {
    const eq = filter.indexOf('=');
    return eq === -1 ? filter in labels : labels[filter.slice(0, eq)] === filter.slice(eq + 1);
  };
  const matches = (item: FakeDockerObject, filters: string[]) => {
    const values = (key: string) => filters.filter((filter) => filter.startsWith(`${key}=`)).map((filter) => filter.slice(key.length + 1));
    const networks = values('network');
    return (
      values('label').every((label) => hasLabel(item.labels, label)) &&
      values('name').every((part) => item.name.includes(part)) &&
      (networks.length === 0 || networks.some((network) => item.networks?.includes(network)))
    );
  };
  const render = (template: string, item: FakeDockerObject) =>
    template
      .replaceAll('{{.Names}}', item.name)
      .replaceAll('{{.Name}}', item.name)
      .replaceAll('{{.ID}}', item.name)
      .replaceAll(
        '{{.Labels}}',
        Object.entries(item.labels)
          .map(([key, value]) => `${key}=${value}`)
          .join(','),
      )
      .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_match, key: string) => item.labels[key] ?? '');
  const list = (items: FakeDockerObject[], args: string[], quiet: string) =>
    items
      .filter((item) => matches(item, filtersOf(args)))
      .map((item) => render(formatOf(args) ?? quiet, item))
      .join('\n');

  const docker = (args: string[]) => {
    calls.push(args.join(' '));
    const [command, sub] = args;
    if (command === 'ps') return { ok: true, stdout: list(world.containers, args, '{{.ID}}') };
    if (command === 'network' && sub === 'ls') return { ok: true, stdout: list(world.networks ?? [], args, '{{.Name}}') };
    if (command === 'volume' && sub === 'ls') return { ok: true, stdout: list(world.volumes ?? [], args, '{{.Name}}') };
    if (command === 'inspect' && formatOf(args) === '{{.Image}}') return { ok: true, stdout: `sha256:image-of-${args[args.length - 1]}` };
    return { ok: true, stdout: '' };
  };
  const removals = () => calls.filter((call) => /^(rm |network rm |volume rm |image rm )/.test(call));
  return { docker, calls, removals };
}

function withXdgHome<T>(home: string, run: () => T): T {
  const saved = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_DATA_HOME = `${home}/.local/share`;
  process.env.XDG_CONFIG_HOME = `${home}/.config`;
  process.env.XDG_CACHE_HOME = `${home}/.cache`;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('hub-cleanup-lib', () => {
  it('isWithinPath handles trailing separators on basePath and targetPath', () => {
    // basePath with trailing slash must not produce a // double-separator mismatch
    expect(isWithinPath('/home/user/work', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user/', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user/work', '/home/user', 'linux')).toBe(true);
    // unrelated path must still return false
    expect(isWithinPath('/tmp/other', '/home/user/', 'linux')).toBe(false);
  });

  it('matches known Hub volume naming patterns', () => {
    expect(isRelatedVolume('ci_hub_pgdata')).toBe(true);
    expect(isRelatedVolume('ci_hub_app_data')).toBe(true);
    expect(isRelatedVolume('hub_tailscale_state')).toBe(true);
    expect(isRelatedVolume('ci-os-hub_test_data')).toBe(true);
    expect(isRelatedVolume('ci_os_hub-prod_db_data')).toBe(true);
    expect(isRelatedVolume('runcihub_media_data')).toBe(true);
    expect(isRelatedVolume('runcihub_media')).toBe(true);
    // `runtipi_*` is the prefix appliances actually created. #1143 (c88a83580) renamed the
    // matcher to `runcihub_` by substring, so uninstall stopped seeing real volumes and
    // silently left them behind. A volume name is fixed at create time — match both.
    expect(isRelatedVolume('runtipi_media_data')).toBe(true);
    expect(isRelatedVolume('runtipi_media')).toBe(true);
    expect(isRelatedVolume('postgres_data')).toBe(false);
    expect(isRelatedVolume('anotherstack_prod_data')).toBe(false);
  });

  it('treats runtipi and runcihub as Hub stack projects, not marketplace apps', () => {
    const projects = findManagedAppProjects((args) =>
      args.includes('label=ci-os-hub.managed=true') ? ['runtipi', 'runcihub', 'ci-memory_ci-marketplace'] : [],
    );

    expect(projects).toEqual(['ci-memory_ci-marketplace']);
  });

  it('cleans up every compose project name the Hub stack has ever used', () => {
    expect([...HUB_STACK_PROJECT_NAMES]).toEqual(['ci-os-hub', 'ci-hub', 'runtipi', 'runcihub']);
  });

  it('parses newline-delimited names', () => {
    expect(parseNames('one\n\n two \n')).toEqual(['one', 'two']);
  });

  it('reads each managed container project label once, and drops names Docker would not accept', () => {
    const calls: string[] = [];
    const projects = findManagedAppProjects((args) => {
      calls.push(args.join(' '));
      return args.includes('label=ci-hub.managed=true')
        ? ['ci-hub', 'ci-memory_ci-marketplace', 'ci-memory_ci-marketplace', '$(touch /tmp/x)']
        : ['ci-memory_ci-marketplace', 'ci-openclaw_ci-marketplace', 'runcihub', ''];
    });

    expect(calls).toEqual([
      'ps -a --filter label=ci-hub.managed=true --format {{.Label "com.docker.compose.project"}}',
      'ps -a --filter label=ci-os-hub.managed=true --format {{.Label "com.docker.compose.project"}}',
    ]);
    expect(projects).toEqual(['ci-memory_ci-marketplace', 'ci-openclaw_ci-marketplace']);
  });

  describe('planAppTeardown and removeManagedAppProjects (cihub reset)', () => {
    const HUB_NETWORK_FILTERS =
      'ps -a --filter network=ci-hub_network --filter network=ci_hub_network --filter network=ci-os-hub_network --filter network=ci_os_hub_network --format {{.Names}} {{.Label "com.docker.compose.project"}}';

    // What beta-max had attached to ci-hub_network on 2026-09-26: the Hub stack, and four
    // containers named like Hub apps that `docker run` had started with no labels at all, so
    // nothing follows their names.
    const BETA_MAX_HUB_NETWORK = [
      'ci-hub ci-hub',
      'ci-hub-db ci-hub',
      'traefik ci-hub',
      'cloudflared ci-hub',
      'opencode-web_ci-marketplace-opencode-web-1 ',
      'ci-openclaw_ci-marketplace-ci-openclaw-1 ',
      'ci-hermes_ci-marketplace-ci-hermes-gateway-1 ',
      'ci-hermes_ci-marketplace-ci-hermes-1 ',
    ].join('\n');

    const fakeDocker = (hubNetwork = '') => {
      const calls: string[] = [];
      const docker = (args: string[]) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'ps -a --filter label=ci-hub.managed=true --format {{.Label "com.docker.compose.project"}}') {
          return { ok: true, stdout: 'ci-hub\nci-hermes_ci-marketplace' };
        }
        if (command === 'ps -a --filter label=ci-os-hub.managed=true --format {{.Label "com.docker.compose.project"}}') {
          return { ok: true, stdout: 'ci-openclaw_ci-marketplace' };
        }
        if (command === 'ps -a --filter label=com.docker.compose.project=ci-hermes_ci-marketplace --format {{.Names}}') {
          return { ok: true, stdout: 'hermes-1\nhermes-gateway-1' };
        }
        if (command === 'ps -a --filter label=com.docker.compose.project=ci-openclaw_ci-marketplace --format {{.Names}}') {
          return { ok: true, stdout: 'openclaw-1' };
        }
        if (command === 'network ls --filter label=com.docker.compose.project=ci-hermes_ci-marketplace --format {{.Name}}') {
          return { ok: true, stdout: 'ci-hermes_ci-marketplace_default' };
        }
        if (command === 'volume ls -q --filter label=com.docker.compose.project=ci-openclaw_ci-marketplace') {
          return { ok: true, stdout: 'ci-openclaw_ci-marketplace_state' };
        }
        if (command === HUB_NETWORK_FILTERS) {
          return { ok: true, stdout: hubNetwork };
        }
        return { ok: true, stdout: '' };
      };
      return { calls, docker };
    };

    it('removes apps under both labels, with their networks and volumes, and leaves the Hub stack to compose down', () => {
      const { calls, docker } = fakeDocker();

      const removed = removeManagedAppProjects(docker, { removeVolumes: true });

      expect(removed.projects.map((entry) => entry.project)).toEqual(['ci-hermes_ci-marketplace', 'ci-openclaw_ci-marketplace']);
      expect(calls).toContain('rm -f hermes-1 hermes-gateway-1');
      expect(calls).toContain('rm -f openclaw-1');
      expect(calls).toContain('network rm ci-hermes_ci-marketplace_default');
      expect(calls).toContain('volume rm ci-openclaw_ci-marketplace_state');
      expect(calls.some((command) => command.includes('com.docker.compose.project=ci-hub'))).toBe(false);
    });

    it('plans containers on the Hub network that no label ties to the Hub, and leaves the Hub stack out', () => {
      const { calls, docker } = fakeDocker(BETA_MAX_HUB_NETWORK);

      const plan = planAppTeardown(docker, { removeVolumes: true });

      expect(plan.listed).toBe(true);
      expect(plan.unmanaged).toEqual([
        'opencode-web_ci-marketplace-opencode-web-1',
        'ci-openclaw_ci-marketplace-ci-openclaw-1',
        'ci-hermes_ci-marketplace-ci-hermes-gateway-1',
        'ci-hermes_ci-marketplace-ci-hermes-1',
      ]);
      // Planning is read-only.
      expect(calls.filter((command) => !command.startsWith('ps ') && !command.includes(' ls '))).toEqual([]);
    });

    it('removes the unlabelled containers by name, and no volume on their account', () => {
      const { calls, docker } = fakeDocker(BETA_MAX_HUB_NETWORK);

      removeManagedAppProjects(docker, { removeVolumes: true });

      expect(calls).toContain(
        'rm -f opencode-web_ci-marketplace-opencode-web-1 ci-openclaw_ci-marketplace-ci-openclaw-1 ci-hermes_ci-marketplace-ci-hermes-gateway-1 ci-hermes_ci-marketplace-ci-hermes-1',
      );
      expect(calls.filter((command) => command.startsWith('volume rm'))).toEqual(['volume rm ci-openclaw_ci-marketplace_state']);
    });

    it('does not list an installed app twice when its main service is also on the Hub network', () => {
      const { docker } = fakeDocker(['hermes-1 ci-hermes_ci-marketplace', 'legacy-hub runtipi', 'stray-1,other/alias ', '--privileged '].join('\n'));

      const plan = planAppTeardown(docker, { removeVolumes: false });

      expect(plan.unmanaged).toEqual(['stray-1']);
      expect(plan.projects.every((entry) => entry.volumes.length === 0)).toBe(true);
    });

    it('keeps app volumes when asked, and reports docker being unreachable instead of "no apps"', () => {
      const { calls, docker } = fakeDocker();
      removeManagedAppProjects(docker, { removeVolumes: false });
      expect(calls.some((command) => command.startsWith('volume'))).toBe(false);

      const unreachable: string[] = [];
      const plan = removeManagedAppProjects(
        (args) => {
          unreachable.push(args.join(' '));
          return { ok: false, stdout: '' };
        },
        { removeVolumes: true },
      );
      expect(plan).toEqual({ listed: false, projects: [], unmanaged: [] });
      expect(unreachable.every((command) => command.startsWith('ps -a --filter '))).toBe(true);
    });

    it('is not "listed" when only the Hub network query fails', () => {
      const { docker } = fakeDocker();
      const plan = planAppTeardown((args) => (args.join(' ') === HUB_NETWORK_FILTERS ? { ok: false, stdout: '' } : docker(args)), {
        removeVolumes: true,
      });
      expect(plan.listed).toBe(false);
    });
  });

  describe('which compose projects count as Hub apps', () => {
    // The Hub's own stack, one installed app, and a compose project the Hub never installed. The
    // app sets one of its own labels to a value with a comma in it.
    const engine = () =>
      fakeDockerEngine({
        containers: [
          {
            name: 'ci-hub',
            labels: {
              'ci-hub.managed': 'true',
              'com.docker.compose.project': 'ci-hub',
              'com.docker.compose.project.config_files': '/x/docker-compose.prod.yml,/x/docker-compose.dev-image.yml',
            },
            networks: ['ci-hub_network'],
          },
          {
            name: 'whoami_custom-whoami-1',
            labels: {
              'ci-hub.managed': 'true',
              'ci-os-hub.managed': 'true',
              'com.example.note': 'x,com.docker.compose.project=photos',
              'com.docker.compose.project': 'whoami_custom',
            },
            networks: ['ci-hub_network', 'whoami_custom_default'],
          },
          { name: 'photos-app-1', labels: { 'com.docker.compose.project': 'photos' }, networks: ['photos_default'] },
          { name: 'photos-db-1', labels: { 'com.docker.compose.project': 'photos' }, networks: ['photos_default'] },
        ],
        networks: [
          { name: 'whoami_custom_default', labels: { 'com.docker.compose.project': 'whoami_custom' } },
          { name: 'photos_default', labels: { 'com.docker.compose.project': 'photos' } },
        ],
        volumes: [
          { name: 'whoami_custom_state', labels: { 'com.docker.compose.project': 'whoami_custom' } },
          { name: 'photos_data', labels: { 'com.docker.compose.project': 'photos' } },
        ],
      });

    it('reads the compose project label itself, not a project named inside another label (cihub reset, cihub clean)', () => {
      const { docker, removals } = engine();

      const plan = removeManagedAppProjects(docker, { removeVolumes: true });

      expect(plan.projects).toEqual([
        { project: 'whoami_custom', containers: ['whoami_custom-whoami-1'], networks: ['whoami_custom_default'], volumes: ['whoami_custom_state'] },
      ]);
      expect(removals().filter((command) => command.includes('photos'))).toEqual([]);
      expect(removals()).toEqual(['rm -f whoami_custom-whoami-1', 'network rm whoami_custom_default', 'volume rm whoami_custom_state']);
    });

    it('reads the compose project label itself in the uninstall cleanup too (cihub uninstall)', () => {
      const { docker, removals } = engine();

      withXdgHome('/home/dev', () =>
        runHubCleanup({
          cwd: '/home/dev/ci-hub',
          homeDir: '/home/dev',
          platform: 'linux',
          execFile: (_file, args) => docker(args),
          exists: () => false,
          removeDir: () => {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        }),
      );

      expect(removals().filter((command) => command.includes('photos'))).toEqual([]);
      expect(removals()).toEqual(
        expect.arrayContaining([
          'rm -f whoami_custom-whoami-1',
          'network rm whoami_custom_default',
          'volume rm whoami_custom_state',
          'image rm -f sha256:image-of-whoami_custom-whoami-1',
        ]),
      );
    });

    it('finds apps whose labels hold commas, and apps carrying only the legacy label', () => {
      const { docker } = fakeDockerEngine({
        containers: [
          {
            name: 'ci-memory_ci-marketplace-api-1',
            labels: {
              'ci-hub.appurn': 'ci-memory:ci-marketplace',
              'ci-hub.managed': 'true',
              'ci-os-hub.managed': 'true',
              'com.docker.compose.project': 'ci-memory_ci-marketplace',
              'com.docker.compose.project.config_files': '/data/apps/ci-memory/docker-compose.yml,/data/apps/ci-memory/override.yml',
              'com.docker.compose.service': 'api',
              'traefik.http.routers.ci-memory.middlewares': 'hub-auth@file,ci-memory-headers',
            },
          },
          {
            name: 'ci-memory_ci-marketplace-db-1',
            labels: { 'ci-hub.managed': 'true', 'ci-os-hub.managed': 'true', 'com.docker.compose.project': 'ci-memory_ci-marketplace' },
          },
          {
            name: 'ci-openclaw_ci-marketplace-ci-openclaw-1',
            labels: { 'ci-os-hub.managed': 'true', 'com.docker.compose.project': 'ci-openclaw_ci-marketplace' },
          },
          { name: 'legacy-hub', labels: { 'ci-os-hub.managed': 'true', 'com.docker.compose.project': 'runtipi' } },
        ],
        volumes: [{ name: 'ci-openclaw_ci-marketplace_state', labels: { 'com.docker.compose.project': 'ci-openclaw_ci-marketplace' } }],
      });

      const plan = planAppTeardown(docker, { removeVolumes: true });

      expect(plan.projects).toEqual([
        {
          project: 'ci-memory_ci-marketplace',
          containers: ['ci-memory_ci-marketplace-api-1', 'ci-memory_ci-marketplace-db-1'],
          networks: [],
          volumes: [],
        },
        {
          project: 'ci-openclaw_ci-marketplace',
          containers: ['ci-openclaw_ci-marketplace-ci-openclaw-1'],
          networks: [],
          volumes: ['ci-openclaw_ci-marketplace_state'],
        },
      ]);
    });

    // Services the user adds in the app's user-config docker-compose.yml. Compose gives them the
    // app's project label, but the Hub's labels are not on them. One joins the Hub network.
    const appWithUserServices = () => {
      const project = { 'com.docker.compose.project': 'ci-hermes_ci-marketplace' };
      return fakeDockerEngine({
        containers: [
          { name: 'ci-hub', labels: { 'ci-hub.managed': 'true', 'com.docker.compose.project': 'ci-hub' }, networks: ['ci-hub_network'] },
          {
            name: 'hermes-1',
            labels: { 'ci-hub.managed': 'true', ...project },
            networks: ['ci-hub_network', 'ci-hermes_ci-marketplace_network'],
          },
          { name: 'hermes-sidecar-1', labels: project, networks: ['ci-hermes_ci-marketplace_default'] },
          { name: 'hermes-proxy-1', labels: project, networks: ['ci-hub_network'] },
        ],
        networks: [
          { name: 'ci-hermes_ci-marketplace_network', labels: project },
          { name: 'ci-hermes_ci-marketplace_default', labels: project },
        ],
        volumes: [{ name: 'ci-hermes_ci-marketplace_sidecar-data', labels: project }],
      });
    };

    it('removes the services a user added to an app with the app, before its networks and volumes (cihub reset, cihub clean)', () => {
      const { docker, removals } = appWithUserServices();

      const plan = removeManagedAppProjects(docker, { removeVolumes: true });

      expect(plan.projects).toEqual([
        {
          project: 'ci-hermes_ci-marketplace',
          containers: ['hermes-1', 'hermes-sidecar-1', 'hermes-proxy-1'],
          networks: ['ci-hermes_ci-marketplace_network', 'ci-hermes_ci-marketplace_default'],
          volumes: ['ci-hermes_ci-marketplace_sidecar-data'],
        },
      ]);
      expect(plan.unmanaged).toEqual([]);
      expect(removals()).toEqual([
        'rm -f hermes-1 hermes-sidecar-1 hermes-proxy-1',
        'network rm ci-hermes_ci-marketplace_network',
        'network rm ci-hermes_ci-marketplace_default',
        'volume rm ci-hermes_ci-marketplace_sidecar-data',
      ]);
    });

    it('removes the services a user added to an app with the app in the uninstall cleanup too (cihub uninstall)', () => {
      const { docker, removals } = appWithUserServices();

      withXdgHome('/home/dev', () =>
        runHubCleanup({
          cwd: '/home/dev/ci-hub',
          homeDir: '/home/dev',
          platform: 'linux',
          execFile: (_file, args) => docker(args),
          exists: () => false,
          removeDir: () => {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        }),
      );

      const removed = removals();
      const appNetworkRemoval = removed.indexOf('network rm ci-hermes_ci-marketplace_default');
      expect(appNetworkRemoval).toBeGreaterThan(-1);
      for (const container of ['hermes-1', 'hermes-sidecar-1', 'hermes-proxy-1']) {
        const removal = removed.indexOf(`rm -f ${container}`);
        expect(removal, container).toBeGreaterThan(-1);
        expect(removal, container).toBeLessThan(appNetworkRemoval);
      }
      expect(removed.indexOf('volume rm ci-hermes_ci-marketplace_sidecar-data')).toBeGreaterThan(appNetworkRemoval);
    });

    it('keeps an app container whose {{.Names}} also carries legacy link aliases', () => {
      const { docker } = fakeDockerEngine({
        containers: [
          { name: 'hermes-1,other/hermes', labels: { 'ci-hub.managed': 'true', 'com.docker.compose.project': 'ci-hermes_ci-marketplace' } },
        ],
      });

      expect(planAppTeardown(docker, { removeVolumes: false }).projects[0]?.containers).toEqual(['hermes-1']);
    });
  });

  it('resolves Linux state directories and includes repo-local paths', () => {
    const dirs = withXdgHome('/home/tester', () =>
      getHubStateDirs({
        cwd: '/tmp/ci-hub',
        homeDir: '/home/tester',
        platform: 'linux',
      }),
    );

    expect(dirs.some((dir) => dir.path === '/tmp/ci-hub/.local')).toBe(true);
    expect(dirs.some((dir) => dir.path.includes('/home/tester/.config'))).toBe(true);
    expect(dirs.some((dir) => dir.path.endsWith('computer.ci.app.hub'))).toBe(true);
  });

  it('resolves Windows state directories and includes AppData names', () => {
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    process.env.APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';

    try {
      const dirs = getHubStateDirs({
        cwd: 'C:\\repo',
        homeDir: 'C:\\Users\\dev',
        platform: 'win32',
      });

      expect(dirs.some((dir) => dir.path.includes('AppData\\Roaming\\Companion Hub'))).toBe(true);
      expect(dirs.some((dir) => dir.path.includes('AppData\\Local\\companion-hub'))).toBe(true);
      expect(dirs.some((dir) => dir.path === 'C:\\repo\\.config')).toBe(true);
      expect(dirs.some((dir) => dir.path.includes('AppData\\Roaming\\computer.ci.app.hub'))).toBe(true);
    } finally {
      if (prevAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = prevAppData;
      }
      if (prevLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = prevLocalAppData;
      }
    }
  });

  it('supports dry-run without deleting files while still reporting planned work', () => {
    const commands: string[] = [];
    const removed: string[] = [];

    withXdgHome('/home/dev', () => {
      const summary = runHubCleanup({
        cwd: '/tmp/ci-hub',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: true,
        execFile: (file, args) => {
          const command = [file, ...args].join(' ');
          commands.push(command);
          if (command.includes('docker volume ls')) {
            return { ok: true, stdout: 'ci_hub_pgdata\npostgres_data' };
          }
          if (command.includes('docker network ls')) {
            return { ok: true, stdout: 'bridge\ne2e-network' };
          }
          return { ok: true, stdout: '' };
        },
        exists: (targetPath) => targetPath.endsWith('.internal') || targetPath.endsWith('computer.ci.app.hub'),
        removeDir: (targetPath) => {
          removed.push(targetPath);
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.removedDirs).toBeGreaterThan(0);
      expect(removed).toEqual([]);
      expect(summary.attemptedCommands).toBeGreaterThan(5);
      expect(commands.some((command) => command.includes('docker volume ls'))).toBe(false);
      expect(commands.some((command) => command.includes('docker network ls'))).toBe(false);
    });
  });

  it('tears down marketplace app projects discovered via the ci-os-hub.managed label', () => {
    const commands: string[] = [];

    withXdgHome('/home/dev', () => {
      runHubCleanup({
        cwd: '/home/dev/ci-hub',
        homeDir: '/home/dev',
        platform: 'linux',
        execFile: (file, args) => {
          const command = [file, ...args].join(' ');
          commands.push(command);
          if (command === 'docker ps -a --filter label=ci-os-hub.managed=true --format {{.Label "com.docker.compose.project"}}') {
            // One compose project per container. Includes a Hub-stack project (ci-os-hub), which
            // also carries this label in docker-compose.prod.yml, to prove the app loop excludes it.
            return { ok: true, stdout: 'ci-hermes_ci-marketplace\nfoo_ci-marketplace\nci-os-hub' };
          }
          if (command === 'docker ps -a --filter label=com.docker.compose.project=ci-hermes_ci-marketplace -q') {
            return { ok: true, stdout: 'cid-hermes' };
          }
          if (command === 'docker inspect --format {{.Image}} cid-hermes') {
            return { ok: true, stdout: 'sha256:appimage' };
          }
          if (command.includes('docker network ls --filter label=com.docker.compose.project=ci-hermes_ci-marketplace')) {
            // Includes the shared hub network to prove the app loop skips it.
            return { ok: true, stdout: 'ci-hermes_ci-marketplace_network\nci-os-hub_network' };
          }
          if (command.includes('docker volume ls --filter label=com.docker.compose.project=ci-hermes_ci-marketplace')) {
            return { ok: true, stdout: 'ci-hermes_ci-marketplace_data' };
          }
          return { ok: true, stdout: '' };
        },
        exists: () => false,
        removeDir: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      // Discovered app projects via the managed label and iterated each one.
      expect(commands.some((command) => command.includes('label=ci-os-hub.managed=true'))).toBe(true);
      expect(commands.some((command) => command.includes('label=com.docker.compose.project=foo_ci-marketplace'))).toBe(true);
      // Removed the app's container (by id), its own network, its volume, and its image.
      expect(commands).toContain('docker rm -f cid-hermes');
      expect(commands).toContain('docker network rm ci-hermes_ci-marketplace_network');
      expect(commands).toContain('docker volume rm ci-hermes_ci-marketplace_data');
      expect(commands).toContain('docker image rm -f sha256:appimage');
      // The Hub-stack project is excluded from the marketplace loop (handled by Hub teardown).
      expect(commands.some((command) => command.startsWith('docker volume ls --filter label=com.docker.compose.project=ci-os-hub'))).toBe(false);
      expect(commands.some((command) => command.startsWith('docker network ls --filter label=com.docker.compose.project=ci-os-hub'))).toBe(false);
    });
  });

  it('completes with no directory failures when cwd is within the user home', () => {
    const errors: string[] = [];

    withXdgHome('/home/dev', () => {
      const summary = runHubCleanup({
        cwd: '/home/dev/repo',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: false,
        execFile: () => ({ ok: true, stdout: '' }),
        exists: () => true,
        removeDir: () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: (message) => {
            errors.push(message);
          },
        },
      });

      expect(summary.failedDirs).toBe(0);
      expect(errors).toEqual([]);
    });
  });

  it('blocks repo-local deletions when cwd is outside the user home', () => {
    const errors: string[] = [];

    withXdgHome('/home/dev', () => {
      const summary = runHubCleanup({
        cwd: '/repo',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: false,
        execFile: () => ({ ok: true, stdout: '' }),
        exists: () => true,
        removeDir: () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: (message) => {
            errors.push(message);
          },
        },
      });

      expect(summary.failedDirs).toBeGreaterThan(0);
      expect(errors.some((message) => message.includes('Blocked unsafe path'))).toBe(true);
    });
  });
});

/** base64 of {"a": account tag, "t": tunnel id, "s": secret}, the format cloudflared reads; padded so tests can strip the padding. */
const CLOUDFLARED_TOKEN = (() => {
  for (let secretBytes = 32; secretBytes < 40; secretBytes++) {
    const payload = {
      a: '0123456789abcdef0123456789abcdef',
      t: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
      s: Buffer.alloc(secretBytes, 7).toString('base64'),
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    if (token.endsWith('=')) return token;
  }
  throw new Error('could not build a padded token');
})();

describe('isCloudflaredTunnelToken', () => {
  it('accepts a cloudflared token, with or without base64 padding and surrounding whitespace', () => {
    expect(CLOUDFLARED_TOKEN.endsWith('=')).toBe(true);
    expect(isCloudflaredTunnelToken(CLOUDFLARED_TOKEN)).toBe(true);
    expect(isCloudflaredTunnelToken(`${CLOUDFLARED_TOKEN.replace(/=+$/, '')}\r\n`)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['plain text', 'hello world'],
    ['base64 of JSON without the token keys', Buffer.from('{"id":"x","name":"y"}').toString('base64')],
    ['base64 of a JSON array', Buffer.from('["a","t","s"]').toString('base64')],
    ['a token with characters that are not base64', `${CLOUDFLARED_TOKEN}!`],
  ])('rejects %s', (_label, content) => {
    expect(isCloudflaredTunnelToken(content)).toBe(false);
  });
});

describe('getDesktopTunnelDir', () => {
  // The tunnel folder sits beside the data dir, so it follows the same rule for a snap's
  // XDG_DATA_HOME as resolveCanonicalDataDir (CI-Hub#1698).
  it('ignores the XDG_DATA_HOME another snap sets, like the data dir itself', () => {
    const saved = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      SNAP_NAME: process.env.SNAP_NAME,
    };
    try {
      process.env.XDG_DATA_HOME = '/home/dev/snap/code/264/.local/share';
      process.env.XDG_CONFIG_HOME = '/home/dev/.config';
      process.env.XDG_CACHE_HOME = '/home/dev/.cache';
      process.env.SNAP_NAME = 'code';
      expect(getDesktopTunnelDir({ homeDir: '/home/dev', platform: 'linux' })).toBe('/home/dev/.local/share/tunnel');
      const dataDirs = getHubStateDirs({ cwd: '/home/dev/repo', homeDir: '/home/dev', platform: 'linux' })
        .filter((dir) => dir.label === 'data dir')
        .map((dir) => dir.path);
      expect(dataDirs).toContain('/home/dev/.local/share/companion-hub');
      expect(dataDirs.some((dir) => dir.includes('/snap/'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('is the tunnel folder beside the desktop data folder', () => {
    const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, APPDATA: process.env.APPDATA };
    try {
      process.env.XDG_DATA_HOME = '/home/dev/.local/share';
      process.env.APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
      expect(getDesktopTunnelDir({ homeDir: '/home/dev', platform: 'linux' })).toBe('/home/dev/.local/share/tunnel');
      expect(getDesktopTunnelDir({ homeDir: 'C:\\Users\\dev', platform: 'win32' })).toBe('C:\\Users\\dev\\AppData\\Roaming\\tunnel');
      delete process.env.XDG_DATA_HOME;
      expect(getDesktopTunnelDir({ homeDir: '/home/dev', platform: 'linux' })).toBe('/home/dev/.local/share/tunnel');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe.skipIf(process.platform === 'win32')('runHubCleanup tunnel files', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
  }

  const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

  type TunnelFiles = { token?: string; registration?: string; extraFiles?: string[]; certsFiles?: string[] };

  /** A tunnel folder the way a paired Hub leaves it, with per-test overrides. */
  function writeTunnelDir(tunnel: string, files: TunnelFiles = {}) {
    fs.mkdirSync(path.join(tunnel, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(tunnel, 'token'), files.token ?? CLOUDFLARED_TOKEN);
    fs.writeFileSync(
      path.join(tunnel, 'registration.json'),
      files.registration ?? '{"tunnelId":"6ff42ae2","writtenAt":"2026-09-17T00:00:00.000Z"}\n',
    );
    fs.writeFileSync(path.join(tunnel, 'leftover.json'), '{"tunnelId":null,"foundAt":"2026-09-17T00:00:00.000Z"}\n');
    fs.writeFileSync(path.join(tunnel, '.user-cleared-token'), '1');
    for (const name of files.certsFiles ?? []) fs.writeFileSync(path.join(tunnel, 'certs', name), 'PEM');
    for (const name of files.extraFiles ?? []) fs.writeFileSync(path.join(tunnel, name), 'not the Hub');
  }

  /** A home holding a repo checkout and the desktop's data folder, each with its tunnel folder. */
  function makeHome(desktopTunnel: TunnelFiles = {}) {
    const home = tempDir('ci-hub-cleanup-home-');
    const share = path.join(home, '.local', 'share');
    fs.mkdirSync(path.join(share, 'companion-hub', 'state'), { recursive: true });
    fs.mkdirSync(path.join(share, 'other-app'), { recursive: true });
    fs.writeFileSync(path.join(share, 'other-app', 'data'), 'keep');
    writeTunnelDir(path.join(share, 'tunnel'), desktopTunnel);
    const repo = path.join(home, 'ci-hub');
    writeTunnelDir(path.join(repo, 'tunnel'), { token: 'dev-token', extraFiles: ['README.md'] });
    return { home, share, repo, desktopTunnel: path.join(share, 'tunnel'), repoTunnel: path.join(repo, 'tunnel') };
  }

  function cleanup(home: string, repo: string, dryRun = false) {
    const saved = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.XDG_CACHE_HOME = path.join(home, '.cache');
    try {
      return runHubCleanup({
        cwd: repo,
        homeDir: home,
        platform: 'linux',
        dryRun,
        // Nothing reaches a shell or Docker, and nothing outside the temp home is deleted.
        execFile: () => ({ ok: true, stdout: '' }),
        removeDir: (target) => {
          if (!isWithinPath(target, home, 'linux')) throw new Error(`refusing to remove ${target}`);
          fs.rmSync(target, { recursive: true, force: true });
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('removes the token and the backend markers from the repo tunnel folder', () => {
    const { home, repo, repoTunnel } = makeHome();
    const summary = cleanup(home, repo);
    expect(summary.failedDirs).toBe(0);
    expect(listDir(repoTunnel)).toEqual(['README.md']);
  });

  it('removes the Hub files beside the desktop data folder, then the empty folder', () => {
    const { home, share, repo, desktopTunnel } = makeHome();
    const summary = cleanup(home, repo);
    expect(summary.failedDirs).toBe(0);
    expect(fs.existsSync(path.join(share, 'companion-hub'))).toBe(false);
    expect(fs.existsSync(desktopTunnel)).toBe(false);
    expect(listDir(path.join(share, 'other-app'))).toEqual(['data']);
  });

  it('keeps a desktop tunnel folder whose files are not the Hub files', () => {
    const { home, repo, desktopTunnel } = makeHome({
      token: 'hello world',
      registration: '{"id":1}',
      extraFiles: ['notes.txt'],
      certsFiles: ['custom-ca.pem'],
    });
    cleanup(home, repo);
    expect(listDir(desktopTunnel)).toEqual(['certs', 'notes.txt', 'registration.json', 'token']);
    expect(listDir(path.join(desktopTunnel, 'certs'))).toEqual(['custom-ca.pem']);
  });

  it('does not follow a symlinked desktop tunnel folder', () => {
    const { home, repo, desktopTunnel } = makeHome();
    fs.rmSync(desktopTunnel, { recursive: true });
    const target = path.join(tempDir('ci-hub-cleanup-elsewhere-'), 'tunnel');
    writeTunnelDir(target);
    fs.symlinkSync(target, desktopTunnel);
    cleanup(home, repo);
    expect(listDir(target)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
  });

  it('leaves the desktop tunnel files in place on a dry run', () => {
    const { home, repo, desktopTunnel } = makeHome();
    cleanup(home, repo, true);
    expect(listDir(desktopTunnel)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
  });
});
