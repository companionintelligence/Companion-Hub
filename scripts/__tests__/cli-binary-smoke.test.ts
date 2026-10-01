/**
 * Smoke tests that run the COMPILED `cihub` binary — the artifact a fleet node actually installs.
 *
 * Why this file exists (v0.2.67, `cihub pool update`):
 *
 *   ReferenceError: colorize is not defined
 *       at runPoolUpdateCommand (/$bunfs/root/cihub-linux-x64:25781:25)
 *
 * `scripts/lib/cli-pool.ts` called `colorize(...)` and never imported it. A free identifier like
 * that is invisible to every gate this repo had:
 *
 *   - `pnpm run tsc` is `turbo run tsc`, and turbo only knows `packages/*`. Root `scripts/` — the
 *     whole shipped CLI — is not in the pnpm workspace, so tsc never looked at it. (Pointed at the
 *     file directly it says `TS2304: Cannot find name 'colorize'` in milliseconds.)
 *   - Biome's `recommended` set leaves `correctness/noUndeclaredVariables` off. It is now ON for
 *     `scripts/**` (see biome.json) and is the static half of this guard.
 *   - The 1000+ unit tests import TypeScript modules, where the bundler and the compile step do not
 *     exist. They were green on the broken tree.
 *
 * Bun did nothing wrong: it compiled a reference to a global that is never defined, which is what
 * JavaScript says to do. The defect only became visible when the binary ran the line — and the line
 * sits behind `if (identity && (identity.project !== 'ci-hub' || ...))`, so it fired on nodes whose
 * compose stack had drifted and stayed silent everywhere else. That is why it reached the fleet.
 *
 * So: build the binary the way `desktop-release.yml` builds it, then run it far enough to execute
 * real handler code. Coverage note — this catches free identifiers on the paths it walks, not all of
 * them; the Biome rule is what covers the paths no smoke test reaches. The two are complements.
 *
 * Hermetic by construction: a stub `docker` and a stub `git` sit first on PATH, HOME points at a
 * throwaway directory, and the stub fails every docker verb except the read-only `inspect` it
 * answers from a string. No real container, image, or socket is touched, and nothing leaves the box.
 * A stub `companion-hub` (and `Companion Hub`) sits there too, recording its arguments: `cihub
 * update` hands off to the desktop app found on PATH, and on a machine with the app installed the
 * real one downloads the newest release and installs it with pkexec or sudo (#1739).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// The release build path itself, not a reimplementation of it: `desktop-release.yml` shells out to
// this same module. A change to the bun flags is therefore covered here for free.
const { buildStandaloneCli } = require('../build-standalone-cli.cjs') as {
  buildStandaloneCli: (options: { outdir: string }) => { outfile: string };
};

/** Anything here in the output means the binary died on a symbol, not on the situation under test. */
const CRASH_PATTERNS = [/ReferenceError/, /is not defined/, /is not a function/, /ci-hub cli failed/];

/**
 * The password sync scripts prefix every line with their own name. None of the commands below runs
 * them, so seeing the prefix means a script's own entry block fired on import — see is-direct-run.ts.
 */
const SCRIPT_ENTRY_OUTPUT = /sync-(?:rabbitmq|postgres)-password:/;

/** The names `resolveCompanionHubBinary` (cli-update.ts) looks up on PATH for the desktop app. */
const DESKTOP_APP_NAMES = ['companion-hub', 'Companion Hub'];

const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0;

/**
 * Bun is what compiles the shipped binary, so without it there is nothing to smoke-test. Locally
 * that is a skip; in CI it is a failure (beforeAll throws), because a gate that quietly passes when
 * its tool is missing is the gate that let v0.2.67 out.
 */
const skipSuite = !hasBun && !process.env.CI;

let binary = '';
let workspace = '';
let stubBin = '';
let fakeHome = '';
let fakeDataDir = '';
let queueStubBin = '';
let queueDockerLog = '';
let desktopAppLog = '';

/**
 * The stub directory goes FIRST so `docker`, `git` and the desktop app resolve to the stubs even on
 * a machine that has the real ones. The rest of PATH stays so the CLI's read-only probes (`which`,
 * `ps`) behave as they do in the field.
 */
function cliPath(stubDir: string): string {
  return `${stubDir}:${process.env.PATH ?? ''}`;
}

/** Stand-ins for the desktop app in `dir`: each records how it was called, then exits 0. */
function writeDesktopAppStubs(dir: string): void {
  for (const name of DESKTOP_APP_NAMES) {
    writeFileSync(join(dir, name), ['#!/bin/sh', `echo "$0 $*" >> '${desktopAppLog}'`, 'exit 0', ''].join('\n'));
    chmodSync(join(dir, name), 0o755);
  }
}

