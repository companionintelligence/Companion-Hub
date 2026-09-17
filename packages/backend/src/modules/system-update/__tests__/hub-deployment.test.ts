import { describe, expect, it } from 'vitest';
import {
  channelUpdateRefusal,
  classifyHubImage,
  describeRunningBuild,
  parseImageReference,
  readEnvFileValue,
  resolveComposeUpdatePlan,
  resolveRunningHubBuild,
  selectReleaseTarget,
} from '../hub-deployment';
import {
  core14HybridCheckout,
  core3EnvLabelDiffersFromMount,
  core4SourceCheckout,
  core6Appliance,
  core6RecreatedFromInsideContainer,
  RELEASE_0_2_71_IMAGE_LABELS,
} from './fleet-hub-inspect.fixtures';

const MOUNT_TARGETS = { envFile: '/data/.env', composeFile: '/data/docker-compose.yml' };

function planOrThrow(result: ReturnType<typeof resolveComposeUpdatePlan>) {
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.reason}`);
  return result.plan;
}

describe('running build (a): what the Hub runs comes from its image, never CI_HUB_VERSION', () => {
  // beta-red read CI_HUB_VERSION=v0.2.22 while running a dev build newer than 0.2.71, and the daily
  // check moved it off :dev. Nothing in the image says 0.2.22, so nothing here may report it.
  it('reports a dev build as dev plus its commit, with no release version', () => {
    const build = resolveRunningHubBuild(core6Appliance(), { RepoTags: ['ghcr.io/companionintelligence/ci-hub:dev'] });
    expect(build.channel).toEqual({ kind: 'floating', tag: 'dev' });
    expect(build.version).toBeNull();
    expect(build.revision).toBe('dac546bcffe0f105539615d94c8139e4522c050a');
    expect(build.container).toBe('ci-hub');
    expect(describeRunningBuild(build)).toBe('dev@dac546bcf');
  });

  it('takes the release from a version-pinned reference', () => {
    const build = resolveRunningHubBuild(core6Appliance('ghcr.io/companionintelligence/ci-hub:0.2.70'), null);
    expect(build.channel).toEqual({ kind: 'pin', version: '0.2.70' });
    expect(build.version).toBe('0.2.70');
    expect(describeRunningBuild(build)).toBe('0.2.70');
  });

  // The published 0.2.71 image is labelled version=latest, so the label alone cannot identify it.
  it('does not mistake the release image label "latest" for a version, and finds the version tag Docker holds for it', () => {
    const container = core6Appliance('ghcr.io/companionintelligence/ci-hub:latest');
    container.Config = { ...container.Config, Labels: { ...container.Config?.Labels, ...RELEASE_0_2_71_IMAGE_LABELS } };

    expect(resolveRunningHubBuild(container, null).version).toBeNull();
    const build = resolveRunningHubBuild(container, {
      RepoTags: ['ghcr.io/companionintelligence/ci-hub:latest', 'ghcr.io/companionintelligence/ci-hub:0.2.71', 'someone/else:9.9.9'],
    });
    expect(build.version).toBe('0.2.71');
    expect(build.channel).toEqual({ kind: 'floating', tag: 'latest' });
  });

  it('reads a version-shaped OCI label once release builds stamp one', () => {
    const container = core6Appliance('ghcr.io/companionintelligence/ci-hub:latest');
    container.Config = { ...container.Config, Labels: { ...container.Config?.Labels, 'org.opencontainers.image.version': '0.2.72' } };
    expect(resolveRunningHubBuild(container, null).version).toBe('0.2.72');
  });

  it.each([
    ['ghcr.io/companionintelligence/ci-hub:0.2.71', { kind: 'pin', version: '0.2.71' }],
    ['ghcr.io/companionintelligence/ci-hub:v0.2.71', { kind: 'pin', version: '0.2.71' }],
    ['ghcr.io/companionintelligence/ci-os-hub:0.2.43', { kind: 'pin', version: '0.2.43' }],
    ['ghcr.io/companionintelligence/ci-hub:dev', { kind: 'floating', tag: 'dev' }],
    ['ghcr.io/companionintelligence/ci-hub:pr-auto-76b1c7bc1', { kind: 'floating', tag: 'pr-auto-76b1c7bc1' }],
    ['ghcr.io/companionintelligence/ci-hub', { kind: 'floating', tag: 'latest' }],
    ['ghcr.io/companionintelligence/ci-hub@sha256:c18ab68d0ff296b3336e48e977409551af95dee711e9f044af863896ad4f760e', { kind: 'digest' }],
    ['ghcr.io/companionintelligence/ci-hub:0.2.71@sha256:c18ab68d0ff2', { kind: 'digest' }],
    ['ci-hub-ci-hub:latest', { kind: 'foreign', repository: 'ci-hub-ci-hub' }],
    ['localhost:5000/ci-hub:0.2.71', { kind: 'foreign', repository: 'localhost:5000/ci-hub' }],
  ])('classifies %s', (reference, expected) => {
    expect(classifyHubImage(reference)).toEqual(expected);
  });

  it('treats a registry port as part of the repository, not as a tag', () => {
    expect(parseImageReference('registry.local:5000/ci-hub')).toEqual({ repository: 'registry.local:5000/ci-hub', tag: null, digest: null });
  });
});

describe('channel (b): the self-updater only ever advances a release pin', () => {
  // core-2, core-4, core-6, core-17, beta-red and beta-max ran :dev; the daily check rewrote
  // CI_HUB_IMAGE to :0.2.71 on every one of them.
  it.each([
    ['core-4', core4SourceCheckout()],
    ['core-14', core14HybridCheckout()],
    ['core-6', core6Appliance()],
  ])('refuses to move %s off :dev', (_node, container) => {
    const build = resolveRunningHubBuild(container, null);
    const refusal = channelUpdateRefusal(build, 'ghcr.io/companionintelligence/ci-hub:dev');
    expect(refusal).toContain('ghcr.io/companionintelligence/ci-hub:dev');
    expect(refusal).toContain("floating 'dev' tag");
  });

  it('refuses a digest and a local build', () => {
    const digest = resolveRunningHubBuild(core6Appliance('ghcr.io/companionintelligence/ci-hub@sha256:abc'), null);
    expect(channelUpdateRefusal(digest, null)).toContain('digest');
    const local = resolveRunningHubBuild(core6Appliance('ci-hub-ci-hub:latest'), null);
    expect(channelUpdateRefusal(local, null)).toContain('outside the Hub release repository');
  });

  it('refuses a pinned container whose env file has already been switched to a channel', () => {
    const build = resolveRunningHubBuild(core6Appliance('ghcr.io/companionintelligence/ci-hub:0.2.70'), null);
    expect(channelUpdateRefusal(build, 'ghcr.io/companionintelligence/ci-hub:dev')).toContain(
      'CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:dev',
    );
  });

  it('allows a release pin whose env file agrees or says nothing', () => {
    const build = resolveRunningHubBuild(core6Appliance('ghcr.io/companionintelligence/ci-hub:0.2.70'), null);
    expect(channelUpdateRefusal(build, 'ghcr.io/companionintelligence/ci-hub:0.2.70')).toBeNull();
    expect(channelUpdateRefusal(build, 'ghcr.io/companionintelligence/ci-hub:0.2.71')).toBeNull();
    expect(channelUpdateRefusal(build, null)).toBeNull();
  });

  describe('selectReleaseTarget', () => {
    const tags = ['0.2.73-rc.1', '0.2.72', '0.2.71', '0.2.70', 'v0.2.99', 'latest'];

    it('compares as semver, not as strings', () => {
      expect(selectReleaseTarget('0.2.9', ['0.2.10', '0.2.8'])).toBe('0.2.10');
    });

    it('never moves a stable pin onto a pre-release', () => {
      expect(selectReleaseTarget('0.2.71', tags)).toBe('0.2.72');
    });

    it('lets a pre-release pin reach a newer pre-release', () => {
      expect(selectReleaseTarget('0.2.73-rc.0', tags)).toBe('0.2.73-rc.1');
    });

    it('ignores v-prefixed tags, which the pipeline never publishes and GHCR would 404', () => {
      expect(selectReleaseTarget('0.2.72', tags)).toBeNull();
    });

    it('returns null for a current value that is not a version', () => {
      expect(selectReleaseTarget('dev', tags)).toBeNull();
    });
  });
});

describe('compose identity (c) and absolute env files (e), from the recorded fleet labels', () => {
  // The old updater ran `--project-directory $ROOT_FOLDER_HOST` with ENV_FILE=.env, which on core-4
  // is /home/ci/devel/CI-Hub/.internal/.env: `bind source path does not exist`.
  it('core-4: targets the legacy ci-os-hub service in the checkout, with .env.prod as ENV_FILE', () => {
    const plan = planOrThrow(resolveComposeUpdatePlan(core4SourceCheckout(), MOUNT_TARGETS));
    expect(plan).toEqual({
      container: 'ci-os-hub',
      project: 'ci-hub',
      service: 'ci-os-hub',
      workingDir: '/home/ci/devel/CI-Hub',
      configFiles: ['/home/ci/devel/CI-Hub/docker-compose.prod.yml'],
      envFiles: ['/home/ci/devel/CI-Hub/.env.prod'],
      envFileHost: '/home/ci/devel/CI-Hub/.env.prod',
      composeFileHost: '/home/ci/devel/CI-Hub/docker-compose.prod.yml',
      mirrorPaths: ['/home/ci/devel/CI-Hub'],
    });
    expect(plan.envFileHost).not.toBe('/home/ci/devel/CI-Hub/.internal/.env');
  });

  // Only docker-compose.prod.yml was mounted into the Hub, so the old updater dropped the dev-image
  // overlay and resolved the service as build-only.
  it('core-14: keeps both compose files in order, including the overlay the Hub never had mounted', () => {
    const plan = planOrThrow(resolveComposeUpdatePlan(core14HybridCheckout(), MOUNT_TARGETS));
    expect(plan.configFiles).toEqual(['/home/ci/devel/CI-Hub/docker-compose.prod.yml', '/home/ci/devel/CI-Hub/docker-compose.dev-image.yml']);
    expect(plan.workingDir).toBe('/home/ci/devel/CI-Hub');
    expect(plan.envFileHost).toBe('/home/ci/devel/CI-Hub/.env.prod');
    expect(plan.service).toBe('ci-hub');
    expect(plan.mirrorPaths).toEqual(['/home/ci/devel/CI-Hub']);
  });

  // env_file is read by the compose CLIENT. A relative `.env` did not exist inside the updater
  // container, `required: false` skipped it, and core-6's Hub lost its secrets.
  it('core-6: ENV_FILE is the absolute host file, and the updater gets it at that same path', () => {
    const plan = planOrThrow(resolveComposeUpdatePlan(core6Appliance(), MOUNT_TARGETS));
    expect(plan.envFileHost).toBe('/home/ci/.local/share/companion-hub/.env');
    expect(plan.envFileHost.startsWith('/')).toBe(true);
    expect(plan.mirrorPaths).toEqual(['/home/ci/.local/share/companion-hub']);
    expect(plan.mirrorPaths.some((mirror) => plan.envFileHost.startsWith(`${mirror}/`))).toBe(true);
  });

  it('maps container paths recorded by an in-container compose client back through the Hub binds', () => {
    const plan = planOrThrow(resolveComposeUpdatePlan(core6RecreatedFromInsideContainer(), MOUNT_TARGETS));
    expect(plan.configFiles).toEqual(['/home/ci/.local/share/companion-hub/docker-compose.prod.yml']);
    expect(plan.envFiles).toEqual(['/home/ci/.local/share/companion-hub/.env']);
    expect(plan.mirrorPaths.some((mirror) => mirror.startsWith('/data'))).toBe(false);
  });

  it('mirrors compose files outside the working directory individually', () => {
    const container = core6Appliance();
    container.Config = {
      ...container.Config,
      Labels: {
        ...container.Config?.Labels,
        'com.docker.compose.project.config_files': '/home/ci/.local/share/companion-hub/docker-compose.prod.yml,/opt/overlays/pull-image.yml',
      },
    };
    const plan = planOrThrow(resolveComposeUpdatePlan(container, MOUNT_TARGETS));
    expect(plan.mirrorPaths).toEqual(['/home/ci/.local/share/companion-hub', '/opt/overlays/pull-image.yml']);
  });

  it('refuses a container compose did not create', () => {
    const container = core6Appliance();
    container.Config = { ...container.Config, Labels: { 'org.opencontainers.image.version': 'dev' } };
    const result = resolveComposeUpdatePlan(container, MOUNT_TARGETS);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('no docker compose project or service label') });
  });

  it('core-3: refuses a stack whose compose env file is not the one mounted at /data/.env', () => {
    const result = resolveComposeUpdatePlan(core3EnvLabelDiffersFromMount(), MOUNT_TARGETS);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('/home/ci/.local/share/companion-hub/.env.dev');
  });

  it('refuses when compose interpolates from a different env file than the one the Hub can pin', () => {
    const container = core14HybridCheckout();
    container.Config = {
      ...container.Config,
      Labels: { ...container.Config?.Labels, 'com.docker.compose.project.environment_file': '/home/ci/devel/CI-Hub/.env.dev' },
    };
    const result = resolveComposeUpdatePlan(container, MOUNT_TARGETS);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('/home/ci/devel/CI-Hub/.env.dev');
  });

  it('refuses a Hub with no /data/.env bind', () => {
    const container = core6Appliance();
    container.Mounts = container.Mounts?.filter((mount) => mount.Destination !== '/data/.env');
    expect(resolveComposeUpdatePlan(container, MOUNT_TARGETS).ok).toBe(false);
  });

  it.each([
    ['a Windows host path', 'C:\\Users\\liam\\AppData\\Local\\Companion Hub'],
    ['a path with a comma, which --mount would split', '/home/ci/hub,old'],
    ['a directory the updater image runs from', '/usr/local/companion-hub'],
    ['the filesystem root', '/'],
  ])('refuses %s as a working directory', (_label, workingDir) => {
    const container = core6Appliance();
    container.Config = { ...container.Config, Labels: { ...container.Config?.Labels, 'com.docker.compose.project.working_dir': workingDir } };
    expect(resolveComposeUpdatePlan(container, MOUNT_TARGETS).ok).toBe(false);
  });

  it('refuses a host path that would land on top of one of the Hub mounts the updater inherits', () => {
    const container = core6Appliance();
    container.Config = { ...container.Config, Labels: { ...container.Config?.Labels, 'com.docker.compose.project.working_dir': '/var/run' } };
    const result = resolveComposeUpdatePlan(container, MOUNT_TARGETS);
    expect(!result.ok && result.reason).toContain('/var/run/docker.sock');
  });
});

describe('readEnvFileValue', () => {
  it('reads the last assignment, unquoted', () => {
    expect(readEnvFileValue('A=1\nCI_HUB_IMAGE="ghcr.io/x:dev"\n# CI_HUB_IMAGE=no\nCI_HUB_IMAGE=ghcr.io/x:0.2.71\n', 'CI_HUB_IMAGE')).toBe(
      'ghcr.io/x:0.2.71',
    );
    expect(readEnvFileValue("ROOT_FOLDER_HOST='/srv/hub'", 'ROOT_FOLDER_HOST')).toBe('/srv/hub');
    expect(readEnvFileValue('OTHER=1', 'ROOT_FOLDER_HOST')).toBeNull();
  });
});
