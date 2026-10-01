/**
 * The CLI and the Hub stack ship on two channels, and until now nothing compared them.
 *
 * Every case below is either a shape measured on the fleet or a state the comparison must not
 * confuse with another. The load-bearing one is `beta-max, 2026-09-21`: a CLI reporting 0.2.72 and
 * a stack running an untagged GHCR index. Doctor was green, and `cihub pool ceiling` — merged,
 * released, documented — answered `Unknown pool subcommand`.
 */
import { describe, expect, it } from 'vitest';
import {
  type CliBuild,
  classifyCliInstall,
  cliUpdateInstructions,
  compareBuilds,
  describeSkew,
  isVersionTag,
  parseImageTag,
  parseStackInspect,
  readStackBuild,
  resolveStackBuild,
  type StackBuild,
} from '../lib/cli-version-skew.js';

const REPO = 'ghcr.io/companionintelligence/ci-hub';
const noTags = { labelVersion: null as string | null, revision: null as string | null, repoTags: [] as string[] };

describe('resolveStackBuild', () => {
  it('takes the release from a version tag in the image reference', () => {
    const build = resolveStackBuild('ci-hub', { ...noTags, reference: `${REPO}:0.2.73`, revision: 'abc123def456' });
    expect(build).toMatchObject({ container: 'ci-hub', version: '0.2.73', revision: 'abc123def456' });
  });

  it('strips a leading v so 0.2.73 and v0.2.73 are one release', () => {
    expect(resolveStackBuild('ci-hub', { ...noTags, reference: `${REPO}:v0.2.73` }).version).toBe('0.2.73');
  });

  it('ignores the OCI version label when it is not version-shaped', () => {
    // Measured against GHCR 2026-09-17: docker/metadata-action stamps the FIRST tag it is given, and
    // build-container.yml listed the channel tag first, so the real 0.2.71 image says `latest`.
    const build = resolveStackBuild('ci-hub', { ...noTags, reference: `${REPO}:latest`, labelVersion: 'latest' });
    expect(build.version).toBeNull();
  });

  it('falls back to the OCI version label when it IS version-shaped', () => {
    expect(resolveStackBuild('ci-hub', { ...noTags, reference: `${REPO}:dev`, labelVersion: '0.2.73' }).version).toBe('0.2.73');
  });

  it('falls back to the highest version tag docker holds for the same image', () => {
    const build = resolveStackBuild('ci-hub', {
      ...noTags,
      reference: `${REPO}:latest`,
      repoTags: [`${REPO}:latest`, `${REPO}:0.2.70`, `${REPO}:0.2.73`],
    });
    expect(build.version).toBe('0.2.73');
  });

  it('reports no release for a digest-pinned image, which is what beta-max runs', () => {
    const build = resolveStackBuild('ci-hub', {
      ...noTags,
      reference: `${REPO}@sha256:14a090870a7500000000000000000000000000000000000000000000000000aa`,
      revision: '9ff0d7880aa',
    });
    expect(build.version).toBeNull();
    expect(build.revision).toBe('9ff0d7880aa');
  });

  it('reports no release for a local build in another repository', () => {
    expect(resolveStackBuild('ci-os-hub', { ...noTags, reference: 'ci-hub-ci-hub:latest' }).version).toBeNull();
  });
});

describe('parseImageTag', () => {
  it('does not read a registry port as a tag', () => {
    expect(parseImageTag('registry.local:5000/org/ci-hub')).toEqual({ repository: 'registry.local:5000/org/ci-hub', tag: null, digest: null });
  });

  it('splits a digest off the reference', () => {
    expect(parseImageTag(`${REPO}@sha256:deadbeef`)).toEqual({ repository: REPO, tag: null, digest: 'sha256:deadbeef' });
  });

  it('accepts only release-shaped tags as versions', () => {
    expect(isVersionTag('0.2.73')).toBe(true);
    expect(isVersionTag('v0.2.73-rc.1')).toBe(true);
    expect(isVersionTag('dev')).toBe(false);
    expect(isVersionTag('pr-auto-76b1c7bc1')).toBe(false);
    expect(isVersionTag('latest')).toBe(false);
  });
});

