/**
 * `SKIP_DESKTOP_BUILD=1` leaves the desktop app out of a root `pnpm build`: the Dockerfile sets it, and
 * so can a contributor who wants the rest of the workspace without installers. The desktop build script
 * used to read it only when cargo or cargo-tauri was missing, so a machine with both ran the full
 * `cargo tauri build` anyway (#1729).
 *
 * The script runs for real, in place, with a PATH that holds only fakes: `cargo` and `cargo-tauri` for
 * an installed toolchain, and `node` and `sh` for the steps the build runs through a shell. Each fake
 * records its command line and succeeds, so a build that goes ahead runs to the end against them,
 * changes nothing real, and the record names every step it took.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const desktopDir = path.resolve(import.meta.dirname, '../../packages/desktop');
const buildScript = path.join(desktopDir, 'scripts/build-desktop.cjs');

// The fakes are shell scripts.
describe.skipIf(process.platform === 'win32')('the desktop build script', () => {
  let root: string;
  let bin: string;
  let record: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cihub-build-desktop-'));
    bin = path.join(root, 'bin');
    record = path.join(root, 'commands.log');
    mkdirSync(bin);
    mkdirSync(path.join(root, 'home'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Put fakes on PATH that record their command line and succeed. Like cargo, `cargo tauri …` runs `cargo-tauri tauri …` from PATH. */
  const fake = (...names: string[]) => {
    for (const name of names) {
      const file = path.join(bin, name);
      const runSubcommand = name === 'cargo' ? 'exec "cargo-$1" "$@"\n' : '';
      writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$FAKE_RECORD"\n${runSubcommand}`);
      chmodSync(file, 0o755);
    }
  };

  const recorded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []);

  /** Runs the script as `pnpm build` does, from the desktop package. HOME is empty, so the CLI PATH helper writes nowhere real. */
  const runBuild = (env: Record<string, string>) =>
    spawnSync(process.execPath, [buildScript], {
      cwd: desktopDir,
      encoding: 'utf8',
      env: { PATH: bin, HOME: path.join(root, 'home'), FAKE_RECORD: record, ...env },
    });

  it.each([
    { toolchain: 'cargo and cargo-tauri are installed', fakes: ['cargo', 'cargo-tauri'] },
    { toolchain: 'only cargo is installed', fakes: ['cargo'] },
    { toolchain: 'no Rust toolchain is installed', fakes: [] },
  ])('SKIP_DESKTOP_BUILD=1 skips with a warning and runs nothing when $toolchain', ({ fakes }) => {
    fake('node', 'sh', ...fakes);

    const run = runBuild({ SKIP_DESKTOP_BUILD: '1' });

    expect(recorded(), 'the build went ahead').toEqual([]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('SKIPPING the desktop build');
  });

  it('builds against the same fakes when SKIP_DESKTOP_BUILD is not set', () => {
    // The control for the cases above: the record does catch a build, so their empty record means none ran.
    fake('node', 'sh', 'cargo', 'cargo-tauri');

    const run = runBuild({});

    expect(run.status, run.stderr).toBe(0);
    expect(recorded()).toContainEqual(expect.stringMatching(/^cargo tauri build\b/));
    expect(run.stderr).not.toContain('SKIPPING');
  });
});
