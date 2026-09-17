/**
 * The throwaway container that recreates the Hub on the Hub's behalf, and the script it runs.
 *
 * Why a container at all: `docker compose up --force-recreate <hub>` stops the Hub container
 * partway through, and a compose client spawned INSIDE that container dies with it. Every appliance
 * auto-update before #1454 stalled at exactly `Container ci-hub  Recreate` (fzzy 2026-09-11 and
 * 2026-09-15, beta-max 2026-09-11). The helper lives outside the Hub's PID namespace.
 *
 * Why the script is this careful: the first version of the helper ran one `up` for the Hub AND the
 * queue from a guessed layout. On core-4 it recreated `ci-os-hub-queue`, then failed to create the Hub
 * (`bind source path does not exist`), and compose never reached its start phase, so RabbitMQ stayed
 * `Created` and every app lifecycle command failed until someone noticed, daily from 09-12 to 09-15.
 * The script now touches one service, checks the compose model before it touches anything, and on any
 * failure starts every project container that was running when it began.
 */
import type { ComposeUpdatePlan } from './hub-deployment';

/** POSIX single-quoting, so a value survives `sh -c` byte for byte. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Named after the Hub container it recreates, so a legacy `ci-os-hub` node gets `ci-os-hub-stack-updater`. */
export function stackUpdaterContainerName(hubContainer: string): string {
  return `${hubContainer}-stack-updater`;
}

/**
 * The previous env-file content travels to the helper under this name, as `-e NAME` with the value in
 * the CLI's environment rather than argv: the file holds JWT_SECRET and friends.
 */
export const ENV_RESTORE_VARIABLE = 'CI_HUB_UPDATE_ENV_RESTORE';

export interface StackUpdaterScriptInput {
  plan: ComposeUpdatePlan;
  targetImage: string;
  /**
   * The literal environment compose runs with. Nothing else reaches it: the script starts compose
   * under `env -i`. The Hub's own process env used to be forwarded, and it carries the service's
   * `environment:` values, which then won interpolation over the env file. `API_PORT: 5002` there
   * would have remapped any node whose env file publishes a different API port.
   */
  composeEnv: Record<string, string>;
  logPath: string;
  /** Where the helper sees the env file the Hub pinned (the Hub's `/data/.env`, via `--volumes-from`). */
  envFilePath: string;
  /** Lets the HTTP response that started the update leave before compose stops the Hub. */
  startDelaySeconds: number;
}

