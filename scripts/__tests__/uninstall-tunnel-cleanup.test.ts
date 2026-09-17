/**
 * Uninstall cleanup of the Cloudflare tunnel folder.
 *
 * The desktop keeps its tunnel token in `tunnel/` beside its data folder (compose mounts
 * `${ROOT_FOLDER_HOST}/../tunnel`), so the uninstallers that only delete the named Hub folders
 * left the token behind and a reinstall reconnected the old tunnel before pairing. `tunnel` is
 * a generic folder name, so these tests pin both halves of the fix: the Hub's files go, and
 * anything else in that folder stays.
 *
 * The Linux scripts are executed for real, but only inside a sandbox: PATH holds nothing except
 * links to a few coreutils plus a fake `getent` (one passwd row pointing at a temp HOME) and a
 * fake `docker` that prints nothing. The real `getent` is unreachable, so a script can never
 * enumerate — and purge — the real users' homes, even if the fake were missing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf-8');

const LINUX_SCRIPTS = {
  deb: 'packages/desktop/src-tauri/linux/deb/postrm',
  rpm: 'packages/desktop/src-tauri/linux/rpm/postun',
  aur: 'distribution/aur/companion-hub-bin.install',
  snap: 'snap/hooks/remove',
  shared: 'distribution/scripts/uninstall-cleanup.sh',
} as const;

const PS_SCRIPT = 'distribution/scripts/uninstall-cleanup.ps1';
const BEGIN = '# BEGIN hub tunnel folder cleanup';
const END = '# END hub tunnel folder cleanup';

function extractBlock(source: string, file: string): string {
  const start = source.indexOf(BEGIN);
  expect(start, `${BEGIN} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(END, start);
  expect(end, `${END} not found in ${file}`).toBeGreaterThan(start);
  return source.slice(start, end + END.length);
}

const dedent = (block: string) =>
  block
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');

/** A token in cloudflared's format: base64 of {"a": account tag, "t": tunnel id, "s": secret}. */
function cloudflaredToken({ padded }: { padded: boolean }): string {
  for (let secretBytes = 32; secretBytes < 40; secretBytes++) {
    const payload = JSON.stringify({
      a: '0123456789abcdef0123456789abcdef',
      t: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
      s: Buffer.alloc(secretBytes, 7).toString('base64'),
    });
    const token = Buffer.from(payload).toString('base64');
    if (token.endsWith('=')) {
      return padded ? token : token.replace(/=+$/, '');
    }
  }
  throw new Error('could not build a padded token');
}

const REAL_TOKEN = cloudflaredToken({ padded: true });

