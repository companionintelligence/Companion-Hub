/**
 * Structural guards on the release workflows.
 *
 * Hub 0.2.44 shipped bundles pinning an image no workflow published, and nothing caught it
 * because the wiring lives in YAML that no test looked at (#920). These assertions are
 * deliberately textual — matching the existing docker-compose-sync test — so they need no
 * YAML parser and fail loudly if the release path is rewired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');

function readWorkflow(name: string) {
  return fs.readFileSync(path.join(workflowsDir, name), 'utf-8');
}

const buildContainer = readWorkflow('build-container.yml');
const desktopRelease = readWorkflow('desktop-release.yml');

describe('desktop-release.yml', () => {
  it('threads the release tag into the container build', () => {
    // Without this the container build never learns the version the bundles compile in,
    // so a production release publishes no versioned image at all.
    expect(desktopRelease).toContain('uses: ./.github/workflows/build-container.yml');
    expect(desktopRelease).toMatch(/tag:\s*\$\{\{\s*inputs\.tag\s*\}\}/);
  });

  it('builds desktop bundles only after the container job', () => {
    // build-container includes the anonymous-pull gate, so this dependency is what stops
    // six 45-minute bundle builds from running against an unpullable image.
    expect(desktopRelease).toMatch(/needs:\s*build-container/);
  });
});

describe('build-container.yml', () => {
  it('accepts a tag input on both trigger types', () => {
    const dispatchBlock = buildContainer.slice(buildContainer.indexOf('workflow_dispatch:'), buildContainer.indexOf('workflow_call:'));
    const callBlock = buildContainer.slice(buildContainer.indexOf('workflow_call:'), buildContainer.indexOf('jobs:'));
    expect(dispatchBlock).toContain('tag:');
    expect(callBlock).toContain('tag:');
  });

  it('derives its references from the shared resolver rather than inline shell', () => {
    // The resolver mirrors default_hub_image(); duplicating the rules in YAML is how the
    // published image and the pinned image drift apart.
    expect(buildContainer).toContain('scripts/release/resolve-hub-image-tags.cjs');
  });

  it('publishes the channel tag plus a conditional version tag', () => {
    expect(buildContainer).toContain('type=raw,value=${{ steps.tags.outputs.channel_tag }}');
    expect(buildContainer).toContain('type=raw,value=${{ steps.tags.outputs.version }}');
    expect(buildContainer).toContain("enable=${{ steps.tags.outputs.version != '' }}");
  });

  it('never adds a v prefix to published tags', () => {
    // hub_env.rs strips the `v` when composing its pin, so a v-prefixed tag is unpullable.
    expect(buildContainer).not.toContain('prefix=v');
  });

  it('keeps multi-arch builds', () => {
    // Apple Silicon and ARM64 Linux are shipped desktop targets.
    expect(buildContainer).toContain('platforms: linux/amd64,linux/arm64');
  });

  it('mirrors the versioned tag to Portal so update listing sees semver tags', () => {
    expect(buildContainer).toContain('${PORTAL}/ci-os-hub:${VERSION}');
  });

  it('gates the release on an anonymous pull check that depends on the build', () => {
    expect(buildContainer).toContain('verify-anonymous-pull:');
    expect(buildContainer).toMatch(/verify-anonymous-pull:[\s\S]*?needs:\s*deploy/);
  });

  it('runs the gate without registry credentials', () => {
    // Every step in the original pipeline was authenticated, which is exactly why a private
    // package went unnoticed. The gate must look like a first-time user.
    const gate = buildContainer.slice(buildContainer.indexOf('verify-anonymous-pull:'));
    expect(gate).toContain('DOCKER_CONFIG');
    expect(gate).not.toContain('docker/login-action');
    expect(gate).toContain('crane manifest');
  });

  it('asserts both shipped architectures are present', () => {
    const gate = buildContainer.slice(buildContainer.indexOf('verify-anonymous-pull:'));
    expect(gate).toContain('amd64');
    expect(gate).toContain('arm64');
  });

  it('refuses to pass when there is no reference to verify', () => {
    // The verification loop iterates over the resolved references. If desktop_ref were
    // ever empty the loop would simply not run and the job would go green having proved
    // nothing — the same silent-pass failure mode that let #920 ship.
    const gate = buildContainer.slice(buildContainer.indexOf('verify-anonymous-pull:'));
    expect(gate).toContain('if [ -z "${DESKTOP_REF}" ]; then');
  });

  it('refuses to pass when the published version and the verified reference disagree', () => {
    // Otherwise a drift between resolver and workflow could verify :latest while the
    // pinned version tag is absent.
    const gate = buildContainer.slice(buildContainer.indexOf('verify-anonymous-pull:'));
    expect(gate).toContain('if [ -n "${VERSION}" ]');
    expect(gate).toContain('${CHANNEL_REF%:*}:${VERSION}');
  });
});

describe('no workflow publishes to the private ci-os-hub package', () => {
  const workflows = fs.readdirSync(workflowsDir).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));

  it.each(workflows)('%s does not reference ghcr.io/…/ci-os-hub as an image', (file) => {
    // ci-os-hub remains valid as a compose service name and as the Portal mirror path; only
    // the GHCR image repo moved. This catches a regression to the private package.
    const content = readWorkflow(file);
    expect(content).not.toMatch(/ghcr\.io\/companionintelligence\/ci-os-hub/);
  });
});
