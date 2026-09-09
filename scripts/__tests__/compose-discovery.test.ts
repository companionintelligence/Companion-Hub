/**
 * Reading the running stack instead of assuming it.
 *
 * Each case here is a failure that actually happened while landing one backend fix on seven fleet
 * nodes. The command's assumptions were reasonable and wrong, and every wrong one cost an attempt.
 */

import { describe, expect, it } from 'vitest';
import { composeArgsFromIdentity, discoverComposeIdentity, parseLabelValue, splitLabelPaths, HUB_CONTAINER_NAMES } from '../lib/compose-discovery';

const exec = (byContainer: Record<string, string>) => (_cmd: string, args: string[]) => {
  const name = args[1] ?? '';
  const out = byContainer[name];
  return out === undefined ? { ok: false, stdout: '' } : { ok: true, stdout: out };
};

describe('parseLabelValue', () => {
  it('treats compose\'s "<no value>" as absent, not as a value', () => {
    // docker prints this literal for a label that was never set. Passing it to `-p` would create a
    // project actually named "<no value>".
    expect(parseLabelValue('<no value>')).toBeNull();
    expect(parseLabelValue('   ')).toBeNull();
    expect(parseLabelValue(' ci-hub ')).toBe('ci-hub');
  });
});

describe('splitLabelPaths', () => {
  it('splits the comma-separated list compose writes, preserving order', () => {
    // Order is load-bearing: a later -f overrides an earlier one, and the image often comes from
    // the last overlay.
    expect(splitLabelPaths('/a/docker-compose.prod.yml,/a/docker-compose.dev-image.yml')).toEqual([
      '/a/docker-compose.prod.yml',
      '/a/docker-compose.dev-image.yml',
    ]);
  });

  it('is empty for an absent label rather than [""]', () => {
    expect(splitLabelPaths(null)).toEqual([]);
    expect(splitLabelPaths('')).toEqual([]);
  });
});

describe('discoverComposeIdentity', () => {
  it('finds the stack under either shipped container name', () => {
    // One fleet node calls it ci-os-hub and six call it ci-hub. A tool that knows only one name
    // reports "no container" on the other and does nothing.
    const labels = 'ci-hub\n/home/ci/devel/CI-Hub\n/a/prod.yml\n/a/.env.prod';
    expect(discoverComposeIdentity(HUB_CONTAINER_NAMES, exec({ 'ci-hub': labels }))?.container).toBe('ci-hub');
    expect(discoverComposeIdentity(HUB_CONTAINER_NAMES, exec({ 'ci-os-hub': labels }))?.container).toBe('ci-os-hub');
  });

  it('returns null when no Hub container is running', () => {
    expect(discoverComposeIdentity(HUB_CONTAINER_NAMES, exec({}))).toBeNull();
  });

  it('reads the project name that would otherwise be inferred wrongly', () => {
    // The node whose data dir was renamed: stack is `ci-hub`, directory says `companion-hub`.
    // Compose infers from the directory and tries to CREATE a second container.
    const id = discoverComposeIdentity(
      HUB_CONTAINER_NAMES,
      exec({ 'ci-os-hub': 'ci-hub\n/home/ci/.local/share/companion-hub\n/a/prod.yml\n/a/.env.prod' }),
    );
    expect(id?.project).toBe('ci-hub');
    expect(id?.workingDir).toBe('/home/ci/.local/share/companion-hub');
  });

  it('collects every compose file and env file', () => {
    const id = discoverComposeIdentity(HUB_CONTAINER_NAMES, exec({ 'ci-hub': 'ci-hub\n/w\n/w/prod.yml,/w/dev-image.yml\n/w/.env.prod' }));
    expect(id?.configFiles).toEqual(['/w/prod.yml', '/w/dev-image.yml']);
    expect(id?.envFiles).toEqual(['/w/.env.prod']);
  });
});

describe('composeArgsFromIdentity', () => {
  const fallback = { project: 'ci-hub', envFiles: ['.env.prod'], configFiles: ['docker-compose.prod.yml'] };

  it('builds args from the discovered stack', () => {
    const args = composeArgsFromIdentity(
      { container: 'ci-hub', project: 'ci-hub', workingDir: '/w', configFiles: ['/w/a.yml', '/w/b.yml'], envFiles: ['/w/.env.prod'] },
      fallback,
    );
    expect(args).toEqual(['compose', '--project-name', 'ci-hub', '--env-file', '/w/.env.prod', '-f', '/w/a.yml', '-f', '/w/b.yml']);
  });

  it('falls back field by field, not all-or-nothing', () => {
    // A hand-created stack may record a project and no env file. The half we learned is still worth
    // using — discarding it would reintroduce the wrong-project bug for no reason.
    const args = composeArgsFromIdentity(
      { container: 'ci-hub', project: 'other-project', workingDir: null, configFiles: [], envFiles: [] },
      fallback,
    );
    expect(args).toContain('other-project');
    expect(args).toContain('.env.prod');
    expect(args).toContain('docker-compose.prod.yml');
  });

  it("uses the caller's assumptions when nothing is running", () => {
    expect(composeArgsFromIdentity(null, fallback)).toEqual([
      'compose',
      '--project-name',
      'ci-hub',
      '--env-file',
      '.env.prod',
      '-f',
      'docker-compose.prod.yml',
    ]);
  });

  it('always passes --env-file, which is what broke interpolation', () => {
    // Omitting it produced: "required variable ROOT_FOLDER_HOST is missing a value".
    expect(composeArgsFromIdentity(null, fallback).filter((a) => a === '--env-file')).toHaveLength(1);
  });
});