const cli = (version: string, revision: string | null = null): CliBuild => ({ version, revision });
const stack = (version: string | null, revision: string | null = null, reference = `${REPO}:dev`): StackBuild => ({
  container: 'ci-hub',
  reference,
  version,
  revision,
});

describe('compareBuilds', () => {
  it('matches two builds on the same release', () => {
    expect(compareBuilds(cli('0.2.73'), stack('0.2.73'))).toMatchObject({ kind: 'match', how: 'version' });
  });

  it('names both versions and which way the gap runs when the CLI is behind', () => {
    expect(compareBuilds(cli('0.2.72'), stack('0.2.73'))).toEqual({
      kind: 'skew',
      how: 'version',
      cli: '0.2.72',
      stack: '0.2.73',
      direction: 'cli-behind',
    });
  });

  it('reports a CLI ahead of its stack as its own direction', () => {
    expect(compareBuilds(cli('0.2.73'), stack('0.2.70'))).toMatchObject({ direction: 'cli-ahead' });
  });

  it('refuses to rank two pre-releases of the same x.y.z', () => {
    expect(compareBuilds(cli('0.2.73-rc.1'), stack('0.2.73-rc.2'))).toMatchObject({ kind: 'skew', direction: 'unordered' });
  });

  it('falls back to the commit when the stack names no release', () => {
    expect(compareBuilds(cli('0.2.73', 'aaaaaaaaaaaa'), stack(null, 'aaaaaaaaaaaa'))).toMatchObject({ kind: 'match', how: 'revision' });
    expect(compareBuilds(cli('0.2.73', 'aaaaaaaaaaaa'), stack(null, 'bbbbbbbbbbbb'))).toMatchObject({ kind: 'skew', how: 'revision' });
  });

  it('says so, rather than matching, when neither side can be identified', () => {
    // beta-max on 2026-09-21: `cihub version` 0.2.72, stack an untagged index, CLI with no stamp.
    const verdict = compareBuilds(cli('0.2.72'), stack(null, null, `${REPO}@sha256:14a090870a75`));
    expect(verdict.kind).toBe('incomparable');
    expect(verdict.kind === 'incomparable' && verdict.stack).toContain('sha256:14a090870a75');
  });

  it('has nothing to compare when no Hub container is running', () => {
    expect(compareBuilds(cli('0.2.73'), null)).toEqual({ kind: 'no-stack', cli: '0.2.73' });
  });

  it('holds a released CLI to its release even when both sides stamp a commit', () => {
    const release = (version: string, revision: string) => stack(version, revision, `${REPO}:${version}`);
    expect(compareBuilds(cli('0.2.72', 'aaaaaaaaaaaa'), release('0.2.73', 'bbbbbbbbbbbb'))).toEqual({
      kind: 'skew',
      how: 'version',
      cli: '0.2.72',
      stack: '0.2.73',
      direction: 'cli-behind',
    });
    expect(compareBuilds(cli('0.2.73', 'aaaaaaaaaaaa'), release('0.2.73', 'bbbbbbbbbbbb'))).toMatchObject({ kind: 'match', how: 'version' });
  });

  it('compares a CLI whose version is not release-shaped by commit, as it does an untagged stack', () => {
    expect(compareBuilds(cli('nightly', 'aaaaaaaaaaaa'), stack('0.2.72', 'aaaaaaaaaaaa', `${REPO}:0.2.72`))).toMatchObject({
      kind: 'match',
      how: 'revision',
    });
  });

  /**
   * A source checkout reports `package.json`'s placeholder, pulled or not. Ranked as a release it sat
   * below every real one, so `cihub doctor` in any checkout failed as a CLI behind its stack
   * (CI-Hub#1727). What it does have is its commit, and release images stamp theirs.
   */
  describe('from a source checkout, whose 0.0.0-dev names no release', () => {
    const release = (revision: string | null) => stack('0.2.72', revision, `${REPO}:0.2.72`);

    it("matches a release image built from the checkout's own commit", () => {
      expect(compareBuilds(cli('0.0.0-dev', 'aaaaaaaaaaaa'), release('aaaaaaaaaaaa'))).toEqual({
        kind: 'match',
        how: 'revision',
        cli: 'aaaaaaaaa',
        stack: 'aaaaaaaaa',
      });
    });

    it('calls another commit a revision skew, not a CLI behind its stack', () => {
      expect(compareBuilds(cli('0.0.0-dev', 'aaaaaaaaaaaa'), release('bbbbbbbbbbbb'))).toEqual({
        kind: 'skew',
        how: 'revision',
        cli: 'aaaaaaaaa',
        stack: 'bbbbbbbbb',
        direction: 'unordered',
      });
    });

    it('cannot compare against a release image that stamps no commit, and says which side lacks what', () => {
      expect(compareBuilds(cli('0.0.0-dev', 'aaaaaaaaaaaa'), release(null))).toEqual({
        kind: 'incomparable',
        cli: '0.0.0-dev',
        stack: '0.2.72',
        why: 'this cihub names no release, and the running image stamps no commit',
      });
    });

    it('cannot compare when the checkout commit could not be read', () => {
      // Run outside any git checkout, `git rev-parse HEAD` has nothing to give.
      expect(compareBuilds(cli('0.0.0-dev'), release('bbbbbbbbbbbb'))).toEqual({
        kind: 'incomparable',
        cli: '0.0.0-dev',
        stack: '0.2.72@bbbbbbbbb',
        why: 'this cihub names no release and carries no commit',
      });
    });

    it('reads the bare 0.0.0 fallback, and no version at all, the same way', () => {
      expect(compareBuilds(cli('0.0.0', 'aaaaaaaaaaaa'), release('aaaaaaaaaaaa'))).toMatchObject({ kind: 'match', how: 'revision' });
      expect(compareBuilds(cli('', 'aaaaaaaaaaaa'), release('bbbbbbbbbbbb'))).toMatchObject({ kind: 'skew', how: 'revision' });
    });
  });
});

