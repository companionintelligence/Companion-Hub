/**
 * `cihub self-update` — move the CLI onto the build the stack is on, in place.
 *
 * The CLI and the Hub stack update on two channels that never meet (see cli-version-skew.ts). On a
 * machine where a package manager owns the binary there is already a command for this, and running
 * it is the operator's business. On a headless appliance there was none: the CLI arrives as a
 * standalone `cihub-<os>-<arch>` release asset streamed in by `cihub fleet install`, and from then
 * on nothing ever moves it. beta-max sat on 0.2.72 while its stack rolled past it, and `cihub pool
 * ceiling` — merged and documented — answered `Unknown pool subcommand`.
 *
 * Two constraints shape everything here:
 *
 * - **The releases are private.** A node cannot fetch them; `api.github.com/…/releases/latest`
 *   answers 404 unauthenticated, which is what broke a fifteen-node install on 2026-09-18. So this
 *   needs a token in the environment and says so plainly when there is none, rather than failing
 *   with a 404 that reads like a missing release.
 * - **A package manager's file is not ours to overwrite.** Writing a new binary into a Homebrew
 *   Cellar or a Scoop app directory leaves the manifest claiming a version that is not on disk, and
 *   the next `brew upgrade` silently reverts it. Those channels are refused with their own command.
 *
 * The plan is pure and the effect is not: {@link planSelfUpdate} decides and explains, and
 * {@link installBinaryOverSelf} is the only function that writes.
 */
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type CliInstallChannel, cliUpdateInstructions, normalizeVersion } from './cli-version-skew.js';
import { assetNameForPlatform, GITHUB_TOKEN_ENV_VARS, parseCihubVersionOutput } from './fleet-cihub-binary.js';

export type SelfUpdatePlan =
  | { ok: true; assetName: string; version: string; target: string; token: string; reason: string }
  | { ok: false; why: string; fix: string[] };

export interface SelfUpdatePlanInput {
  channel: CliInstallChannel;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** `--to <version>`, when the operator named one. */
  requestedVersion?: string;
  /** The release the running stack is on, when it has one. The default target: match the stack. */
  stackVersion?: string | null;
}

/**
 * What a self-update would do, or why it will not happen.
 *
 * The default target is deliberately the *stack's* release rather than `latest`: the point of the
 * command is to end the skew on this machine, and pulling the newest release onto a node whose
 * stack is pinned two versions back would just invert it.
 */
export function planSelfUpdate(input: SelfUpdatePlanInput): SelfUpdatePlan {
  const { channel } = input;
  if (channel.kind !== 'standalone') {
    return {
      ok: false,
      why:
        channel.kind === 'source'
          ? 'this cihub runs from a source checkout, so there is no binary to replace'
          : `this cihub is installed by ${channel.kind === 'desktop' ? 'the Companion Hub desktop app' : channel.kind}, which owns the file`,
      fix: cliUpdateInstructions(channel),
    };
  }

  const assetName = assetNameForPlatform(input.platform, input.arch);
  if (!assetName) {
    return {
      ok: false,
      why: `no cihub release asset is published for ${input.platform}/${input.arch}`,
      fix: ['Build one from a checkout: node scripts/build-standalone-cli.cjs'],
    };
  }

  if (input.platform === 'win32') {
    return {
      ok: false,
      why: 'Windows cannot replace a running executable, so a self-update here would leave a half-written cihub.exe',
      fix: ['scoop update companion-hub', `or download ${assetName} from the release and replace ${channel.path} while cihub is not running`],
    };
  }

  const token = GITHUB_TOKEN_ENV_VARS.map((name) => input.env[name]?.trim()).find(Boolean);
  if (!token) {
    return {
      ok: false,
      why: 'the CI-Hub releases are private, so fetching the cihub asset needs a GitHub token',
      fix: ['GH_TOKEN="$(gh auth token)" cihub self-update', 'or copy the asset over by hand: cihub fleet install --cihub-binary <path>'],
    };
  }

  const requested = input.requestedVersion?.trim();
  if (requested && requested !== 'latest') {
    return { ok: true, assetName, version: normalizeVersion(requested), target: channel.path, token, reason: 'the version you asked for' };
  }
  if (!requested && input.stackVersion) {
    return {
      ok: true,
      assetName,
      version: normalizeVersion(input.stackVersion),
      target: channel.path,
      token,
      reason: 'the release this Hub stack runs',
    };
  }
  return {
    ok: true,
    assetName,
    version: 'latest',
    target: channel.path,
    token,
    reason: input.stackVersion ? 'the newest release' : 'the newest release; the running stack names no release to match',
  };
}

