import { describe, expect, it, vi } from 'vitest';

const runCapture = vi.hoisted(() => vi.fn());
vi.mock('../lib/cli-proc.js', () => ({ runCapture }));

const existsSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ existsSync }));

import {
  buildPoolUpdateComposeArgs,
  composeFilesForPoolUpdate,
  decideGitUpdate,
  describeImageChange,
  describeImageSource,
  gatherGitUpdateFacts,
  resolvePoolUpdateImage,
} from '../lib/cli-pool-update';

describe('decideGitUpdate', () => {
  it('skips a node with no git checkout at all — a pure appliance install', () => {
    const decision = decideGitUpdate({ isRepo: false, branch: null, dirty: false });
    expect(decision).toEqual({ action: 'skip', reason: 'not a git checkout — nothing to update here' });
  });

  it('never fast-forwards over uncommitted changes, however trivial they look', () => {
    const decision = decideGitUpdate({ isRepo: true, branch: 'dev', dirty: true });
    expect(decision.action).toBe('skip');
    expect(decision.action === 'skip' && decision.reason).toContain('uncommitted changes');
  });

  it("leaves a feature branch alone rather than switching it to dev on the operator's behalf", () => {
    const decision = decideGitUpdate({ isRepo: true, branch: 'fix/open-app-data-directory', dirty: false });
    expect(decision.action).toBe('skip');
    expect(decision.action === 'skip' && decision.reason).toContain("'fix/open-app-data-directory'");
  });

  it('reports detached HEAD by name, not as a crash on `null`', () => {
    const decision = decideGitUpdate({ isRepo: true, branch: null, dirty: false });
    expect(decision.action).toBe('skip');
    expect(decision.action === 'skip' && decision.reason).toContain('detached HEAD');
  });

  it('pulls only the one case that is certain to be lossless: clean, and already on dev', () => {
    expect(decideGitUpdate({ isRepo: true, branch: 'dev', dirty: false })).toEqual({ action: 'pull' });
  });
});

describe('gatherGitUpdateFacts', () => {
  it('short-circuits outside a git checkout without reading branch or status', () => {
    runCapture.mockReturnValue({ stdout: '', ok: false });
    const facts = gatherGitUpdateFacts('/data/companion-hub');
    expect(facts).toEqual({ isRepo: false, branch: null, dirty: false });
    // is-inside-work-tree only — no wasted git calls once the answer is already known.
    expect(runCapture).toHaveBeenCalledTimes(1);
    expect(runCapture).toHaveBeenCalledWith('git', ['-C', '/data/companion-hub', 'rev-parse', '--is-inside-work-tree']);
  });

  it('reads branch and dirty state inside a real checkout', () => {
    runCapture
      .mockReturnValueOnce({ stdout: 'true', ok: true }) // is-inside-work-tree
      .mockReturnValueOnce({ stdout: 'dev', ok: true }) // branch --show-current
      .mockReturnValueOnce({ stdout: '', ok: true }); // status --porcelain: clean
    const facts = gatherGitUpdateFacts('/home/ci/devel/CI-Hub');
    expect(facts).toEqual({ isRepo: true, branch: 'dev', dirty: false });
  });

  it('treats any non-empty `git status --porcelain` as dirty, not just modified-tracked files', () => {
    runCapture
      .mockReturnValueOnce({ stdout: 'true', ok: true })
      .mockReturnValueOnce({ stdout: 'dev', ok: true })
      .mockReturnValueOnce({ stdout: '?? scripts/some-untracked-file.ts', ok: true });
    expect(gatherGitUpdateFacts('/x').dirty).toBe(true);
  });
});