describe('classifyCliInstall', () => {
  it('calls a node/tsx run a source install, not a replaceable binary', () => {
    expect(classifyCliInstall('/usr/local/bin/node').kind).toBe('source');
  });

  it('recognises the channels that own their own file', () => {
    expect(classifyCliInstall('/opt/homebrew/Cellar/companion-hub/0.2.73/bin/cihub').kind).toBe('homebrew');
    expect(classifyCliInstall('/opt/homebrew/Caskroom/companion-hub/0.2.73/cihub').kind).toBe('homebrew');
    expect(classifyCliInstall('C:\\Users\\op\\scoop\\apps\\companion-hub\\current\\cihub.exe').kind).toBe('scoop');
    expect(classifyCliInstall('/Applications/Companion Hub.app/Contents/Resources/cihub').kind).toBe('desktop');
  });

  it('calls the fleet-installed asset standalone — the one channel that can replace itself', () => {
    expect(classifyCliInstall('/usr/local/bin/cihub')).toEqual({ kind: 'standalone', path: '/usr/local/bin/cihub' });
    expect(classifyCliInstall('/home/ci/.local/bin/cihub').kind).toBe('standalone');
  });

  it('gives every channel a command an operator can copy', () => {
    expect(cliUpdateInstructions({ kind: 'homebrew', path: '/x' })[0]).toContain('brew upgrade');
    expect(cliUpdateInstructions({ kind: 'scoop', path: '/x' })[0]).toContain('scoop update');
    expect(cliUpdateInstructions({ kind: 'desktop', path: '/x' })[0]).toContain('companion-hub update');
    expect(cliUpdateInstructions({ kind: 'standalone', path: '/x' }, '0.2.73')[0]).toBe('cihub self-update --to 0.2.73');
    expect(cliUpdateInstructions({ kind: 'source', path: '/x' })[0]).toContain('rebuild');
  });
});

const standalone = { kind: 'standalone', path: '/usr/local/bin/cihub' } as const;

