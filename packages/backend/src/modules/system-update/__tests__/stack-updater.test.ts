import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveComposeUpdatePlan, type ComposeUpdatePlan } from '../hub-deployment';
import { buildStackUpdaterRunArgs, buildStackUpdaterScript, ENV_RESTORE_VARIABLE, shellQuote, stackUpdaterContainerName } from '../stack-updater';
import { core4SourceCheckout, core6Appliance } from './fleet-hub-inspect.fixtures';

// The suite-wide setup swaps `fs` for memfs; the script under test is a real `sh` reading real files.
const fs = await vi.importActual<typeof import('node:fs')>('node:fs');

const TARGET = 'ghcr.io/companionintelligence/ci-hub:0.2.72';
const PREVIOUS_ENV = 'JWT_SECRET=keep-me\nCI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:0.2.71\nCI_HUB_VERSION=0.2.71\n';
const PINNED_ENV = 'JWT_SECRET=keep-me\nCI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:0.2.72\nCI_HUB_VERSION=0.2.72\n';

function plan(container = core6Appliance('ghcr.io/companionintelligence/ci-hub:0.2.71')): ComposeUpdatePlan {
  const result = resolveComposeUpdatePlan(container, { envFile: '/data/.env', composeFile: '/data/docker-compose.yml' });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

/**
 * A `docker` that answers the handful of calls the script makes from files in its own directory, and
 * records every call. Compose runs under `env -i`, so the stub cannot take instructions from the
 * environment; it snapshots the environment compose saw instead.
 */
const STUB_DOCKER = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
case "$1" in
  ps) cat "$dir/running" ;;
  inspect)
    case "$3" in
      *State.Running*) if grep -qx "$4" "$dir/stopped" 2>/dev/null; then echo false; else echo true; fi ;;
      *Config.Image*) cat "$dir/hub-image" ;;
    esac ;;
  start) echo "$2" >> "$dir/started" ;;
  compose)
    # No cli-plugins symlink: the docker CLI does not know "compose" and chokes on its first flag.
    if [ -f "$dir/no-plugin" ] && [ -z "$VIA_STANDALONE" ]; then echo "unknown flag: $2" >&2; exit 125; fi
    env | sort > "$dir/compose-env"
    for arg in "$@"; do
      case "$arg" in
        config) cat "$dir/images"; exit 0 ;;
        up)
          if [ -f "$dir/up-fails" ]; then cat "$dir/up-fails" >> "$dir/stopped"; exit 1; fi
          echo "${TARGET}" > "$dir/hub-image"; exit 0 ;;
      esac
    done ;;
esac
exit 0
`;

/** The image's standalone compose binary: same CLI, reached without the docker plugin lookup. */
const STUB_STANDALONE_COMPOSE = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/standalone.log"
VIA_STANDALONE=1 exec "$dir/docker" compose "$@"
`;