describe('buildPoolUpdateComposeArgs', () => {
  it('shares the same base args every other lifecycle command uses when nothing is running', () => {
    const { pullArgs, upArgs } = buildPoolUpdateComposeArgs('/data/companion-hub/.env', ['/data/companion-hub/docker-compose.prod.yml']);
    const base = [
      'compose',
      '--env-file',
      '/data/companion-hub/.env',
      '--project-name',
      'ci-hub',
      '-f',
      '/data/companion-hub/docker-compose.prod.yml',
    ];
    expect(pullArgs).toEqual([...base, 'pull']);
    // `--no-build` is not cosmetic. Two fleet nodes ship a compose file with a build stanza and hold
    // no npm auth token, so an update allowed to fall back to building dies on
    // `pnpm install --frozen-lockfile` instead of pulling the image already built for them.
    expect(upArgs).toEqual([...base, 'up', '-d', '--remove-orphans', '--no-build']);
  });

  it("targets the RUNNING stack when one was discovered, not this checkout's assumptions", () => {
    // The failure this prevents: a node whose data dir was renamed reports project `ci-hub` while
    // compose would infer `companion-hub` from the directory — so `up` tried to CREATE a second
    // container and died on a name conflict, leaving the Hub un-updated.
    const { upArgs } = buildPoolUpdateComposeArgs('.env.prod', ['docker-compose.prod.yml'], {
      container: 'ci-os-hub',
      project: 'ci-hub',
      workingDir: '/home/ci/.local/share/companion-hub',
      configFiles: ['/w/docker-compose.prod.yml', '/w/docker-compose.dev-image.yml'],
      envFiles: ['/w/.env.prod'],
    });
    expect(upArgs).toEqual([
      'compose',
      '--project-name',
      'ci-hub',
      '--env-file',
      '/w/.env.prod',
      '-f',
      '/w/docker-compose.prod.yml',
      '-f',
      '/w/docker-compose.dev-image.yml',
      'up',
      '-d',
      '--remove-orphans',
      '--no-build',
    ]);
  });
});

describe('composeFilesForPoolUpdate', () => {
  /**
   * The bug this whole command exists to fix, reproduced directly: `docker-compose.prod.yml`
   * declares `ci-hub` build-only, so without this overlay `docker compose pull` fetches nothing
   * and `up` silently falls back to a from-source build — the regression a fleet update agent had
   * to work around by hand on every node before this overlay existed.
   */
  it('appends the pull-image overlay when it is present at cwd', () => {
    existsSync.mockReturnValue(true);
    const result = composeFilesForPoolUpdate('/home/ci/devel/CI-Hub', ['docker-compose.prod.yml']);
    expect(result).toEqual({ files: ['docker-compose.prod.yml', 'docker-compose.pull-image.yml'], overlayApplied: true });
  });

  it('leaves the base compose files untouched when the overlay is not there — an appliance data dir has its own seeded copies, never this file', () => {
    existsSync.mockReturnValue(false);
    const result = composeFilesForPoolUpdate('/data/companion-hub', ['/data/companion-hub/docker-compose.prod.yml']);
    expect(result).toEqual({ files: ['/data/companion-hub/docker-compose.prod.yml'], overlayApplied: false });
  });

  it('checks for the overlay at the given cwd, not the process cwd', () => {
    existsSync.mockReturnValue(true);
    composeFilesForPoolUpdate('/home/ci/devel/CI-Hub', []);
    expect(existsSync).toHaveBeenCalledWith('/home/ci/devel/CI-Hub/docker-compose.pull-image.yml');
  });
});

/**
 * Which image `pool update` deploys, and why the env file has to be one of the sources.
 *
 * `run()` hands `CI_HUB_IMAGE` to the compose child in its *environment*, and Docker Compose gives
 * the process environment precedence over `--env-file` — so this function's answer overrides the pin
 * compose was handed. It used to consider only `process.env`, which meant an operator's explicit
 * digest lost to a channel tag. On an appliance that is a downgrade: `resolveHubContext` forces
 * `prod` whatever argument was typed, so `cihub pool update dev` fell through to `…:prod`.
 *
 * The digests are the ones measured on core-6 on 2026-09-21, where exactly this ran and put the
 * node onto a build older than the one it had been serving.
 */
