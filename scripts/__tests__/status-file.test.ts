import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ageMinutes, deliverStatusFile, isStale, parseGeneratedAt, resolveDesktopDir, statusSourcePath } from '../lib/status-file';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cihub-status-'));
  dirs.push(dir);
  return dir;
}

const SAMPLE = '# CI-Hub node status\n\n_Generated 2026-09-09T12:00:00.000Z by Companion Hub 0.2.67._\n';

describe('resolveDesktopDir', () => {
  it('uses the XDG answer when it is a real directory', () => {
    const home = scratch();
    const desktop = join(home, 'Escritorio');
    mkdirSync(desktop);

    // Localised Desktop names are why we ask XDG at all rather than hardcoding.
    expect(resolveDesktopDir({ home, xdgLookup: () => desktop })).toBe(desktop);
  });

  it('refuses $HOME as a Desktop, which is what xdg-user-dir returns when unset', () => {
    const home = scratch();

    // Treating this as a Desktop would drop CI_HUB_STATUS.md in the home dir and
    // report success, which is worse than admitting there is no Desktop.
    expect(resolveDesktopDir({ home, xdgLookup: () => home })).toBeNull();
  });

  it('falls back to ~/Desktop when it exists and XDG says nothing', () => {
    const home = scratch();
    const desktop = join(home, 'Desktop');
    mkdirSync(desktop);

    expect(resolveDesktopDir({ home, xdgLookup: () => null })).toBe(desktop);
  });

  it('returns null on a machine with no Desktop rather than inventing one', () => {
    const home = scratch();

    expect(resolveDesktopDir({ home, xdgLookup: () => null })).toBeNull();
  });

  it('ignores an XDG path that does not exist', () => {
    const home = scratch();

    expect(resolveDesktopDir({ home, xdgLookup: () => join(home, 'nope') })).toBeNull();
  });
});

describe('deliverStatusFile', () => {
  it('copies the Hub-written file onto the Desktop', () => {
    const root = scratch();
    const source = join(root, 'CI_HUB_STATUS.md');
    const desktop = join(root, 'Desktop');
    writeFileSync(source, SAMPLE);
    mkdirSync(desktop);

    const result = deliverStatusFile({ source, desktopDir: desktop, now: new Date('2026-09-09T12:10:00.000Z') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.onDesktop).toBe(true);
    expect(existsSync(result.target)).toBe(true);
    expect(readFileSync(result.target, 'utf8')).toContain('CI-Hub node status');
    expect(result.generatedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(result.ageMinutes).toBe(10);
  });

  it('reports where the file actually is when there is no Desktop', () => {
    const root = scratch();
    const source = join(root, 'CI_HUB_STATUS.md');
    writeFileSync(source, SAMPLE);

    const result = deliverStatusFile({ source, desktopDir: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Still a success — the file exists and is named. It just is not on a Desktop,
    // and the caller is told so rather than being left to assume.
    expect(result.onDesktop).toBe(false);
    expect(result.target).toBe(source);
  });

  it('explains a missing source as the Hub not having run', () => {
    const root = scratch();

    const result = deliverStatusFile({ source: join(root, 'absent.md'), desktopDir: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/has not run/);
  });

  it('reports a copy failure instead of claiming success', () => {
    const root = scratch();
    const source = join(root, 'CI_HUB_STATUS.md');
    writeFileSync(source, SAMPLE);

    const result = deliverStatusFile({
      source,
      desktopDir: join(root, 'Desktop'),
      copy: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/EACCES/);
  });

  it('still copies when the timestamp line cannot be parsed', () => {
    const root = scratch();
    const source = join(root, 'CI_HUB_STATUS.md');
    const desktop = join(root, 'Desktop');
    writeFileSync(source, '# no timestamp here\n');
    mkdirSync(desktop);

    const result = deliverStatusFile({ source, desktopDir: desktop });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generatedAt).toBeNull();
    expect(existsSync(result.target)).toBe(true);
  });
});

describe('freshness', () => {
  it('parses the generated line the renderer writes', () => {
    expect(parseGeneratedAt(SAMPLE)).toBe('2026-09-09T12:00:00.000Z');
    expect(parseGeneratedAt('# nothing')).toBeNull();
  });

  it('computes age, and treats an unparseable date as unknown rather than zero', () => {
    expect(ageMinutes('2026-09-09T12:00:00.000Z', new Date('2026-09-09T13:00:00.000Z'))).toBe(60);
    expect(ageMinutes('not-a-date', new Date())).toBeNull();
    expect(ageMinutes(null, new Date())).toBeNull();
  });

  it('calls a file stale past the threshold, and never calls an unknown age stale', () => {
    // Unknown is not fresh, but it is also not evidence of staleness — the caller
    // is told the age is unknown instead of being given a fabricated verdict.
    expect(isStale(50)).toBe(true);
    expect(isStale(10)).toBe(false);
    expect(isStale(null)).toBe(false);
  });
});

describe('statusSourcePath', () => {
  it('points inside the data dir state folder the container already mounts', () => {
    expect(statusSourcePath('/var/lib/companion-hub')).toBe('/var/lib/companion-hub/state/CI_HUB_STATUS.md');
  });
});
