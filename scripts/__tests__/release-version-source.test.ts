/**
 * Guards on where the Hub's version comes from, and on the build identity stamped into the image.
 *
 * Measured 2026-09-21: `package.json` on `origin/dev` read `0.2.61` while published releases were
 * at `0.2.73`, and all 17 fleet appliances ran one untagged GHCR index. Nothing in the pipeline
 * noticed, because the wiring lives in YAML, a Dockerfile and a JSON field that no test read.
 *
 * Textual assertions, matching release-workflows.test.ts: no YAML parser, and they fail loudly when
 * the release path is rewired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf-8');

const rootPackageJson = JSON.parse(read('package.json')) as { version?: string };
const desktopPackageJson = JSON.parse(read('packages/desktop/package.json')) as { version?: string };
const dockerfile = read('Dockerfile');
const buildContainer = read('.github/workflows/build-container.yml');
const nightlyRelease = read('.github/workflows/nightly-release.yml');
const desktopRelease = read('.github/workflows/desktop-release.yml');

/** The placeholder that says "this field is not the release version". */
const DEV_PLACEHOLDER = '0.0.0-dev';

/** Every build-identity variable the runtime image must carry. */
const BUILD_STAMP_VARS = [
  'CI_HUB_BUILD_VERSION',
  'CI_HUB_BUILD_CHANNEL',
  'CI_HUB_BUILD_SHA',
  'CI_HUB_BUILD_REF',
  'CI_HUB_BUILD_TIME',
  'CI_HUB_BUILD_IMAGE_REF',
] as const;

describe('package.json is not the release version', () => {
  it.each([
    ['package.json', rootPackageJson.version],
    ['packages/desktop/package.json', desktopPackageJson.version],
  ])('%s carries the dev placeholder, not a release number', (_file, version) => {
    // No workflow reads this field. The release tag is threaded through
    // scripts/release/resolve-hub-image-tags.cjs and CI_HUB_BUILD_VERSION instead, so a real-looking
    // number here is a claim nothing backs — and it is copied into the shipped image by the
    // Dockerfile, where it was the only version on disk.
    expect(version).toBe(DEV_PLACEHOLDER);
  });

  it('the release tag still reaches the CLI binary, which is what `cihub version` reports', () => {
    // The placeholder above is only honest if the shipped binary gets the real thing from the tag.
    expect(desktopRelease).toContain('CI_HUB_BUILD_VERSION=${{ inputs.tag }}');
    expect(read('scripts/build-standalone-cli.cjs')).toContain('process.env.CI_HUB_BUILD_VERSION');
  });

  it('the release tag still reaches the desktop bundle version', () => {
    // tauri.conf.json and Cargo.toml keep a real-looking number because Windows MSI parsing rejects
    // a pre-release suffix; that is only safe while CI overwrites both from the tag.
    expect(desktopRelease).toContain('Bump Tauri version to match release tag');
    expect(desktopRelease).toContain('src-tauri/tauri.conf.json');
    expect(desktopRelease).toContain('src-tauri/Cargo.toml');
  });
});

describe('Dockerfile stamps build identity into the runtime image', () => {
  const runnerStage = dockerfile.slice(dockerfile.indexOf('FROM --platform=${TARGETPLATFORM} runner_base AS runner'));

  it('locates the runner stage before asserting on it', () => {
    // indexOf returning -1 would slice from the end and make every assertion below vacuous.
    expect(runnerStage.length).toBeGreaterThan(0);
    expect(runnerStage).toContain('runner_base AS runner');
  });

  it.each(BUILD_STAMP_VARS)('declares %s as both ARG and ENV in the runner stage', (name) => {
    // ARG alone does not survive into the image, and the pre-existing `ARG CI_HUB_VERSION` is
    // declared in the BUILDER stage only — which is exactly why the runtime image carried no
    // version at all.
    expect(runnerStage).toMatch(new RegExp(`^ARG ${name}=`, 'm'));
    expect(runnerStage).toMatch(new RegExp(`^ENV ${name}=\\$\\{${name}\\}$`, 'm'));
  });

  it('never stamps identity under CI_HUB_VERSION, which compose overrides', () => {
    // compose `environment:` beats image ENV, so a stamp under that name is shadowed by the
    // install's env file — the value that was wrong on 10 of 16 fleet Hubs.
    expect(runnerStage).not.toMatch(/^ENV CI_HUB_VERSION=/m);
  });
});

