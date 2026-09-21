import { describe, expect, it } from 'vitest';
import { resolveHubBuildInfo, shortenGitSha, summarizeHubBuild } from '../hub-build-info';

/** A production release build, stamped by build-container.yml with a version tag published. */
const RELEASE_ENV: NodeJS.ProcessEnv = {
  CI_HUB_BUILD_VERSION: '0.2.73',
  CI_HUB_BUILD_CHANNEL: 'latest',
  CI_HUB_BUILD_SHA: 'dac546bcffe0f105539615d94c8139e4522c050a',
  CI_HUB_BUILD_REF: 'refs/heads/main',
  CI_HUB_BUILD_TIME: '2026-09-17T07:44:35.701Z',
  CI_HUB_BUILD_IMAGE_REF: 'ghcr.io/companionintelligence/ci-hub:0.2.73',
};

/** A `dev` channel build: no release version exists, and the commit is the whole identity. */
const DEV_ENV: NodeJS.ProcessEnv = {
  CI_HUB_BUILD_VERSION: 'dev',
  CI_HUB_BUILD_CHANNEL: 'dev',
  CI_HUB_BUILD_SHA: '6a5ac521dd859ae985fd01df381cf6df3fe72d3e',
  CI_HUB_BUILD_REF: 'refs/heads/dev',
  CI_HUB_BUILD_TIME: '2026-09-16T12:39:10.154Z',
  CI_HUB_BUILD_IMAGE_REF: 'ghcr.io/companionintelligence/ci-hub:dev',
};

describe('resolveHubBuildInfo', () => {
  it('reports a release build from the image stamp', () => {
    const info = resolveHubBuildInfo(RELEASE_ENV);

    expect(info.version).toBe('0.2.73');
    expect(info.channel).toBe('latest');
    expect(info.gitSha).toBe('dac546bcffe0f105539615d94c8139e4522c050a');
    expect(info.gitShaShort).toBe('dac546bcf');
    expect(info.builtAt).toBe('2026-09-17T07:44:35.701Z');
    expect(info.imageRef).toBe('ghcr.io/companionintelligence/ci-hub:0.2.73');
    expect(info.source).toBe('image');
    expect(info.summary).toBe('0.2.73 (dac546bcf)');
  });

  it('identifies a channel build by its commit, since it has no release version', () => {
    // The measured failure: 17 appliances all ran one untagged index and nothing on the node could
    // name it. `dev` alone does not distinguish two such images; the commit does.
    const info = resolveHubBuildInfo(DEV_ENV);

    expect(info.version).toBe('dev');
    expect(info.channel).toBe('dev');
    expect(info.summary).toBe('dev (6a5ac521d)');
  });

  it('never reports a version the build did not stamp', () => {
    // CI_HUB_VERSION is the install's env file, wrong on 10 of 16 fleet Hubs. Reporting it AS the
    // running version is the bug; reporting it as `declaredVersion` is the diagnosis.
    const info = resolveHubBuildInfo({ CI_HUB_VERSION: '4.5.0' });

    expect(info.version).toBeNull();
    expect(info.declaredVersion).toBe('4.5.0');
    expect(info.source).toBe('unstamped');
    expect(info.summary).toBe('unidentified build (this image carries no build stamp)');
  });

  it('surfaces a stale env-file version alongside the real build rather than instead of it', () => {
    const info = resolveHubBuildInfo({ ...RELEASE_ENV, CI_HUB_VERSION: 'v0.2.22' });

    expect(info.version).toBe('0.2.73');
    expect(info.declaredVersion).toBe('v0.2.22');
  });

  it('treats blank stamps as absent, so an unset build-arg is not an empty version', () => {
    // Dockerfile ARGs default to "", and compose renders `${VAR:-}` as an empty string. Both must
    // read as "not stamped" rather than as a version that happens to be the empty string.
    const info = resolveHubBuildInfo({
      CI_HUB_BUILD_VERSION: '',
      CI_HUB_BUILD_CHANNEL: '   ',
      CI_HUB_BUILD_SHA: '',
    });

    expect(info.version).toBeNull();
    expect(info.channel).toBeNull();
    expect(info.source).toBe('unstamped');
  });

  it('still reports `image` when only the commit was stamped', () => {
    // A commit IS an identity. Calling this build unstamped would discard the one fact it has.
    const info = resolveHubBuildInfo({ CI_HUB_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01' });

    expect(info.source).toBe('image');
    expect(info.version).toBeNull();
    expect(info.summary).toBe('unversioned build (abcdef012)');
  });

  it('strips a v prefix so a stamped tag matches the pullable one', () => {
    // GHCR tags are unprefixed and hub_env.rs strips the `v` when composing its pin, so `v0.2.73`
    // and `0.2.73` name the same build and must not read as two different versions.
    expect(resolveHubBuildInfo({ CI_HUB_BUILD_VERSION: 'v0.2.73' }).version).toBe('0.2.73');
  });

  it('leaves a channel tag that merely starts with v alone', () => {
    // `stripVersionPrefix` requires a digit after the `v`; a tag like `vnext` is a name, not a
    // prefixed version, and truncating it would invent a build called `next`.
    expect(resolveHubBuildInfo({ CI_HUB_BUILD_VERSION: 'vnext' }).version).toBe('vnext');
  });

  it('leaves the digest null, because a build cannot stamp it', () => {
    // The registry computes the digest from the pushed manifest, so it does not exist while the
    // layers are being built. It is merged in at runtime by the service, not resolved here.
    expect(resolveHubBuildInfo(RELEASE_ENV).imageDigest).toBeNull();
  });
});

describe('shortenGitSha', () => {
  it('abbreviates a full SHA to the 9 chars describeRunningBuild() already uses', () => {
    expect(shortenGitSha('dac546bcffe0f105539615d94c8139e4522c050a')).toBe('dac546bcf');
  });

  it('passes through anything that is not a full SHA rather than truncating it', () => {
    // Truncating a non-SHA would print something that looks like a commit and is not.
    expect(shortenGitSha('abc123')).toBe('abc123');
    expect(shortenGitSha('refs/heads/dev')).toBe('refs/heads/dev');
    expect(shortenGitSha(null)).toBeNull();
  });
});

describe('summarizeHubBuild', () => {
  it('names the digest-bearing build the same way regardless of digest', () => {
    const base = resolveHubBuildInfo(RELEASE_ENV);
    const { summary: _ignored, ...rest } = base;

    expect(summarizeHubBuild({ ...rest, imageDigest: 'sha256:'.padEnd(71, 'a') })).toBe('0.2.73 (dac546bcf)');
  });
});