function desktopAppCalls(): string[] {
  return existsSync(desktopAppLog) ? readFileSync(desktopAppLog, 'utf-8').split('\n').filter(Boolean) : [];
}

function runCli(
  args: string[],
  options: { stubDir?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; output: string; status: number | null } {
  const result = spawnSync(binary, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: cliPath(options.stubDir ?? stubBin),
      HOME: fakeHome,
      CI_HUB_DATA_DIR: fakeDataDir,
      CI: '1',
      TERM: 'dumb',
      NO_COLOR: '1',
      ...options.env,
    },
    cwd: workspace,
    timeout: 60_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, output: `${stdout}${stderr}`, status: result.status };
}

function expectNoCrash(args: string[], output: string): void {
  for (const pattern of CRASH_PATTERNS) {
    // The failing args are in the message because a bare "expected false to be true" on a table-driven
    // case costs the next person a bisect to find out which command died.
    expect(`cihub ${args.join(' ')} ->\n${output}`).not.toMatch(pattern);
  }
}

describe('compiled cihub binary', () => {
  beforeAll(() => {
    if (skipSuite) return;
    if (!hasBun) {
      throw new Error('bun is required to compile the cihub binary (CI installs it via oven-sh/setup-bun; locally: https://bun.sh)');
    }

    workspace = mkdtempSync(join(tmpdir(), 'cihub-smoke-'));
    stubBin = join(workspace, 'bin');
    fakeHome = join(workspace, 'home');
    mkdirSync(stubBin, { recursive: true });
    // resolveHubContext points `pool update` at the Hub data dir and runs docker with it as cwd; it
    // has to exist or the CLI aborts before reaching the code under test — and Bun reports the
    // missing cwd as `ENOENT ... posix_spawn 'docker'`, which reads as the stub not being on PATH.
    // Where that dir lives by default is per-OS (`~/.local/share` on Linux, `~/Library/Application
    // Support` on macOS, `%APPDATA%` on Windows), so name it through the same override the desktop
    // app uses when it invokes the bundled CLI. That also stops a developer's XDG_DATA_HOME, which
    // rides along in `process.env`, from pointing the binary at their real Hub.
    fakeDataDir = join(fakeHome, 'companion-hub');
    mkdirSync(fakeDataDir, { recursive: true });

    // `docker inspect <container> --format ...` is how discoverComposeIdentity reads the running
    // stack's compose labels. Answering with project `companion-hub` (not `ci-hub`) is what makes
    // the CLI take the DRIFTED-NODE branch — the one whose log line crashed in v0.2.67. Every other
    // verb exits non-zero so `run()` aborts the command immediately instead of pulling an image.
    writeFileSync(
      join(stubBin, 'docker'),
      [
        '#!/bin/sh',
        'if [ "$1" = "inspect" ]; then',
        "  printf 'companion-hub\\n/srv/hub\\n/srv/hub/docker-compose.yml\\n/srv/hub/.env.prod\\n'",
        '  exit 0',
        'fi',
        'echo "[stub docker] $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
    // A stub git too: `pool update` asks whether its target is a checkout, and the answer must not
    // depend on whether TMPDIR happens to sit inside somebody's repository.
    writeFileSync(join(stubBin, 'git'), ['#!/bin/sh', 'echo "[stub git] $*" >&2', 'exit 1', ''].join('\n'));
    chmodSync(join(stubBin, 'docker'), 0o755);
    chmodSync(join(stubBin, 'git'), 0o755);
    desktopAppLog = join(workspace, 'desktop-app-calls.log');
    writeDesktopAppStubs(stubBin);

    // A second docker for the entry-block test: it reports a running, healthy queue — the state a
    // live node is in — and records every call, so a script that reaches for the broker gets far
    // enough to show what it would have done instead of stopping at "not running".
    queueStubBin = join(workspace, 'queue-bin');
    queueDockerLog = join(workspace, 'queue-docker-calls.log');
    mkdirSync(queueStubBin, { recursive: true });
    writeFileSync(
      join(queueStubBin, 'docker'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${queueDockerLog}'`,
        'case "$*" in',
        "  *'{{.State.Running}}'*) echo true; exit 0 ;;",
        "  *'{{.State.Health'*) echo healthy; exit 0 ;;",
        'esac',
        'exit 1',
        '',
      ].join('\n'),
    );
    writeFileSync(join(queueStubBin, 'git'), ['#!/bin/sh', 'exit 1', ''].join('\n'));
    chmodSync(join(queueStubBin, 'docker'), 0o755);
    chmodSync(join(queueStubBin, 'git'), 0o755);
    writeDesktopAppStubs(queueStubBin);

    binary = buildStandaloneCli({ outdir: join(workspace, 'dist') }).outfile;
  }, 180_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * The regression itself. Asserting "no ReferenceError" alone would pass if the CLI bailed before
   * reaching the line, so assert the line's own output: seeing it means runPoolUpdateCommand really
   * executed the call that used to crash.
   */
  it.skipIf(skipSuite)('runs `pool update` past the drifted-stack log that crashed v0.2.67', () => {
    const args = ['pool', 'update'];
    const { output } = runCli(args);

    expectNoCrash(args, output);
    expect(output).toContain('using the running stack: container ci-hub, project companion-hub');
    // Got as far as the redeploy and stopped there, on the stub, having changed nothing. Matched
    // loosely because whether the CLI reaches for `docker pull` or `docker compose ... pull`
    // depends on the pull-image overlay, which is not what this test is about.
    expect(output).toMatch(/\[stub docker\].*pull/);
  });

  /**
   * `cihub --version` on a node whose operator exported the broker and database passwords, with a
   * healthy queue up. While sync-rabbitmq-password.ts called the guard without import.meta.main,
   * merely importing it ran its entry block here: no version line, a `rabbitmqctl change_password`,
   * then `docker compose up --force-recreate ci-hub-queue`, and exit 1. A read-only command reaches
   * no docker verb and writes nothing under HOME.
   */
  it.skipIf(skipSuite)('runs `cihub --version` without firing any script entry block', () => {
    const before = readdirSync(fakeHome, { recursive: true, encoding: 'utf-8' }).sort();
    const { output, status } = runCli(['--version'], {
      stubDir: queueStubBin,
      env: { RABBITMQ_PASSWORD: 'smoke-rabbitmq', POSTGRES_PASSWORD: 'smoke-postgres' },
    });

    expect(output).not.toMatch(SCRIPT_ENTRY_OUTPUT);
    expect(output).toMatch(/^cihub \S+/m);
    expect(status).toBe(0);
    expect(existsSync(queueDockerLog) ? readFileSync(queueDockerLog, 'utf-8') : '').toBe('');
    expect(readdirSync(fakeHome, { recursive: true, encoding: 'utf-8' }).sort()).toEqual(before);
  });

  /**
   * `cihub update` runs `companion-hub update` from PATH. On a machine with the desktop app
   * installed, the real one would replace the app, so the stub has to be what PATH finds, and the
   * hand-off has to reach it and nothing else.
   */
  it.skipIf(skipSuite)('hands `cihub update` to the stub desktop app, not an installed one', () => {
    for (const name of DESKTOP_APP_NAMES) {
      const found = spawnSync('which', [name], { encoding: 'utf-8', env: { ...process.env, PATH: cliPath(stubBin) } });
      expect(found.stdout.trim(), `which ${name}`).toBe(join(stubBin, name));
    }

    const before = desktopAppCalls();
    const { output } = runCli(['update']);

    expectNoCrash(['update'], output);
    expect(desktopAppCalls().slice(before.length)).toEqual([`${join(stubBin, 'companion-hub')} update`]);
  });

  /**
   * Every command the dispatcher knows, in a form that reaches its module and then refuses: help
   * text, a usage error, a removed-command notice, or a read-only listing. The lifecycle commands
   * (`up`, `down`, `reset`, `clean`, `uninstall`, `setup`, `wizard`) are deliberately absent — they
   * mutate or prompt, and `login` blocks on a device-code flow that would need the network.
   */
  const commands: string[][] = [
    ['--help'],
    ['man'],
    ['version'],
    ['status'],
    ['config'],
    ['doctor'],
    ['logs', 'a', 'b', 'c'],
    ['pool'],
    ['pool', 'bogus'],
    ['app'],
    ['app', 'list'],
    ['app', 'bogus'],
    ['models', 'list'],
    ['models', 'bogus'],
    ['api-key', 'list'],
    ['api-key', 'bogus'],
    ['fleet', 'list'],
    ['fleet', 'bogus'],
    ['public-web', 'bogus'],
    ['mcp', 'bogus'],
    ['connect'],
    ['submit'],
    ['logout'],
    ['update'],
    ['catalog'],
    ['shutdown'],
    ['purge'],
    ['start'],
    ['start:detached'],
    ['hot-reload'],
    ['dev'],
    ['bogus-command'],
  ];

  it.skipIf(skipSuite).each(commands.map((args) => [args.join(' '), args] as const))(
    'runs `cihub %s` without a missing-symbol crash or a script entry block',
    (_label, args) => {
      const { output } = runCli([...args]);

      expectNoCrash(args, output);
      expect(`cihub ${args.join(' ')} ->\n${output}`).not.toMatch(SCRIPT_ENTRY_OUTPUT);
      // A command that printed nothing at all did not reach its handler, so the assertion above proved
      // nothing about it.
      expect(output.trim().length).toBeGreaterThan(0);
    },
  );
});