describe('resolvePoolUpdateImage', () => {
  const REPO = 'ghcr.io/companionintelligence/ci-hub';
  const operativePin = `${REPO}@sha256:d8f0b6a0c9550000000000000000000000000000000000000000000000000000`;
  const older = `${REPO}@sha256:8add981ab8b6970097b9dd3b1b28519468e1087be0d15865733300c455b2835b`;

  it('honours the pin in the env file compose actually reads', () => {
    // The regression: without this the digest an operator wrote into .env.dev was discarded.
    expect(resolvePoolUpdateImage({ env: 'prod', processValue: undefined, envFileValue: operativePin })).toEqual({
      image: operativePin,
      source: 'env-file',
    });
  });

  it('never lets the channel tag beat an explicit pin — the downgrade that was measured', () => {
    const resolved = resolvePoolUpdateImage({ env: 'prod', processValue: undefined, envFileValue: operativePin });
    expect(resolved.image).not.toBe(`${REPO}:prod`);
    expect(resolved.image).not.toBe(older);
  });

  it('lets a reference given on the command line win over the file, for a deliberate one-off roll', () => {
    expect(resolvePoolUpdateImage({ env: 'prod', processValue: `${REPO}:dev`, envFileValue: operativePin })).toEqual({
      image: `${REPO}:dev`,
      source: 'process-env',
    });
  });

  it('falls back to the tag matching the environment only when nothing is pinned anywhere', () => {
    expect(resolvePoolUpdateImage({ env: 'dev', processValue: undefined, envFileValue: undefined })).toEqual({
      image: `${REPO}:dev`,
      source: 'channel-default',
    });
    expect(resolvePoolUpdateImage({ env: 'prod', processValue: undefined, envFileValue: undefined }).image).toBe(`${REPO}:prod`);
  });

  it('treats a blank value (set but empty) the same as unset at every level', () => {
    expect(resolvePoolUpdateImage({ env: 'dev', processValue: '   ', envFileValue: '  ' }).source).toBe('channel-default');
    expect(resolvePoolUpdateImage({ env: 'dev', processValue: '   ', envFileValue: operativePin }).source).toBe('env-file');
  });

  it('names the source on the line it prints, so a fallback is not mistaken for a pin', () => {
    expect(describeImageSource('env-file', '/data/.env.dev')).toContain('/data/.env.dev');
    expect(describeImageSource('process-env', '/data/.env.dev')).toContain('environment');
    expect(describeImageSource('channel-default', '/data/.env.dev')).toContain('no CI_HUB_IMAGE');
  });
});

describe('describeImageChange', () => {
  const at = (revision: string | null, imageCreatedIso: string | null = null) => ({ revision, imageCreatedIso });

  it('reports the move when the revision changed', () => {
    const moved = describeImageChange(at('53fc3ea9bb11f34e'), at('6c343b78a754c36a'));
    expect(moved).toEqual({ changed: true, warn: false, line: 'image 53fc3ea9b → 6c343b78a' });
  });

  it('WARNS when the image did not move — a pull that fetched nothing answers health like a real update', () => {
    const moved = describeImageChange(at('53fc3ea9bb11f34e'), at('53fc3ea9bb11f34e'));
    expect(moved.changed).toBe(false);
    expect(moved.warn).toBe(true);
    expect(moved.line).toContain('did NOT change');
    expect(moved.line).toContain('could not reach the registry');
  });

  it('warns rather than claiming success when the build stamps no revision to compare', () => {
    const moved = describeImageChange(at(null), at(null));
    expect(moved).toEqual({
      changed: false,
      warn: true,
      line: 'could not tell whether the image changed — this build stamps no org.opencontainers.image.revision to compare',
    });
  });

  it('falls back to build time when there is no revision label but the image was rebuilt', () => {
    const moved = describeImageChange(at(null, '2026-09-10T00:00:00Z'), at(null, '2026-09-17T00:00:00Z'));
    expect(moved.changed).toBe(true);
    expect(moved.line).toContain('no revision label to compare');
  });

  it('treats a first-ever container as a change, not as "unchanged"', () => {
    const moved = describeImageChange(null, at('6c343b78a754c36a'));
    expect(moved).toEqual({ changed: true, warn: false, line: 'Hub container created on image 6c343b78a' });
  });

  it('warns when the container cannot be read after the redeploy', () => {
    const moved = describeImageChange(at('53fc3ea9bb11f34e'), null);
    expect(moved.warn).toBe(true);
    expect(moved.line).toContain('unverified');
  });
});