function findExecutable(tool: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const tempRoots: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface TunnelFixture {
  token?: string | null;
  registration?: string | null;
  leftover?: string | null;
  userCleared?: boolean;
  certsFiles?: string[];
  extraFiles?: string[];
}

/** Populate `<dir>/tunnel` the way a paired Hub leaves it, with per-test overrides. */
function writeTunnelDir(parent: string, fixture: TunnelFixture = {}): string {
  const tunnel = path.join(parent, 'tunnel');
  fs.mkdirSync(path.join(tunnel, 'certs'), { recursive: true });
  const token = fixture.token === undefined ? REAL_TOKEN : fixture.token;
  if (token !== null) fs.writeFileSync(path.join(tunnel, 'token'), token);
  const registration =
    fixture.registration === undefined
      ? JSON.stringify({ tunnelId: '6ff42ae2-765d-4adf-8112-31c55c1551ef', writtenAt: '2026-09-17T00:00:00.000Z' })
      : fixture.registration;
  if (registration !== null) fs.writeFileSync(path.join(tunnel, 'registration.json'), registration);
  const leftover = fixture.leftover === undefined ? JSON.stringify({ tunnelId: null, foundAt: '2026-09-17T00:00:00.000Z' }) : fixture.leftover;
  if (leftover !== null) fs.writeFileSync(path.join(tunnel, 'leftover.json'), leftover);
  if (fixture.userCleared ?? true) fs.writeFileSync(path.join(tunnel, '.user-cleared-token'), '1');
  for (const name of fixture.certsFiles ?? []) fs.writeFileSync(path.join(tunnel, 'certs', name), 'PEM');
  for (const name of fixture.extraFiles ?? []) fs.writeFileSync(path.join(tunnel, name), 'not the Hub');
  return tunnel;
}

const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

describe('Linux uninstall scripts clean the tunnel folder', () => {
  it('carry an identical helper block', () => {
    const reference = dedent(extractBlock(read(LINUX_SCRIPTS.deb), LINUX_SCRIPTS.deb));
    for (const [name, file] of Object.entries(LINUX_SCRIPTS)) {
      const block = dedent(extractBlock(read(file), file));
      expect(block, `${name} helper drifted from the deb postrm copy`).toBe(reference);
    }
  });

  it.each(Object.entries(LINUX_SCRIPTS))('%s cleans the tunnel folder beside the data folder it removes', (_name, file) => {
    expect(read(file)).toContain('cleanup_hub_tunnel_dir "$xdg_data_home/tunnel"');
  });

  it('AUR runs cleanup only from post_remove, never on upgrade', () => {
    const aur = read(LINUX_SCRIPTS.aur);
    expect(aur).toMatch(/^post_remove\(\) \{/m);
    expect(aur).not.toMatch(/(pre|post)_upgrade\s*\(\)/);
  });
});

describe.skipIf(process.platform === 'win32')('Linux uninstall scripts in a sandbox', () => {
  let sandbox: string;
  let bin: string;
  let shell: string;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-uninstall-sandbox-'));
    bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const realShell = findExecutable('sh');
    if (!realShell) throw new Error('sh not found');
    for (const tool of ['sh', 'awk', 'rm', 'rmdir', 'tr', 'base64', 'wc', 'grep', 'readlink', 'cat']) {
      const real = findExecutable(tool);
      if (!real) throw new Error(`${tool} not found on PATH`);
      fs.symlinkSync(real, path.join(bin, tool));
    }
    fs.writeFileSync(
      path.join(bin, 'getent'),
      `#!${realShell}\n[ "$1" = passwd ] || exit 2\nprintf 'hubtester:x:1000:1000::%s:/bin/sh\\n' "$FAKE_HOME"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'docker'), `#!${realShell}\nexit 0\n`, { mode: 0o755 });
    shell = path.join(bin, 'sh');
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function run(args: string[], home: string) {
    const result = spawnSync(shell, args, {
      cwd: home,
      encoding: 'utf-8',
      env: { PATH: bin, HOME: home, FAKE_HOME: home, LC_ALL: 'C' },
    });
    return result;
  }

  /** Refuse to run any script unless the sandbox demonstrably lists only the temp home. */
  function assertSandboxed(home: string) {
    const probe = run(['-c', 'command -v getent; getent passwd'], home);
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe(`${path.join(bin, 'getent')}\nhubtester:x:1000:1000::${home}:/bin/sh\n`);
  }

  function runHelper(tunnelDir: string, home: string) {
    const block = extractBlock(read(LINUX_SCRIPTS.deb), LINUX_SCRIPTS.deb);
    const result = run(['-c', `set -eu\n${block}\ncleanup_hub_tunnel_dir "$1"\necho finished`, 'sh', tunnelDir], home);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('finished\n');
    expect(result.status).toBe(0);
  }

  function makeHome(fixture?: TunnelFixture) {
    const home = tempDir('ci-hub-uninstall-home-');
    const share = path.join(home, '.local', 'share');
    fs.mkdirSync(path.join(share, 'companion-hub', 'state'), { recursive: true });
    fs.writeFileSync(path.join(share, 'companion-hub', 'state', 'settings.json'), '{}');
    fs.mkdirSync(path.join(share, 'other-app'), { recursive: true });
    fs.writeFileSync(path.join(share, 'other-app', 'data'), 'keep');
    const tunnel = writeTunnelDir(share, fixture);
    return { home, share, tunnel };
  }

  describe('helper', () => {
    it('removes a cloudflared token, the markers, empty certs and then the folder', () => {
      const { home, tunnel } = makeHome();
      runHelper(tunnel, home);
      expect(fs.existsSync(tunnel)).toBe(false);
    });

    it('recognizes a token whose base64 padding was stripped', () => {
      const { home, tunnel } = makeHome({ token: `${cloudflaredToken({ padded: false })}\n` });
      runHelper(tunnel, home);
      expect(fs.existsSync(tunnel)).toBe(false);
    });

    it.each([
      ['plain text', 'hello world'],
      ['base64 of JSON without the token keys', Buffer.from('{"id":"x","name":"y"}').toString('base64')],
      ['empty', ''],
    ])('keeps a token file that is %s, and the folder with it', (_label, content) => {
      const { home, tunnel } = makeHome({ token: content });
      runHelper(tunnel, home);
      expect(listDir(tunnel)).toEqual(['token']);
    });

    it('keeps unrelated files and the folder after removing the Hub files', () => {
      const { home, tunnel } = makeHome({ extraFiles: ['notes.txt', 'config.yml'] });
      runHelper(tunnel, home);
      expect(listDir(tunnel)).toEqual(['config.yml', 'notes.txt']);
    });

    it('keeps registration.json and leftover.json that are not Hub markers', () => {
      const { home, tunnel } = makeHome({ registration: '{"id":1}', leftover: 'leftover notes' });
      runHelper(tunnel, home);
      expect(listDir(tunnel)).toEqual(['leftover.json', 'registration.json']);
    });

    it('keeps a certs folder that has files in it', () => {
      const { home, tunnel } = makeHome({ certsFiles: ['custom-ca.pem'] });
      runHelper(tunnel, home);
      expect(listDir(tunnel)).toEqual(['certs']);
      expect(listDir(path.join(tunnel, 'certs'))).toEqual(['custom-ca.pem']);
    });

    it('does not follow a symlinked tunnel folder', () => {
      const { home, share } = makeHome();
      const elsewhere = tempDir('ci-hub-uninstall-elsewhere-');
      const target = writeTunnelDir(elsewhere);
      const link = path.join(share, 'linked-tunnel');
      fs.symlinkSync(target, link);
      runHelper(link, home);
      expect(listDir(target)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
    });

    it('is a no-op when the folder does not exist', () => {
      const home = tempDir('ci-hub-uninstall-home-');
      runHelper(path.join(home, '.local', 'share', 'tunnel'), home);
    });
  });

  function expectPurged({ share, tunnel }: { share: string; tunnel: string }) {
    expect(fs.existsSync(path.join(share, 'companion-hub'))).toBe(false);
    expect(fs.existsSync(tunnel)).toBe(false);
    expect(listDir(path.join(share, 'other-app'))).toEqual(['data']);
  }

  function expectUntouched({ share, tunnel }: { share: string; tunnel: string }) {
    expect(listDir(path.join(share, 'companion-hub', 'state'))).toEqual(['settings.json']);
    expect(listDir(tunnel)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
    expect(fs.readFileSync(path.join(tunnel, 'token'), 'utf-8')).toBe(REAL_TOKEN);
  }

  // postrm's CLI-symlink step acts on /usr/bin/cihub, which only root could change.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('deb postrm remove purges the data folder and the tunnel files', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.deb), 'remove'], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectPurged(fixture);
  });

  it.each(['upgrade', 'failed-upgrade', 'abort-upgrade', 'abort-install'])('deb postrm %s leaves everything in place', (action) => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.deb), action], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectUntouched(fixture);
  });

  it('rpm postun on final erase purges the data folder and the tunnel files', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.rpm), '0'], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectPurged(fixture);
  });

  it('rpm postun during an upgrade leaves everything in place', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.rpm), '1'], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectUntouched(fixture);
  });

  it('snap remove hook purges the data folder and the tunnel files', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.snap)], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectPurged(fixture);
  });

  it('AUR post_remove purges the data folder and the tunnel files', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run(['-c', '. "$1" && post_remove', 'sh', path.join(repoRoot, LINUX_SCRIPTS.aur)], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectPurged(fixture);
  });

  it('shared uninstall-cleanup.sh purges the data folder and the tunnel files', () => {
    const fixture = makeHome();
    assertSandboxed(fixture.home);
    const result = run([path.join(repoRoot, LINUX_SCRIPTS.shared)], fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expectPurged(fixture);
  });
});