describe('stack updater script, run against a stub docker', () => {
  let dir: string;
  let bin: string;
  let envFile: string;
  let logFile: string;
  let standaloneCompose: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-updater-'));
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), STUB_DOCKER, { mode: 0o755 });
    standaloneCompose = path.join(bin, 'docker-compose');
    fs.writeFileSync(standaloneCompose, STUB_STANDALONE_COMPOSE, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'running'), 'ci-hub\nci-hub-queue\nci-hub-db\ntraefik\n');
    fs.writeFileSync(path.join(bin, 'hub-image'), 'ghcr.io/companionintelligence/ci-hub:0.2.71\n');
    // Real `config --images <service>` output lists the dependencies' images as well (compose 5.5.1).
    fs.writeFileSync(path.join(bin, 'images'), `${TARGET}\npostgres:14\nrabbitmq:4-alpine\n`);
    envFile = path.join(dir, 'hub.env');
    logFile = path.join(dir, 'hub-stack-update.log');
    fs.writeFileSync(envFile, PINNED_ENV);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The fleet plan, with its env file standing in at a path this machine has (the helper mirrors it). */
  function run(fleetPlan: ComposeUpdatePlan = plan(), envFileHost: string = envFile) {
    const updatePlan = { ...fleetPlan, envFileHost };
    const script = buildStackUpdaterScript({
      plan: updatePlan,
      targetImage: TARGET,
      composeEnv: {
        DOCKER_CONFIG: '/data/.docker',
        CI_HUB_IMAGE: TARGET,
        CI_HUB_VERSION: '0.2.72',
        ENV_FILE: updatePlan.envFileHost,
      },
      logPath: logFile,
      envFilePath: envFile,
      startDelaySeconds: 0,
      standaloneCompose,
    });
    const result = spawnSync('sh', ['-c', script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: dir,
        // What the helper inherits besides the restore payload must never reach compose.
        JWT_SECRET: 'from-the-hub-process',
        API_PORT: '5002',
        [ENV_RESTORE_VARIABLE]: Buffer.from(PREVIOUS_ENV).toString('base64'),
      },
      encoding: 'utf8',
    });
    const read = (name: string) => (fs.existsSync(path.join(bin, name)) ? fs.readFileSync(path.join(bin, name), 'utf8') : '');
    return { status: result.status, calls: read('calls.log').trim().split('\n'), log: fs.readFileSync(logFile, 'utf8'), read };
  }

  it('recreates only the Hub service, with no dependencies and no orphan removal', () => {
    const { status, calls, log, read } = run();

    expect(status).toBe(0);
    const composeCalls = calls.filter((call) => call.startsWith('compose '));
    expect(composeCalls).toHaveLength(2);
    expect(composeCalls[0]).toMatch(/ config --images ci-hub$/);
    expect(composeCalls[1]).toMatch(/ up -d --no-deps --force-recreate --no-build ci-hub$/);
    for (const call of composeCalls) {
      expect(call).toContain(
        'compose --project-name ci-hub --project-directory /home/ci/.local/share/companion-hub -f /home/ci/.local/share/companion-hub/docker-compose.prod.yml --env-file /home/ci/.local/share/companion-hub/.env',
      );
      expect(call).not.toContain('ci-hub-queue');
      expect(call).not.toContain('--remove-orphans');
    }
    expect(log).toContain('stack-updater: result=ok');
    expect(calls.some((call) => call.startsWith('start '))).toBe(false);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(PINNED_ENV);

    // (e) compose sees an absolute ENV_FILE and nothing from the Hub process environment.
    const composeEnv = read('compose-env');
    expect(composeEnv).toContain(`ENV_FILE=${envFile}\n`);
    expect(composeEnv).toContain(`CI_HUB_IMAGE=${TARGET}\n`);
    expect(composeEnv).not.toContain('JWT_SECRET');
    expect(composeEnv).not.toContain('API_PORT');
    expect(composeEnv).not.toContain(ENV_RESTORE_VARIABLE);
  });

  // The core-4 replay: compose recreated the queue, failed on the Hub, and never reached its start
  // phase. RabbitMQ stayed `Created` and every app lifecycle command failed for hours.
  it('starts every container that was running before when the recreate fails, and puts the old pin back', () => {
    fs.writeFileSync(path.join(bin, 'up-fails'), 'ci-hub-queue\n');

    const { status, calls, log, read } = run();

    expect(status).toBe(1);
    expect(read('started').trim().split('\n')).toEqual(['ci-hub-queue']);
    expect(log).toContain('stack-updater: FAILED: docker compose up did not complete');
    expect(log).toContain('stack-updater: started ci-hub-queue again');
    expect(log).toContain('stack-updater: result=failed');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(PREVIOUS_ENV);
    expect(calls.filter((call) => call.startsWith('start '))).toEqual(['start ci-hub-queue']);
  });

  it('keeps the new pin when the recreate failed after the Hub already runs the target image', () => {
    fs.writeFileSync(path.join(bin, 'up-fails'), '');
    fs.writeFileSync(path.join(bin, 'hub-image'), `${TARGET}\n`);

    const { status } = run();

    expect(status).toBe(1);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(PINNED_ENV);
  });

  // A build-only compose file (docker-compose.prod.yml without an image overlay) resolves the service
  // to `<project>-<service>`, and a recreate would build or fail rather than deploy the pulled image.
  it('touches nothing when compose would not deploy the target image', () => {
    fs.writeFileSync(path.join(bin, 'images'), 'ci-hub-ci-hub\npostgres:14\nrabbitmq:4-alpine\n');

    const { status, calls, log } = run();

    expect(status).toBe(1);
    expect(calls.some((call) => / up /.test(call))).toBe(false);
    expect(log).toContain(
      'compose resolves ci-hub and its dependencies to ci-hub-ci-hub postgres:14 rabbitmq:4-alpine, not ghcr.io/companionintelligence/ci-hub:0.2.72',
    );
    expect(fs.readFileSync(envFile, 'utf8')).toBe(PREVIOUS_ENV);
  });

  // core-6: `env_file: .env` did not exist where the compose client looked, `required: false`
  // skipped it, and the Hub came back without JWT_SECRET, DEVICE_ID, DOMAIN and CI_CLOUD_URL.
  it('refuses to recreate a Hub whose env file the updater cannot read', () => {
    const { status, calls, log } = run(plan(), '/home/ci/.local/share/companion-hub/.env-that-is-not-mirrored');

    expect(status).toBe(1);
    expect(calls.some((call) => call.startsWith('compose '))).toBe(false);
    expect(log).toContain('is not readable inside the updater, so the recreated Hub would start without its env file');
  });

  // core-2, core-7, beta-max, beta-ms-a2 and beta-red have no cli-plugins directory, so `docker compose`
  // is not a command inside the image; the 2026-09-17 update on core-2 and beta-max logged
  // `unknown flag: --env-file` and never recreated anything.
  it('recreates the Hub on a node without the compose CLI plugin, through the image binary', () => {
    fs.writeFileSync(path.join(bin, 'no-plugin'), '');

    const { status, log, read } = run();

    expect(status).toBe(0);
    expect(log).toContain('stack-updater: result=ok');
    expect(log).not.toContain('unknown flag');
    expect(read('standalone.log')).toMatch(/ up -d --no-deps --force-recreate --no-build ci-hub\n$/);
  });

  it('falls back to the docker compose plugin in an image without the standalone binary', () => {
    fs.rmSync(standaloneCompose);

    const { status, calls, log, read } = run();

    expect(status).toBe(0);
    expect(log).toContain('stack-updater: compose CLI: docker compose');
    expect(read('standalone.log')).toBe('');
    expect(calls.filter((call) => call.startsWith('compose '))).toHaveLength(2);
  });

  it('targets the legacy ci-os-hub service on core-4', () => {
    const { calls } = run(plan(core4SourceCheckout('ghcr.io/companionintelligence/ci-hub:0.2.71')));
    const up = calls.find((call) => call.startsWith('compose ') && call.includes(' up '));
    expect(up).toBe(
      'compose --project-name ci-hub --project-directory /home/ci/devel/CI-Hub -f /home/ci/devel/CI-Hub/docker-compose.prod.yml --env-file /home/ci/devel/CI-Hub/.env.prod up -d --no-deps --force-recreate --no-build ci-os-hub',
    );
  });
});

