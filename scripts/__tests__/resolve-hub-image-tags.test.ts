/**
 * The resolver decides what the release pipeline publishes and what the pull gate
 * verifies, mirroring `default_hub_image()` in the desktop's hub_env.rs. Getting it wrong
 * ships bundles pinning an image nobody published — the Hub 0.2.44 outage (#920).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain CommonJS helper, no type declarations
import { IMAGE_REPO, normalizeVersion, resolveHubImageTags } from '../release/resolve-hub-image-tags.cjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/release/resolve-hub-image-tags.cjs');

/** Run the CLI the way the workflow does, returning parsed `key=value` outputs. */
function runCli(args: string[]) {
  const stdout = execFileSync('node', [scriptPath, ...args], { cwd: repoRoot, encoding: 'utf-8' });
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('::'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

describe('resolve-hub-image-tags', () => {
  it('publishes to the public ci-hub package, never the private ci-os-hub one', () => {
    expect(IMAGE_REPO).toBe('ghcr.io/companionintelligence/ci-hub');
  });

  // The repo string is duplicated across four independently-maintained files, and each of
  // the other suites only compares its own copy to its own literal — so a rename that
  // updated three of four would leave every suite green while CI published to one repo and
  // the shipped desktop pinned another. That is the exact shape of #920.
  describe('the repo constant agrees across every copy', () => {
    const sources: Array<[string, RegExp]> = [
      ['packages/desktop/src-tauri/src/hub_env.rs', /HUB_STACK_IMAGE_REPO: &str = "([^"]+)"/],
      ['packages/backend/src/common/constants.ts', /HUB_STACK_IMAGE_REPO = '([^']+)'/],
      ['scripts/sync-docker-compose-prod.cjs', /CI_HUB_IMAGE:-([^:]+):latest/],
    ];

    it.each(sources)('%s names the same repo as the resolver', (file, pattern) => {
      const contents = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      const found = contents.match(pattern)?.[1];
      expect(found, `could not find the image repo in ${file}`).toBeDefined();
      expect(found).toBe(IMAGE_REPO);
    });
  });

  describe('normalizeVersion', () => {
    it('strips a leading v so the published tag matches what the desktop pins', () => {
      expect(normalizeVersion('v0.2.45')).toBe('0.2.45');
    });

    it('is idempotent for an already-unprefixed tag', () => {
      expect(normalizeVersion('0.2.45')).toBe('0.2.45');
    });

    it('accepts a pre-release tag', () => {
      expect(normalizeVersion('v0.2.45-rc.1')).toBe('0.2.45-rc.1');
    });

    it('treats an absent tag as "no version"', () => {
      expect(normalizeVersion('')).toBe('');
      expect(normalizeVersion(undefined)).toBe('');
    });

    // Silently skipping a malformed tag is how a release ships with no versioned image.
    it.each(['0.2', 'latest', 'v1.x', 'nightly', 'v'])('rejects the unusable tag %s', (tag) => {
      expect(() => normalizeVersion(tag)).toThrow(/not a publishable version/);
    });

    it('rejects build metadata, which is not a legal Docker tag character', () => {
      // `+` is outside [A-Za-z0-9._-], so publishing it would fail with "invalid reference
      // format" at push time and again at every docker compose pull.
      expect(() => normalizeVersion('v0.2.45+ci.7')).toThrow(/not a publishable version/);
    });
  });

  describe('production', () => {
    it('pins the exact version when a release tag is supplied', () => {
      const resolved = resolveHubImageTags({ environment: 'production', tag: 'v0.2.45' });
      expect(resolved.version).toBe('0.2.45');
      expect(resolved.desktopRef).toBe(`${IMAGE_REPO}:0.2.45`);
      expect(resolved.channelTag).toBe('latest');
    });

    it('falls back to the channel tag when no release tag is supplied', () => {
      const resolved = resolveHubImageTags({ environment: 'production' });
      expect(resolved.version).toBe('');
      expect(resolved.desktopRef).toBe(`${IMAGE_REPO}:latest`);
    });

    it('never emits a v-prefixed version tag', () => {
      // hub_env.rs strips the `v` when composing its pin and the backend interpolates the
      // raw listed tag, so a `v` here 404s on both paths — the retired release.yml's bug.
      const resolved = resolveHubImageTags({ environment: 'production', tag: 'v0.2.45' });
      expect(resolved.version.startsWith('v')).toBe(false);
      expect(resolved.desktopRef).not.toContain(':v');
    });
  });

  describe('non-production', () => {
    // A dev build compiles a different CI_CLOUD_URL. Publishing a version tag from one
    // would leave a production-looking tag pointing at a dev-configured image, which a real
    // production desktop would then pin and pull.
    it.each([
      ['dev', 'dev'],
      ['staging', 'staging'],
    ])('publishes no version tag for %s even when a tag is passed', (environment, channelTag) => {
      const resolved = resolveHubImageTags({ environment, tag: 'v0.2.45' });
      expect(resolved.version).toBe('');
      expect(resolved.channelTag).toBe(channelTag);
      expect(resolved.desktopRef).toBe(`${IMAGE_REPO}:${channelTag}`);
    });

    it('still rejects a malformed tag rather than deferring the failure to release day', () => {
      expect(() => resolveHubImageTags({ environment: 'dev', tag: '0.2' })).toThrow(/not a publishable version/);
    });
  });

  it('defaults to dev for an unspecified environment', () => {
    expect(resolveHubImageTags({}).environment).toBe('dev');
  });

  it('rejects an unknown environment', () => {
    expect(() => resolveHubImageTags({ environment: 'prod' })).toThrow(/Unknown environment/);
  });

  it('rejects inherited Object.prototype keys as environments', () => {
    // A plain object literal would return a truthy entry for these, yielding
    // channel_tag=undefined and publishing a literal `:undefined` tag.
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => resolveHubImageTags({ environment: key })).toThrow(/Unknown environment/);
    }
  });

  it('maps each environment to its Portal mirror', () => {
    expect(resolveHubImageTags({ environment: 'production' }).portalRegistry).toBe('hub.ci.computer');
    expect(resolveHubImageTags({ environment: 'staging' }).portalRegistry).toBe('portal.companionintel.com');
    expect(resolveHubImageTags({ environment: 'dev' }).portalRegistry).toBe('hub.companionintelligence.com');
  });

  describe('CLI contract with the workflow', () => {
    it('emits every output the workflow consumes', () => {
      const outputs = runCli(['--environment', 'production', '--tag', 'v0.2.45']);
      expect(outputs).toMatchObject({
        environment: 'production',
        image_repo: IMAGE_REPO,
        channel_tag: 'latest',
        version: '0.2.45',
        desktop_ref: `${IMAGE_REPO}:0.2.45`,
        portal_registry: 'hub.ci.computer',
      });
    });

    it('exits non-zero on a malformed tag so the release fails loudly', () => {
      expect(() => runCli(['--environment', 'production', '--tag', '0.2'])).toThrow();
    });

    it('rejects an unknown flag rather than silently resolving to the dev default', () => {
      // A typo'd `--enviroment` that is ignored would publish no versioned image at all.
      expect(() => runCli(['--enviroment', 'production', '--tag', 'v0.2.45'])).toThrow();
    });
  });
});
