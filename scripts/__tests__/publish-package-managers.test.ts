/**
 * The Hub's package-manager publisher writes into two repos it shares with other apps.
 *
 * `homebrew-tap` and `scoop-bucket` also hold entries the Hub does not own: the Companion Capture and
 * Companion Memory cask and Scoop manifest, and the Agent Sync formula. They are maintained outside this
 * repo. The publisher used to mirror its Hub-only `distribution/publish/` into them with
 * `rsync -a --delete`, so the next Hub production release deleted every one of them (and a README that
 * someone had extended).
 *
 * These tests run the real `distribution/scripts/publish-package-managers.sh` end to end: real git, real
 * clone/commit/push, against local bare repos that git's `url.<base>.insteadOf` setting substitutes for the
 * GitHub URL, with a fake `gh`. They pin what the publisher may touch: the Hub's own files change and
 * nothing else does.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const publisher = path.join(repoRoot, 'distribution/scripts/publish-package-managers.sh');
const syncHelper = path.join(repoRoot, 'distribution/scripts/sync-published-files.sh');
const publishDir = path.join(repoRoot, 'distribution/publish');

const GITHUB_BASE = 'https://x-access-token:test-token@github.com/companionintelligence/';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

const read = (file: string) => fs.readFileSync(file, 'utf-8');

/** Files other apps keep in the shared repos. None of them exists under distribution/publish/. */
const OTHER_APPS = {
  'homebrew-tap': {
    'Casks/companion-capture.rb': '# capture cask\ncask "companion-capture" do\n  version "0.2.0-alpha.8"\nend\n',
    'Casks/companion-memory.rb': '# memory cask\ncask "companion-memory" do\n  version "0.1.3"\nend\n',
    'Formula/agent-sync.rb': '# agent-sync formula\nclass AgentSync < Formula\nend\n',
  },
  'scoop-bucket': {
    'companion-capture.json': '{"version":"0.2.0-alpha.8"}\n',
    'companion-memory.json': '{"version":"0.1.3"}\n',
  },
} as const;

/** A README that has grown past what the Hub publishes: it lists the other apps too. */
const EXTENDED_README = '# shared repo\n\nInstall Companion Hub, Companion Capture or Companion Memory.\n';

let root: string;
let remotes: string;
let fakeBin: string;

function bareRemote(name: 'homebrew-tap' | 'scoop-bucket', files: Record<string, string>): string {
  const bare = path.join(remotes, `${name}.git`);
  git(remotes, 'init', '--bare', '-b', 'main', bare);
  const seed = fs.mkdtempSync(path.join(root, `seed-${name}-`));
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', bare, 'main');
  return bare;
}

