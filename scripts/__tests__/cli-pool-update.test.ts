import { describe, expect, it, vi } from 'vitest';

const runCapture = vi.hoisted(() => vi.fn());
vi.mock('../lib/cli-proc.js', () => ({ runCapture }));

import { buildPoolUpdateComposeArgs, decideGitUpdate, gatherGitUpdateFacts } from '../lib/cli-pool-update';

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
  it('shares the same base args every other lifecycle command uses — same project name, same env file, same compose files', () => {
    const { pullArgs, upArgs } = buildPoolUpdateComposeArgs('/data/companion-hub/.env', ['/data/companion-hub/docker-compose.prod.yml']);
    expect(pullArgs).toEqual([
      'compose',
      '--env-file',
      '/data/companion-hub/.env',
      '--project-name',
      'ci-hub',
      '-f',
      '/data/companion-hub/docker-compose.prod.yml',
      'pull',
    ]);
    expect(upArgs).toEqual([
      'compose',
      '--env-file',
      '/data/companion-hub/.env',
      '--project-name',
      'ci-hub',
      '-f',
      '/data/companion-hub/docker-compose.prod.yml',
      'up',
      '-d',
      '--remove-orphans',
    ]);
  });

  it('never passes --build — the whole point is updating without a build toolchain', () => {
    const { pullArgs, upArgs } = buildPoolUpdateComposeArgs('.env.prod', ['docker-compose.prod.yml']);
    expect(pullArgs).not.toContain('--build');
    expect(upArgs).not.toContain('--build');
  });

  it('passes multiple compose files as repeated -f flags, in order', () => {
    const { pullArgs } = buildPoolUpdateComposeArgs('.env.prod', ['a.yml', 'b.yml']);
    expect(pullArgs.filter((a) => a === '-f')).toHaveLength(2);
    expect(pullArgs).toEqual(expect.arrayContaining(['-f', 'a.yml', '-f', 'b.yml']));
  });
});
