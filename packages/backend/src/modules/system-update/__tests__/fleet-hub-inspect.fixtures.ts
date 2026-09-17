/**
 * `docker inspect` of the running Hub container, recorded read-only on the tailnet fleet on
 * 2026-09-17 (labels and mounts verbatim; Traefik labels and env values dropped). These are the three
 * layouts the self-updater broke, plus the in-container label shape an older updater left behind.
 */
import type { DockerContainerInspect } from '../hub-deployment';

const DEV_IMAGE_LABELS = {
  'org.opencontainers.image.created': '2026-09-17T07:44:35.701Z',
  'org.opencontainers.image.revision': 'dac546bcffe0f105539615d94c8139e4522c050a',
  'org.opencontainers.image.source': 'https://github.com/companionintelligence/CI-Hub',
  'org.opencontainers.image.title': 'CI-Hub',
  'org.opencontainers.image.version': 'dev',
};

const binds = (pairs: Array<[string, string]>) => pairs.map(([Source, Destination]) => ({ Type: 'bind', Source, Destination }));

const HOST_SYSTEM_BINDS: Array<[string, string]> = [
  ['/etc/localtime', '/etc/localtime'],
  ['/etc/machine-id', '/etc/machine-id'],
  ['/etc/timezone', '/etc/timezone'],
  ['/proc/meminfo', '/host/proc/meminfo'],
  ['/usr/bin/tailscale', '/usr/bin/tailscale'],
  ['/var/run/docker.sock', '/var/run/docker.sock'],
  ['/var/run/tailscale', '/var/run/tailscale'],
];

/**
 * core-4: a source checkout at /home/ci/devel/CI-Hub with a locally modified docker-compose.prod.yml
 * that still names the service `ci-os-hub`, `.env.prod`, and ROOT_FOLDER_HOST=/home/ci/devel/CI-Hub/.internal.
 * hub-stack-update.log, 2026-09-17T01:28Z: `Container ci-os-hub-queue  Recreated`, then
 * `bind source path does not exist: /home/ci/devel/CI-Hub/.internal/.env`.
 */
export function core4SourceCheckout(image = 'ghcr.io/companionintelligence/ci-hub:dev'): DockerContainerInspect {
  return {
    Name: '/ci-os-hub',
    Image: 'sha256:c18ab68d0ff296b3336e48e977409551af95dee711e9f044af863896ad4f760e',
    Config: {
      Image: image,
      Labels: {
        'ci-os-hub.managed': 'true',
        'com.docker.compose.config-hash': 'd209daa57e2bf0214ede7c3a543e35312d9e8c48516863caf15e8dd596d5f2a9',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.depends_on': '',
        'com.docker.compose.oneoff': 'False',
        'com.docker.compose.project': 'ci-hub',
        'com.docker.compose.project.config_files': '/home/ci/devel/CI-Hub/docker-compose.prod.yml',
        'com.docker.compose.project.environment_file': '/home/ci/devel/CI-Hub/.env.prod',
        'com.docker.compose.project.working_dir': '/home/ci/devel/CI-Hub',
        'com.docker.compose.replace': 'ci-os-hub',
        'com.docker.compose.service': 'ci-os-hub',
        'com.docker.compose.version': '5.5.1',
        ...DEV_IMAGE_LABELS,
      },
    },
    Mounts: binds([
      ['/home/ci/devel/CI-Hub/.internal/app-data', '/app-data'],
      ['/home/ci/devel/CI-Hub/tunnel', '/app/tunnel'],
      ['/home/ci/devel/CI-Hub/.internal/.docker', '/data/.docker'],
      ['/home/ci/devel/CI-Hub/.env.prod', '/data/.env'],
      ['/home/ci/devel/CI-Hub/.internal/apps', '/data/apps'],
      ['/home/ci/devel/CI-Hub/.internal/backups', '/data/backups'],
      ['/home/ci/devel/CI-Hub/.internal/cache', '/data/cache'],
      ['/home/ci/devel/CI-Hub/docker-compose.prod.yml', '/data/docker-compose.yml'],
      ['/home/ci/devel/CI-Hub/.internal/logs', '/data/logs'],
      ['/home/ci/devel/CI-Hub/.internal/media', '/data/media'],
      ['/home/ci/devel/CI-Hub/.internal/repos', '/data/repos'],
      ['/home/ci/devel/CI-Hub/.internal/state', '/data/state'],
      ['/home/ci/devel/CI-Hub/.internal/user-config', '/data/user-config'],
      ...HOST_SYSTEM_BINDS,
    ]),
  };
}

/**
 * core-14: a hybrid. Compose files and `.env.prod` come from the checkout, with the dev-image overlay
 * layered on, while the data directories live under ~/.local/share/companion-hub.
 */
