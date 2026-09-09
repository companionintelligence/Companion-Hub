import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusReportService, statusReportPath } from '../status-report.service';

// `writeReport` uses `node:fs/promises`, which the suite's `fs` mock does not
// cover, so these run against a real temp directory rather than memfs.
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'status-write-'));
  dirs.push(dir);
  return dir;
}

/** Only the pieces `writeReport` touches; gathering is covered by the render tests. */
function serviceWithStubbedReport() {
  const service = Object.create(StatusReportService.prototype) as StatusReportService;
  vi.spyOn(service, 'buildReport').mockResolvedValue({
    generatedAt: '2026-09-09T12:00:00.000Z',
    hubVersion: '0.2.67',
    connection: null,
    system: null,
    backends: [],
    models: [],
    workloads: [],
    problems: [],
  });
  return service;
}

describe('statusReportPath', () => {
  it('writes inside state/, the directory the container already bind-mounts', () => {
    // Anywhere else would need a new mount in both prod compose copies.
    expect(statusReportPath('/data')).toBe('/data/state/CI_HUB_STATUS.md');
  });
});

describe('writeReport', () => {
  it('creates the state directory when it does not exist yet', async () => {
    const root = await scratch();
    const target = join(root, 'state', 'CI_HUB_STATUS.md');

    await serviceWithStubbedReport().writeReport(target);

    expect(await readFile(target, 'utf8')).toContain('CI-Hub node status');
  });

  it('leaves no temp file behind', async () => {
    const root = await scratch();

    await serviceWithStubbedReport().writeReport(join(root, 'CI_HUB_STATUS.md'));

    // The rename is what makes the write atomic for the host-side copy that reads
    // this file on a cadence of its own; a leftover .tmp means it did not happen.
    expect(await readdir(root)).toEqual(['CI_HUB_STATUS.md']);
  });

  it('replaces a previous report rather than appending to it', async () => {
    const root = await scratch();
    const target = join(root, 'CI_HUB_STATUS.md');
    await mkdir(root, { recursive: true });
    await writeFile(target, 'stale content from an older run\n');

    await serviceWithStubbedReport().writeReport(target);

    const written = await readFile(target, 'utf8');
    expect(written).not.toContain('stale content');
    expect(written.match(/# CI-Hub node status/g)).toHaveLength(1);
  });

  it('returns the path it wrote, so a caller can report where it went', async () => {
    const root = await scratch();
    const target = join(root, 'CI_HUB_STATUS.md');

    await expect(serviceWithStubbedReport().writeReport(target)).resolves.toBe(target);
  });
});