export type BinaryProbe = (binaryPath: string) => { ok: boolean; stdout: string };

const probeWithSpawn: BinaryProbe = (binaryPath) => {
  const result = spawnSync(binaryPath, ['version'], { encoding: 'utf8', timeout: 20_000 });
  return { ok: result.status === 0, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

export interface InstallResult {
  ok: boolean;
  /** What the replacement binary reports for `cihub version`, when it ran. */
  installedVersion?: string;
  message: string;
}

/**
 * Put `sourcePath` in place of `targetPath`, and refuse to do it blind.
 *
 * Order matters and each step is a failure this has to survive without leaving the operator without
 * a `cihub` at all:
 *
 * 1. Copy the bytes next to the target first. `rename` is atomic only within one filesystem, and the
 *    download cache is in `/tmp`, which on an appliance is frequently a different one.
 * 2. Run the candidate and make it say what it is. A downloaded asset for the wrong architecture
 *    exits 126 and would otherwise be installed over a working CLI.
 * 3. Only then rename over the target. A running process keeps its open image, so replacing the
 *    file under it is safe on Linux and macOS; Windows is refused in {@link planSelfUpdate}.
 */
export function installBinaryOverSelf(input: {
  sourceBytes: Buffer;
  targetPath: string;
  expectedVersion?: string;
  probe?: BinaryProbe;
}): InstallResult {
  const probe = input.probe ?? probeWithSpawn;
  const staged = `${input.targetPath}.cihub-self-update-${process.pid}`;
  try {
    writeFileSync(staged, input.sourceBytes, { mode: 0o755 });
    chmodSync(staged, 0o755);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    rmSync(staged, { force: true });
    return { ok: false, message: `could not stage the new binary beside ${input.targetPath}: ${detail}` };
  }

  const probed = probe(staged);
  const installedVersion = parseCihubVersionOutput(probed.stdout);
  if (!probed.ok || !installedVersion) {
    rmSync(staged, { force: true });
    return {
      ok: false,
      message: `the downloaded binary did not run here (${probed.stdout.trim().split('\n')[0] || 'no output'}); nothing was replaced`,
    };
  }
  if (input.expectedVersion && normalizeVersion(installedVersion) !== normalizeVersion(input.expectedVersion)) {
    rmSync(staged, { force: true });
    return {
      ok: false,
      installedVersion,
      message: `the asset for ${input.expectedVersion} reports itself as ${installedVersion}; nothing was replaced`,
    };
  }

  try {
    renameSync(staged, input.targetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    rmSync(staged, { force: true });
    return { ok: false, message: `could not replace ${input.targetPath}: ${detail}` };
  }
  return { ok: true, installedVersion, message: `replaced ${input.targetPath} with cihub ${installedVersion}` };
}

/** Is the path we are about to replace a real file we can see? Reported, never assumed. */
export function describeTarget(targetPath: string): string {
  if (!existsSync(targetPath)) return `${targetPath} (missing?)`;
  try {
    return `${targetPath} (${statSync(targetPath).size} bytes)`;
  } catch {
    return targetPath;
  }
}

export function selfUpdateUsage(baseCommand: string): string {
  return [
    `Usage: ${baseCommand} self-update [--to <version>] [--check]`,
    '',
    '  --to <version>  install this release instead of the one the running stack is on',
    '  --check         report what would be installed and change nothing',
    '',
    `Needs GH_TOKEN or GITHUB_TOKEN: ${path.basename(baseCommand)} releases are private.`,
  ].join('\n');
}