/** The `sh` program the helper runs. Pure, so tests can run it against a stub `docker`. */
export function buildStackUpdaterScript(input: StackUpdaterScriptInput): string {
  const { plan } = input;
  const q = shellQuote;
  const envAssignments = Object.entries(input.composeEnv)
    .map(([key, value]) => q(`${key}=${value}`))
    .join(' ');
  const composeArgs = [
    'compose',
    '--project-name',
    plan.project,
    '--project-directory',
    plan.workingDir,
    ...plan.configFiles.flatMap((file) => ['-f', file]),
    ...plan.envFiles.flatMap((file) => ['--env-file', file]),
  ]
    .map(q)
    .join(' ');
  const describe = `service ${plan.service} of project ${plan.project} (compose files ${plan.configFiles.join(', ')}; env file ${plan.envFiles.join(', ')})`;

  return [
    `exec >> ${q(input.logPath)} 2>&1`,
    `sleep ${Math.max(0, Math.floor(input.startDelaySeconds))}`,
    `TARGET=${q(input.targetImage)}`,
    `HUB=${q(plan.container)}`,
    'note() { echo "stack-updater: $*"; }',
    `compose() { env -i PATH="$PATH" HOME=/tmp ${envAssignments} docker ${composeArgs} "$@"; }`,
    // Snapshot before anything changes: these are the containers a failure must leave running.
    `RUNNING_BEFORE=$(docker ps --filter ${q(`label=com.docker.compose.project=${plan.project}`)} --format '{{.Names}}')`,
    'fail() {',
    '  note "FAILED: $1"',
    '  for name in $RUNNING_BEFORE; do',
    `    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then`,
    '      if docker start "$name" >/dev/null; then note "started $name again"; else note "could not start $name; start it by hand"; fi',
    '    fi',
    '  done',
    // The env file should name the image the Hub container actually has. If the recreate never
    // produced a container on the target image, the old pin goes back.
    `  if [ "$(docker inspect -f '{{.Config.Image}}' "$HUB" 2>/dev/null)" != "$TARGET" ]; then`,
    `    if [ -n "\${${ENV_RESTORE_VARIABLE}:-}" ] && printf '%s' "$${ENV_RESTORE_VARIABLE}" | base64 -d > "\${TMPDIR:-/tmp}/hub-env.restore" && cat "\${TMPDIR:-/tmp}/hub-env.restore" > ${q(input.envFilePath)}; then`,
    `      note ${q(`restored the previous CI_HUB_IMAGE pin in ${input.envFilePath}`)}`,
    '    else',
    `      note ${q(`could not restore ${input.envFilePath}; check CI_HUB_IMAGE by hand`)}`,
    '    fi',
    '  fi',
    '  note "result=failed"',
    '  exit 1',
    '}',
    `note ${q(`recreating ${describe} on`)} "$TARGET"`,
    // `env_file` is `required: false`, so compose skips a file it cannot see without a word. That
    // silence is how core-6's Hub came back without JWT_SECRET, DEVICE_ID and DOMAIN.
    `[ -r ${q(plan.envFileHost)} ] || fail ${q(`${plan.envFileHost} is not readable inside the updater, so the recreated Hub would start without its env file`)}`,
    // `config --images` resolves the whole model, interpolation included, without touching a
    // container. A compose file that hard-codes its own image, or builds instead of pulling, fails
    // here instead of halfway through a recreate. It also prints the service's dependencies
    // (measured with compose 5.5.1), hence a whole-line match rather than equality.
    `IMAGES=$(compose config --images ${q(plan.service)}) || fail ${q('docker compose could not load the compose files that created this Hub')}`,
    `printf '%s\\n' "$IMAGES" | grep -qxF "$TARGET" || fail "compose resolves ${plan.service.replace(/["$`\\]/g, '')} and its dependencies to $(echo $IMAGES), not $TARGET, so a recreate would not deploy the update"`,
    // One service, no dependencies, no orphan removal: nothing the update does not need is touched.
    `compose up -d --no-deps --force-recreate --no-build ${q(plan.service)} || fail ${q('docker compose up did not complete')}`,
    'note "result=ok"',
    '',
  ].join('\n');
}

/**
 * `docker run` argv for the helper.
 *
 * `--volumes-from` gives it the Hub's own view: the Docker socket, `/data/.docker` (the compose
 * plugin), `/data/logs` and `/data/.env`. The mirror mounts give it the host view compose needs. The
 * compose CLIENT reads `env_file` and the `-f` files, while the DAEMON resolves bind sources on the
 * host, and one `ENV_FILE` value feeds both. Only a path that means the same thing on both sides can
 * satisfy them, so each host path is bound at itself. core-6 lost its env keys because `.env` did not
 * exist where the client looked. `--mount` rather than `-v` so a missing host path fails the run
 * instead of Docker creating an empty root-owned directory there.
 *
 * `--network none`: the helper only ever talks to the daemon over the socket. `--rm`: the outcome is
 * in `hub-stack-update.log`, not in a stopped container.
 */
export function buildStackUpdaterRunArgs(input: {
  helperName: string;
  hubContainer: string;
  image: string;
  mirrorPaths: string[];
  envKeys: string[];
  script: string;
}): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    input.helperName,
    '--network',
    'none',
    '--volumes-from',
    input.hubContainer,
    ...input.mirrorPaths.flatMap((hostPath) => ['--mount', `type=bind,source=${hostPath},target=${hostPath},readonly`]),
    ...input.envKeys.flatMap((key) => ['-e', key]),
    '--entrypoint',
    'sh',
    input.image,
    '-c',
    input.script,
  ];
}