describe('stack updater container', () => {
  it('names the helper after the Hub container, legacy topology included', () => {
    expect(stackUpdaterContainerName('ci-hub')).toBe('ci-hub-stack-updater');
    expect(stackUpdaterContainerName('ci-os-hub')).toBe('ci-os-hub-stack-updater');
  });

  it('single-quotes for sh, including embedded quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('$HOME `x` "y"')).toBe(`'$HOME \`x\` "y"'`);
  });

  // core-6 lost JWT_SECRET, DEVICE_ID and DOMAIN because env_file named a path that existed on the
  // host but not inside the updater container. Each host path is bound at itself.
  it('builds a detached, socket-only run that inherits the Hub mounts and mirrors each host path at itself', () => {
    const args = buildStackUpdaterRunArgs({
      helperName: 'ci-hub-stack-updater',
      hubContainer: 'ci-hub',
      image: TARGET,
      mirrorPaths: ['/home/ci/devel/CI-Hub', '/opt/overlays/pull-image.yml'],
      envKeys: [ENV_RESTORE_VARIABLE],
      script: 'echo ok',
    });
    expect(args).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'ci-hub-stack-updater',
      '--network',
      'none',
      '--volumes-from',
      'ci-hub',
      '--mount',
      'type=bind,source=/home/ci/devel/CI-Hub,target=/home/ci/devel/CI-Hub,readonly',
      '--mount',
      'type=bind,source=/opt/overlays/pull-image.yml,target=/opt/overlays/pull-image.yml,readonly',
      '-e',
      ENV_RESTORE_VARIABLE,
      '--entrypoint',
      'sh',
      TARGET,
      '-c',
      'echo ok',
    ]);
  });
});