function runPublisher(): { status: number | null; output: string } {
  const result = spawnSync('bash', [publisher, 'companion-hub vTEST'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_TOKEN: 'test-token',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: GITHUB_BASE,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const remoteFiles = (bare: string) => git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort();
const remoteFile = (bare: string, file: string) => git(bare, 'show', `main:${file}`);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-package-managers-'));
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  // The publisher only asks `gh` who the token belongs to and whether it can push.
  fs.writeFileSync(
    path.join(fakeBin, 'gh'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "api user --jq .login") echo hub-publisher ;;',
      '  "api repos/companionintelligence/homebrew-tap"|"api repos/companionintelligence/scoop-bucket") ;;',
      '  api\\ repos/companionintelligence/*\\ --jq\\ *permissions.push*) echo true ;;',
      '  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

// Every test gets its own pair of bare remotes.
beforeEach(() => {
  remotes = fs.mkdtempSync(path.join(root, 'remotes-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('publish-package-managers.sh', () => {
  it('never mirrors with --delete', () => {
    const scripts = fs
      .readdirSync(path.dirname(publisher))
      .filter((name) => name.endsWith('.sh'))
      .map((name) => [name, read(path.join(path.dirname(publisher), name))] as const);
    for (const [name, text] of scripts) {
      const executable = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
      expect(executable.join('\n'), `${name} runs a destructive sync`).not.toMatch(/--delete\b|\brsync\b/);
    }
  });

  it('publishes the Hub files and leaves every other app and the extended README alone', () => {
    const tap = bareRemote('homebrew-tap', {
      'Casks/companion-hub.rb': '# stale hub cask\n',
      'README.md': EXTENDED_README,
      ...OTHER_APPS['homebrew-tap'],
    });
    const bucket = bareRemote('scoop-bucket', {
      'companion-hub.json': '{"version":"stale"}\n',
      'README.md': EXTENDED_README,
      ...OTHER_APPS['scoop-bucket'],
    });

    const run = runPublisher();
    expect(run.status, run.output).toBe(0);

    // The Hub's own files are the ones in distribution/publish/.
    expect(remoteFile(tap, 'Casks/companion-hub.rb')).toBe(read(path.join(publishDir, 'homebrew-tap/Casks/companion-hub.rb')).trim());
    expect(remoteFile(bucket, 'companion-hub.json')).toBe(read(path.join(publishDir, 'scoop-bucket/companion-hub.json')).trim());

    // Everything else is exactly what it was.
    for (const [file, content] of Object.entries(OTHER_APPS['homebrew-tap'])) {
      expect(remoteFile(tap, file), `homebrew-tap ${file}`).toBe(content.trim());
    }
    for (const [file, content] of Object.entries(OTHER_APPS['scoop-bucket'])) {
      expect(remoteFile(bucket, file), `scoop-bucket ${file}`).toBe(content.trim());
    }
    expect(remoteFile(tap, 'README.md')).toBe(EXTENDED_README.trim());
    expect(remoteFile(bucket, 'README.md')).toBe(EXTENDED_README.trim());

    // Nothing was added or removed besides the Hub files.
    expect(remoteFiles(tap)).toEqual(['Casks/companion-hub.rb', 'README.md', ...Object.keys(OTHER_APPS['homebrew-tap'])].sort());
    expect(remoteFiles(bucket)).toEqual(['companion-hub.json', 'README.md', ...Object.keys(OTHER_APPS['scoop-bucket'])].sort());

    // A second run has nothing to publish and leaves the history alone.
    const tapHead = git(tap, 'rev-parse', 'main');
    const bucketHead = git(bucket, 'rev-parse', 'main');
    const again = runPublisher();
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain('No changes for homebrew-tap');
    expect(again.output).toContain('No changes for scoop-bucket');
    expect(git(tap, 'rev-parse', 'main')).toBe(tapHead);
    expect(git(bucket, 'rev-parse', 'main')).toBe(bucketHead);
  });

  it('seeds the README of a repo that has none, from distribution/publish/', () => {
    const tap = bareRemote('homebrew-tap', { 'Casks/companion-capture.rb': OTHER_APPS['homebrew-tap']['Casks/companion-capture.rb'] });
    const bucket = bareRemote('scoop-bucket', { 'companion-capture.json': OTHER_APPS['scoop-bucket']['companion-capture.json'] });

    const run = runPublisher();
    expect(run.status, run.output).toBe(0);

    expect(remoteFile(tap, 'README.md')).toBe(read(path.join(publishDir, 'homebrew-tap/README.md')).trim());
    expect(remoteFile(bucket, 'README.md')).toBe(read(path.join(publishDir, 'scoop-bucket/README.md')).trim());
    expect(remoteFile(tap, 'Casks/companion-capture.rb')).toBe(OTHER_APPS['homebrew-tap']['Casks/companion-capture.rb'].trim());
  });
});

describe('sync-published-files.sh', () => {
  const sync = (source: string, dest: string) => spawnSync('bash', [syncHelper, source, dest], { encoding: 'utf-8' });

  it('copies new and changed files, creating folders, and deletes nothing', () => {
    const source = fs.mkdtempSync(path.join(root, 'src-'));
    const dest = fs.mkdtempSync(path.join(root, 'dest-'));
    fs.mkdirSync(path.join(source, 'Casks'));
    fs.writeFileSync(path.join(source, 'Casks/hub.rb'), 'new\n');
    fs.writeFileSync(path.join(source, 'extra file.json'), '{}\n');
    fs.mkdirSync(path.join(dest, 'Casks'));
    fs.writeFileSync(path.join(dest, 'Casks/hub.rb'), 'old\n');
    fs.writeFileSync(path.join(dest, 'Casks/other.rb'), 'keep\n');
    fs.mkdirSync(path.join(dest, '.git'));
    fs.writeFileSync(path.join(dest, '.git/HEAD'), 'ref: refs/heads/main\n');

    const run = sync(source, dest);
    expect(run.status, run.stderr).toBe(0);
    expect(read(path.join(dest, 'Casks/hub.rb'))).toBe('new\n');
    expect(read(path.join(dest, 'extra file.json'))).toBe('{}\n');
    expect(read(path.join(dest, 'Casks/other.rb'))).toBe('keep\n');
    expect(read(path.join(dest, '.git/HEAD'))).toBe('ref: refs/heads/main\n');
    expect(run.stdout).toContain('wrote   Casks/hub.rb');
    expect(run.stdout).toContain('Synced 2 file(s)');
  });

  it('writes nothing when the destination already matches', () => {
    const source = fs.mkdtempSync(path.join(root, 'src-'));
    const dest = fs.mkdtempSync(path.join(root, 'dest-'));
    fs.writeFileSync(path.join(source, 'a.json'), '{}\n');
    fs.writeFileSync(path.join(dest, 'a.json'), '{}\n');

    const run = sync(source, dest);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('Synced 0 file(s)');
    expect(run.stdout).not.toContain('wrote');
  });

  it('refuses a missing source or destination instead of guessing', () => {
    const dir = fs.mkdtempSync(path.join(root, 'only-'));
    expect(sync(path.join(dir, 'nope'), dir).status).toBe(1);
    expect(sync(dir, path.join(dir, 'nope')).status).toBe(1);
    expect(spawnSync('bash', [syncHelper, dir], { encoding: 'utf-8' }).status).toBe(2);
  });
});
