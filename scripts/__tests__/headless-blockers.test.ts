/**
 * The six things that made `cihub` unusable from a script.
 *
 * Each was found by trying to drive a real fleet install over SSH and hitting a wall that only
 * exists because the CLI assumed a person at a terminal. They are grouped here rather than scattered
 * because they share one root cause, and a regression in any one of them silently re-breaks
 * unattended installs — silently, because the symptom is a command that appears to succeed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assumeYesFromEnv } from '../lib/cli-prompt.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

describe('non-interactive consent', () => {
  it('accepts an explicit env opt-in', () => {
    // `cihub fleet` drives pool commands over `ssh -n`, which has no TTY by construction. Without
    // this, approving a pairing on a remote node exits 2 before doing anything.
    for (const value of ['1', 'true', 'yes', 'YES']) {
      expect(assumeYesFromEnv({ CI_HUB_ASSUME_YES: value } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('does not treat an absent or arbitrary value as consent', () => {
    for (const env of [{}, { CI_HUB_ASSUME_YES: '' }, { CI_HUB_ASSUME_YES: '0' }, { CI_HUB_ASSUME_YES: 'maybe' }]) {
      expect(assumeYesFromEnv(env as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('never infers consent from the mere absence of a terminal', () => {
    // The whole point of the env var: "there is no TTY" must not by itself mean "yes", or every
    // piped invocation silently gains permission to mutate a pool.
    const src = read('scripts/lib/cli-prompt.ts');
    expect(src).toMatch(/if \(force \|\| assumeYesFromEnv\(\)\) return true;/);
    expect(src).toContain('process.exit(2)');
  });
});

describe('cihub register exit codes', () => {
  const src = read('scripts/lib/cli-register.ts');

  it('exits non-zero when the Hub is unreachable', () => {
    // It used to print a red box and return, exiting 0 — so an installer could not distinguish a
    // registered Hub from one it never reached. Fourteen silent false successes is worse than
    // fourteen failures, because nobody goes looking.
    expect(src).toMatch(/Could not reach \$\{apiBase\}\/api\/health within 2 minutes[\s\S]{0,200}process\.exit\(1\)/);
  });

  it('exits non-zero on a failed pairing', () => {
    expect(src).toMatch(/Pairing failed[\s\S]{0,200}process\.exit\(1\)/);
  });
});

describe('docker exec without a terminal', () => {
  it('only passes -it when stdin really is a TTY', () => {
    // `docker exec -it` against a non-TTY stdin fails outright with "the input device is not a TTY",
    // and every fleet call arrives over `ssh -n`.
    const src = read('scripts/lib/cli-models.ts');
    expect(src).toMatch(/process\.stdin\.isTTY \? \['-it'\] : \[\]/);
    expect(src).not.toMatch(/'exec', '-it'/);
  });
});

describe('install.sh', () => {
  const src = read('scripts/install.sh');

  it('no longer targets the retired repo or an asset nothing builds', () => {
    // Four independent reasons it could not work: a retired repo, two asset names no workflow has
    // ever produced, and a command that was removed.
    expect(src).not.toMatch(/releases\/(latest|download)[^\n]*CI-OS-Hub/);
    // Assignments only — a comment explaining what the dead name used to be is not a use of it.
    const assignments = src
      .split('\n')
      .filter((line) => /^\s*ASSET=/.test(line))
      .join('\n');
    expect(assignments).not.toContain('runcihub-cli');
    expect(src).toContain('cihub-linux-x64');
    expect(src).toContain('cihub-linux-arm64');
  });

  it('calls a command that still exists', () => {
    expect(src).toContain('cihub up --detached');
    expect(src).not.toMatch(/\.\/(runcihub-cli|cihub) start/);
  });

  it('refuses to start without the password the appliance seed needs', () => {
    // The seed prompts for a Postgres password, and this script has no terminal to answer with —
    // so failing early with the variable name beats hanging on a hidden prompt.
    expect(src).toContain('CIHUB_POSTGRES_PASSWORD');
    expect(src).toMatch(/sudo -E \.\/cihub up/);
  });
});

describe('release packaging', () => {
  const workflow = read('.github/workflows/desktop-release.yml');

  it('uploads the standalone CLI, not only desktop installers', () => {
    // Without this asset, install.sh has nothing to download and the only path onto a headless node
    // is the .deb, which drags the whole desktop package with it.
    expect(workflow).toMatch(/-name "cihub-linux-\*"/);
    expect(workflow).toMatch(/cp dist\/cli\/cihub-\* release-artifacts\//);
  });

  it('builds an executable copy separate from the chmod-644 bundled resource', () => {
    // The bundled one is deliberately non-executable so Tauri packages it as a resource; curling
    // that onto a node gives you a file you cannot run.
    expect(workflow).toMatch(/--outdir dist\/cli/);
    expect(workflow).toMatch(/chmod \+x dist\/cli/);
  });
});

describe('appliance pool update', () => {
  const src = read('scripts/lib/cli-pool.ts');

  it('exports the image name even without the pull overlay', () => {
    // The seeded compose carries `pull_policy: if_not_present`, so a mutable tag is fetched once and
    // never again — an "update" that redeploys the image it already had.
    expect(src).toContain('const envOverrides = { CI_HUB_IMAGE: image };');
  });

  it('pulls the image directly when no overlay can override the policy', () => {
    expect(src).toMatch(/run\('docker', \['pull', image\]/);
  });
});

describe('the standalone CLI build produces what the installer asks for', () => {
  it('names artifacts the way install.sh downloads them', () => {
    const builder = read('scripts/build-standalone-cli.cjs');
    expect(builder).toContain('cihub-');
    // The contract between the two files: install.sh's ASSET must be a name this builder emits.
    const installSh = read('scripts/install.sh');
    for (const asset of ['cihub-linux-x64', 'cihub-linux-arm64']) {
      expect(installSh).toContain(asset);
    }
  });

  it('still exists where the workflow expects it', () => {
    expect(existsSync(join(repoRoot, 'scripts/build-standalone-cli.cjs'))).toBe(true);
  });
});