describe('describeSkew', () => {
  it('fails a proven release mismatch and names both versions', () => {
    const report = describeSkew(compareBuilds(cli('0.2.72'), stack('0.2.73')), standalone);
    expect(report.severity).toBe('fail');
    expect(report.headline).toContain('0.2.72');
    expect(report.headline).toContain('0.2.73');
    expect(report.lines.join('\n')).toContain('cihub self-update --to 0.2.73');
  });

  it('warns rather than fails when the two cannot be compared', () => {
    // A `:dev` node is legitimately here. Failing it would put a red line on every development
    // machine; saying nothing is how beta-max looked healthy.
    const report = describeSkew(compareBuilds(cli('0.2.72'), stack(null, null, `${REPO}:dev`)), standalone);
    expect(report.severity).toBe('warn');
    expect(report.headline).toContain('cannot be compared');
  });

  it('warns on two different commits without claiming which is newer', () => {
    const report = describeSkew(compareBuilds(cli('0.2.73', 'aaaaaaaaaa'), stack(null, 'bbbbbbbbbb')), standalone);
    expect(report.severity).toBe('warn');
    expect(report.lines.join(' ')).toContain('cannot be ordered');
  });

  it('is clean when the versions agree, and when there is no stack at all', () => {
    expect(describeSkew(compareBuilds(cli('0.2.73'), stack('0.2.73')), standalone).severity).toBe('ok');
    expect(describeSkew(compareBuilds(cli('0.2.73'), null), standalone).severity).toBe('ok');
  });

  it('warns, never fails, on a source checkout whose commit is not the release image commit', () => {
    const source = { kind: 'source', path: '/usr/bin/node' } as const;
    const release = stack('0.2.72', 'bbbbbbbbbbbb', `${REPO}:0.2.72`);
    const report = describeSkew(compareBuilds(cli('0.0.0-dev', 'aaaaaaaaaaaa'), release), source);
    expect(report.severity).toBe('warn');
    expect(report.headline).toBe('cihub commit aaaaaaaaa vs stack commit bbbbbbbbb — builds differ');
    expect(report.lines.join('\n')).not.toContain('older than the stack');
    expect(describeSkew(compareBuilds(cli('0.0.0-dev', 'bbbbbbbbbbbb'), release), source).severity).toBe('ok');
  });
});

describe('parseStackInspect', () => {
  it('reads a label Docker renders as <no value> as absent, not as a value', () => {
    const facts = parseStackInspect([`reference=${REPO}:dev`, 'labelVersion=<no value>', 'revision='].join('\n'));
    expect(facts).toEqual({ reference: `${REPO}:dev`, labelVersion: null, revision: null });
  });
});

describe('readStackBuild', () => {
  function exec(responses: Record<string, { ok: boolean; stdout: string }>) {
    const seen: string[] = [];
    const fn = (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.slice(0, 3).join(' ')}`;
      seen.push(key);
      return responses[key] ?? { ok: false, stdout: '' };
    };
    return { fn, seen };
  }

  it('reads the canonical container and resolves its release', () => {
    const { fn, seen } = exec({
      'docker inspect ci-hub --format': { ok: true, stdout: `reference=${REPO}:0.2.73\nlabelVersion=latest\nrevision=abc123\n` },
      [`docker image inspect ${REPO}:0.2.73`]: { ok: true, stdout: `${REPO}:0.2.73,${REPO}:latest` },
    });
    expect(readStackBuild(fn)).toMatchObject({ container: 'ci-hub', version: '0.2.73', revision: 'abc123' });
    expect(seen[0]).toBe('docker inspect ci-hub --format');
  });

  it('falls through to the legacy ci-os-hub container name', () => {
    // core-4 still runs the older compose topology; a substring match on "hub" would have picked up
    // an app container or the tailscale sidecar instead.
    const { fn } = exec({
      'docker inspect ci-os-hub --format': { ok: true, stdout: `reference=${REPO}:dev\nlabelVersion=\nrevision=deadbeef\n` },
    });
    expect(readStackBuild(fn)).toMatchObject({ container: 'ci-os-hub', version: null, revision: 'deadbeef' });
  });

  it('returns null when nothing is running, so the caller reports "no stack" and not a fault', () => {
    const { fn } = exec({});
    expect(readStackBuild(fn)).toBeNull();
  });

  it('survives an image whose tags cannot be read', () => {
    const { fn } = exec({
      'docker inspect ci-hub --format': { ok: true, stdout: `reference=${REPO}:latest\nlabelVersion=<no value>\nrevision=abc\n` },
    });
    expect(readStackBuild(fn)).toMatchObject({ version: null, revision: 'abc' });
  });
});