export function core14HybridCheckout(image = 'ghcr.io/companionintelligence/ci-hub:dev'): DockerContainerInspect {
  return {
    Name: '/ci-hub',
    Image: 'sha256:c18ab68d0ff296b3336e48e977409551af95dee711e9f044af863896ad4f760e',
    Config: {
      Image: image,
      Labels: {
        'ci-hub.managed': 'true',
        'ci-os-hub.managed': 'true',
        'com.docker.compose.project': 'ci-hub',
        'com.docker.compose.project.config_files': '/home/ci/devel/CI-Hub/docker-compose.prod.yml,/home/ci/devel/CI-Hub/docker-compose.dev-image.yml',
        'com.docker.compose.project.environment_file': '/home/ci/devel/CI-Hub/.env.prod',
        'com.docker.compose.project.working_dir': '/home/ci/devel/CI-Hub',
        'com.docker.compose.service': 'ci-hub',
        'com.docker.compose.version': '5.5.1',
        ...DEV_IMAGE_LABELS,
      },
    },
    Mounts: binds([
      ['/home/ci/.local/share/companion-hub/app-data', '/app-data'],
      ['/home/ci/.local/share/tunnel', '/app/tunnel'],
      ['/home/ci/.local/share/companion-hub/.docker', '/data/.docker'],
      ['/home/ci/devel/CI-Hub/.env.prod', '/data/.env'],
      ['/home/ci/.local/share/companion-hub/apps', '/data/apps'],
      ['/home/ci/.local/share/companion-hub/backups', '/data/backups'],
      ['/home/ci/.local/share/companion-hub/cache', '/data/cache'],
      ['/home/ci/devel/CI-Hub/docker-compose.prod.yml', '/data/docker-compose.yml'],
      ['/home/ci/.local/share/companion-hub/logs', '/data/logs'],
      ['/home/ci/.local/share/companion-hub/media', '/data/media'],
      ['/home/ci/.local/share/companion-hub/repos', '/data/repos'],
      ['/home/ci/.local/share/companion-hub/state', '/data/state'],
      ['/home/ci/.local/share/companion-hub/user-config', '/data/user-config'],
      ...HOST_SYSTEM_BINDS,
    ]),
  };
}

/**
 * core-6: the standard appliance install under ~/.local/share/companion-hub. The updater recreated
 * the Hub, but `env_file: .env` did not resolve inside the updater container, so it came back
 * without JWT_SECRET, DEVICE_ID, DOMAIN, CI_CLOUD_URL and PRIVATE_VPN_USER_DISABLED.
 */
export function core6Appliance(image = 'ghcr.io/companionintelligence/ci-hub:dev'): DockerContainerInspect {
  return {
    Name: '/ci-hub',
    Image: 'sha256:c18ab68d0ff296b3336e48e977409551af95dee711e9f044af863896ad4f760e',
    Config: {
      Image: image,
      Labels: {
        'ci-hub.managed': 'true',
        'ci-os-hub.managed': 'true',
        'com.docker.compose.project': 'ci-hub',
        'com.docker.compose.project.config_files': '/home/ci/.local/share/companion-hub/docker-compose.prod.yml',
        'com.docker.compose.project.environment_file': '/home/ci/.local/share/companion-hub/.env',
        'com.docker.compose.project.working_dir': '/home/ci/.local/share/companion-hub',
        'com.docker.compose.service': 'ci-hub',
        'com.docker.compose.version': '5.5.1',
        ...DEV_IMAGE_LABELS,
      },
    },
    Mounts: binds([
      ['/home/ci/.local/share/companion-hub/app-data', '/app-data'],
      ['/home/ci/.local/share/tunnel', '/app/tunnel'],
      ['/home/ci/.local/share/companion-hub/.docker', '/data/.docker'],
      ['/home/ci/.local/share/companion-hub/.env', '/data/.env'],
      ['/home/ci/.local/share/companion-hub/apps', '/data/apps'],
      ['/home/ci/.local/share/companion-hub/backups', '/data/backups'],
      ['/home/ci/.local/share/companion-hub/cache', '/data/cache'],
      ['/home/ci/.local/share/companion-hub/docker-compose.prod.yml', '/data/docker-compose.yml'],
      ['/home/ci/.local/share/companion-hub/logs', '/data/logs'],
      ['/home/ci/.local/share/companion-hub/media', '/data/media'],
      ['/home/ci/.local/share/companion-hub/repos', '/data/repos'],
      ['/home/ci/.local/share/companion-hub/state', '/data/state'],
      ['/home/ci/.local/share/companion-hub/user-config', '/data/user-config'],
      ...HOST_SYSTEM_BINDS,
    ]),
  };
}

/**
 * core-6's install as an in-container compose client records it: `-f /data/docker-compose.yml
 * --env-file /data/.env --project-directory $ROOT_FOLDER_HOST`, the invocation every updater before
 * this one used. The container paths only mean something through the Hub's own binds.
 */
export function core6RecreatedFromInsideContainer(image = 'ghcr.io/companionintelligence/ci-hub:0.2.70'): DockerContainerInspect {
  const inspect = core6Appliance(image);
  return {
    ...inspect,
    Config: {
      ...inspect.Config,
      Labels: {
        ...inspect.Config?.Labels,
        'com.docker.compose.project.config_files': '/data/docker-compose.yml',
        'com.docker.compose.project.environment_file': '/data/.env',
      },
    },
  };
}

/**
 * core-3 (beta-3-glass has the same shape under /root): compose ran without `--env-file`, so it
 * interpolated from the project's `.env`, while `ENV_FILE` pointed the Hub's `/data/.env` bind and
 * `env_file` at `.env.dev`. The updater can only pin `.env.dev`. Recorded 2026-09-17.
 */
export function core3EnvLabelDiffersFromMount(image = 'ghcr.io/companionintelligence/ci-hub:dev'): DockerContainerInspect {
  const inspect = core6Appliance(image);
  return {
    ...inspect,
    Mounts: inspect.Mounts?.map((mount) =>
      mount.Destination === '/data/.env' ? { ...mount, Source: '/home/ci/.local/share/companion-hub/.env.dev' } : mount,
    ),
  };
}

/** Labels of the published `ci-hub:0.2.71` image (GHCR, 2026-09-17): the version label says `latest`. */
export const RELEASE_0_2_71_IMAGE_LABELS = {
  'org.opencontainers.image.created': '2026-09-16T12:39:10.154Z',
  'org.opencontainers.image.revision': '6a5ac521dd859ae985fd01df381cf6df3fe72d3e',
  'org.opencontainers.image.version': 'latest',
};