describe('Windows uninstall cleanup of the tunnel folder', () => {
  const ps = read(PS_SCRIPT);

  it('cleans %APPDATA%\\tunnel for the current user and every profile', () => {
    expect(ps).toContain("Remove-HubTunnelFiles (Join-Path $appData 'tunnel')");
    expect(ps).toContain("Remove-HubTunnelFiles (Join-Path $profilePath 'AppData\\Roaming\\tunnel')");
  });

  it('NSIS hook skips the whole cleanup when the uninstaller runs in update mode', () => {
    const hooks = read('packages/desktop/src-tauri/windows/installer-hooks.nsh');
    const guard = hooks.indexOf('StrCmp $UpdateMode "1" ci_hub_skip_cleanup');
    expect(guard, 'update-mode guard missing').toBeGreaterThan(hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL'));
    expect(guard).toBeLessThan(hooks.indexOf('nsExec::ExecToLog'));
  });

  it('MSI cleanup stays limited to a full removal that is not an upgrade', () => {
    const wix = read('packages/desktop/src-tauri/windows/cleanup-on-uninstall.wxs');
    const conditions = wix.match(/<Custom Action="[^"]+"[^>]*>\s*<!\[CDATA\[([^\]]*)\]\]>/g) ?? [];
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition).toContain('(REMOVE="ALL") AND (NOT UPGRADINGPRODUCTCODE)');
    }
  });

  it('Scoop, which runs its uninstaller on every update, never touches the tunnel folder', () => {
    const generator = read('distribution/scripts/update-package-manifests.sh');
    const scoopTemplate = generator.slice(generator.indexOf('cat >"$SCOOP" <<JSON'), generator.indexOf('\nJSON\n'));
    expect(scoopTemplate.length).toBeGreaterThan(0);
    for (const content of [
      scoopTemplate,
      read('distribution/scoop/companion-hub.json'),
      read('distribution/publish/scoop-bucket/companion-hub.json'),
    ]) {
      expect(content).not.toMatch(/tunnel/i);
      expect(content).not.toContain('uninstall-cleanup');
    }
  });

  const pwsh = findExecutable('pwsh');

  describe.skipIf(!pwsh)('PowerShell helper (needs pwsh)', () => {
    function runPs(tunnelDir: string) {
      const work = tempDir('ci-hub-uninstall-ps-');
      const script = path.join(work, 'run.ps1');
      fs.writeFileSync(
        script,
        [
          '$ErrorActionPreference = "Continue"',
          'function Write-CleanupLog { param([string]$Level, [string]$Message) }',
          extractBlock(ps, PS_SCRIPT),
          'Remove-HubTunnelFiles $args[0]',
          'Write-Output finished',
        ].join('\n'),
      );
      const result = spawnSync(pwsh as string, ['-NoProfile', '-NonInteractive', '-File', script, tunnelDir], { encoding: 'utf-8' });
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('finished');
    }

    it('removes a cloudflared token, the markers, empty certs and then the folder', () => {
      const tunnel = writeTunnelDir(tempDir('ci-hub-uninstall-ps-home-'));
      runPs(tunnel);
      expect(fs.existsSync(tunnel)).toBe(false);
    });

    it('recognizes a token whose base64 padding was stripped', () => {
      const tunnel = writeTunnelDir(tempDir('ci-hub-uninstall-ps-home-'), { token: `${cloudflaredToken({ padded: false })}\r\n` });
      runPs(tunnel);
      expect(fs.existsSync(tunnel)).toBe(false);
    });

    it('keeps a token that is not a cloudflared token, unrelated files and non-Hub markers', () => {
      const tunnel = writeTunnelDir(tempDir('ci-hub-uninstall-ps-home-'), {
        token: Buffer.from('{"id":"x"}').toString('base64'),
        registration: '{"id":1}',
        extraFiles: ['notes.txt'],
      });
      runPs(tunnel);
      expect(listDir(tunnel)).toEqual(['notes.txt', 'registration.json', 'token']);
    });

    it('keeps a certs folder that has files in it', () => {
      const tunnel = writeTunnelDir(tempDir('ci-hub-uninstall-ps-home-'), { certsFiles: ['custom-ca.pem'] });
      runPs(tunnel);
      expect(listDir(tunnel)).toEqual(['certs']);
    });

    it.skipIf(process.platform === 'win32')('does not follow a symlinked tunnel folder', () => {
      const target = writeTunnelDir(tempDir('ci-hub-uninstall-ps-target-'));
      const link = path.join(tempDir('ci-hub-uninstall-ps-home-'), 'tunnel-link');
      fs.symlinkSync(target, link);
      runPs(link);
      expect(listDir(target)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
    });
  });
});