describe('build-container.yml passes the build identity it publishes', () => {
  const buildStep = buildContainer.slice(buildContainer.indexOf('- name: Build and push Docker image'));
  const buildArgs = buildStep.slice(buildStep.indexOf('build-args:'), buildStep.indexOf('secrets:'));

  it.each(BUILD_STAMP_VARS)('passes %s as a build-arg', (name) => {
    expect(buildArgs).toMatch(new RegExp(`^\\s+${name}=`, 'm'));
  });

  it('passes CI_HUB_VERSION so the frontend bundle is built with one', () => {
    // vite.config.ts bakes it into `import.meta.env.CI_HUB_VERSION`. This workflow passed nothing,
    // so every shipped bundle had an empty version and hub-hello.ts could not spot a stale tab.
    expect(buildArgs).toContain('CI_HUB_VERSION=${{ steps.tags.outputs.version || steps.tags.outputs.channel_tag }}');
  });

  it('stamps the version the image was published as, not the channel tag, where a version exists', () => {
    expect(buildArgs).toContain('CI_HUB_BUILD_VERSION=${{ steps.tags.outputs.version || steps.tags.outputs.channel_tag }}');
    expect(buildArgs).toContain('CI_HUB_BUILD_CHANNEL=${{ steps.tags.outputs.channel_tag }}');
  });

  it('stamps the reference the desktop pins, so the image names the thing it was published as', () => {
    expect(buildArgs).toContain('CI_HUB_BUILD_IMAGE_REF=${{ steps.tags.outputs.desktop_ref }}');
  });

  it('carries no comment lines inside the build-args block scalar', () => {
    // Every line there is parsed as KEY=VALUE; a `#` line becomes a bogus build arg.
    const lines = buildArgs
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([]);
  });

  it('stamps the commit as an OCI label as well as an env var', () => {
    // hub-deployment.ts identifies a channel build by the revision label, and `cihub pool update`
    // compares images with it. The env var covers the process; the label covers `docker inspect`.
    expect(buildContainer).toContain('org.opencontainers.image.revision=${{ github.sha }}');
  });
});

describe('nightly-release.yml stamps the same identity', () => {
  it.each(BUILD_STAMP_VARS)('passes %s as a build-arg', (name) => {
    expect(nightlyRelease).toMatch(new RegExp(`^\\s+${name}=`, 'm'));
  });

  it('labels the nightly image, which runs no metadata-action of its own', () => {
    // `nightly` is the one channel where two images a day share a tag, so the commit and build time
    // are the only things that tell them apart.
    expect(nightlyRelease).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(nightlyRelease).toContain('org.opencontainers.image.created=${{ steps.stamp.outputs.built_at }}');
  });

  it('carries no comment lines inside its build-args block scalar', () => {
    const buildArgs = nightlyRelease.slice(nightlyRelease.indexOf('build-args:'), nightlyRelease.indexOf('secrets:'));
    const lines = buildArgs
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([]);
  });
});

describe('the Hub build endpoint does not disturb the Ollama-compatibility routes', () => {
  const poolController = read('packages/backend/src/modules/hub-pool/hub-pool.controller.ts');
  const compatController = read('packages/backend/src/modules/hub-pool/hub-pool-ollama-compat.controller.ts');
  const buildController = read('packages/backend/src/core/build-info/hub-build-info.controller.ts');

  it('leaves both Ollama version proxies returning Ollama version', () => {
    // `/api/version` and `/api/inference/pool/api/version` are a pre-existing external convention:
    // an app handed OLLAMA_HOST=<hub> probes them, and CI-Hermes' native_root() calls one. Both must
    // keep proxying to the engine rather than reporting a Hub build.
    expect(compatController).toContain("@Get('version')");
    expect(compatController).toContain("proxyLocalOnlyRequest('/api/version', 'GET'");
    expect(poolController).toContain("@Get('api/version')");
    expect(poolController).toContain("proxyLocalOnlyRequest('/api/version', 'GET'");
  });

  it('serves the Hub build on its own path instead', () => {
    expect(buildController).toContain("@Controller('hub')");
    expect(buildController).toContain("@Get('build')");
  });
});