describe('Homebrew cask zap removes the tunnel files', () => {
  const zapBlock = (content: string, file: string) => {
    const start = content.indexOf('  zap trash: [');
    expect(start, `zap stanza not found in ${file}`).toBeGreaterThanOrEqual(0);
    const end = content.indexOf('\nend', start);
    return content.slice(start, end);
  };

  const generator = read('distribution/scripts/update-package-manifests.sh');
  const generated = zapBlock(generator, 'update-package-manifests.sh');

  it('lists the data folder, the Hub files in the tunnel folder, and removes the folder only when empty', () => {
    for (const entry of [
      '"~/Library/Application Support/companion-hub"',
      '"~/Library/Application Support/tunnel/token"',
      '"~/Library/Application Support/tunnel/registration.json"',
      '"~/Library/Application Support/tunnel/leftover.json"',
      '"~/Library/Application Support/tunnel/.user-cleared-token"',
    ]) {
      expect(generated).toContain(entry);
    }
    expect(generated).toContain('rmdir: "~/Library/Application Support/tunnel"');
    // The whole folder must never be trashed: it has a generic name.
    expect(generated).not.toContain('"~/Library/Application Support/tunnel",');
  });

  it.each([
    'distribution/homebrew/companion-hub.rb',
    'distribution/publish/homebrew-tap/Casks/companion-hub.rb',
  ])('%s matches the generated zap stanza', (file) => {
    expect(zapBlock(read(file), file)).toBe(generated);
  });
});
