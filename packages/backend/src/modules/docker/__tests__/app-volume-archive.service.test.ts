import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { vol } from 'memfs';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AppVolumeArchiveService } from '../app-volume-archive.service';
import { DockerReadFacade } from '../docker-read.facade';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

type DockerStdio = [unknown, unknown, unknown];

const spawn = vi.mocked(child_process.spawn);

/**
 * Every `docker` run from here on does `act` with the stdio it was handed (a file descriptor stands for
 * the file the service opened), then exits with `code` after printing `stderr`.
 */
const dockerRuns = (act: (stdio: DockerStdio) => void = () => undefined, code = 0, stderr = '') => {
  spawn.mockImplementation(((_command: string, _args: string[], options: { stdio: DockerStdio }) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
    setImmediate(() => {
      act(options.stdio);
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  }) as never);
};

const notFound = () => Object.assign(new Error('(HTTP code 404) no such object'), { statusCode: 404 });

describe('AppVolumeArchiveService', () => {
  const appUrn = 'wordpress:ci-marketplace' as AppUrn;
  const database = 'wordpress_ci-marketplace_data-mariadb';
  const composeLabels = { 'com.docker.compose.project': 'wordpress_ci-marketplace', 'com.docker.compose.volume': 'data-mariadb' };
  const archive = path.join('/data', 'tmp', 'data-mariadb.tar');
  const helperFlags = ['--network', 'none', '--user', '0:0', '--pull', 'never', '--log-driver', 'none'];

  let docker: MockProxy<Dockerode>;
  let service: AppVolumeArchiveService;

  beforeEach(() => {
    spawn.mockReset();
    vol.mkdirSync(path.dirname(archive), { recursive: true });

    docker = mock<Dockerode>();
    // The Hub runs in the container named ci-hub; nothing else answers to its names.
    docker.getContainer.mockImplementation(((id: string) => ({
      inspect: id === 'ci-hub' ? vi.fn().mockResolvedValue({ Image: 'sha256:hub' }) : vi.fn().mockRejectedValue(notFound()),
    })) as never);
    docker.listVolumes.mockResolvedValue({ Volumes: [{ Name: database, Labels: composeLabels }], Warnings: [] } as never);

    const logger = mock<LoggerService>();
    service = new AppVolumeArchiveService(docker, new DockerReadFacade(logger, docker), logger);
  });

  it("lists the volumes compose made for the app's project, under their compose keys", async () => {
    await expect(service.listAppVolumes(appUrn)).resolves.toEqual([{ name: database, key: 'data-mariadb' }]);

    expect(docker.listVolumes).toHaveBeenCalledWith({
      filters: { label: ['com.docker.compose.project=wordpress_ci-marketplace', 'com.docker.compose.volume'] },
    });
  });

  it("copies a volume into a file through a read-only, offline container of the Hub's own image", async () => {
    dockerRuns(([, stdout]) => fs.writeSync(stdout as number, 'volume as tar'));

    await service.exportVolume(database, archive);

    expect(fs.readFileSync(archive, 'utf8')).toBe('volume as tar');
    expect(spawn).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', ...helperFlags, '-v', `${database}:/volume:ro`, '--entrypoint', 'tar', 'sha256:hub', '-c', '-f', '-', '-C', '/volume', '.'],
      expect.anything(),
    );
  });

  it('fails when docker hands back nothing, since a tar of a volume always holds its root folder', async () => {
    dockerRuns();

    await expect(service.exportVolume(database, archive)).rejects.toThrow(database);
  });

  it('fails with what docker said when a copy does not finish', async () => {
    dockerRuns(() => undefined, 1, 'tar: write error: No space left on device');

    await expect(service.exportVolume(database, archive)).rejects.toThrow('No space left on device');
  });

  it('empties the volume, then unpacks the archive into it from stdin', async () => {
    vol.writeFileSync(archive, 'volume as tar');
    const stdin: string[] = [];
    dockerRuns(([input]) => {
      if (typeof input === 'number') stdin.push(fs.readFileSync(input, 'utf8'));
    });

    await service.importVolume(appUrn, { name: database, key: 'data-mariadb', create: false }, archive);

    expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
      ['run', '--rm', ...helperFlags, '-v', `${database}:/volume`, '--entrypoint', 'find', 'sha256:hub', '/volume', '-mindepth', '1', '-delete'],
      [
        'run',
        '--rm',
        '-i',
        ...helperFlags,
        '-v',
        `${database}:/volume`,
        '--entrypoint',
        'tar',
        'sha256:hub',
        '--numeric-owner',
        '-x',
        '-f',
        '-',
        '-C',
        '/volume',
      ],
    ]);
    expect(stdin).toEqual(['volume as tar']);
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it('does not unpack into a volume it could not empty', async () => {
    vol.writeFileSync(archive, 'volume as tar');
    dockerRuns(() => undefined, 1, 'find: /volume/ibdata1: Operation not permitted');

    await expect(service.importVolume(appUrn, { name: database, key: 'data-mariadb', create: false }, archive)).rejects.toThrow(
      'Operation not permitted',
    );

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('first creates a volume that is missing, labelled the way compose labels its own', async () => {
    vol.writeFileSync(archive, 'volume as tar');
    dockerRuns();

    await service.importVolume(appUrn, { name: database, key: 'data-mariadb', create: true }, archive);

    expect(docker.createVolume).toHaveBeenCalledWith({ Name: database, Labels: composeLabels });
    expect(docker.createVolume.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0] ?? 0);
  });

  describe('restoreTargets', () => {
    it("sends each archived volume back to the app's volume with that key", async () => {
      docker.listVolumes.mockResolvedValue({
        Volumes: [{ Name: 'custom-db', Labels: { ...composeLabels, 'com.docker.compose.volume': 'db' } }],
      } as never);

      await expect(service.restoreTargets(appUrn, ['db'])).resolves.toEqual([{ name: 'custom-db', key: 'db', create: false }]);
    });

    it('names a volume the app no longer has the way compose would, for the restore to create', async () => {
      docker.listVolumes.mockResolvedValue({ Volumes: [] } as never);
      docker.getVolume.mockReturnValue({ inspect: vi.fn().mockRejectedValue(notFound()) } as never);

      await expect(service.restoreTargets(appUrn, ['data-mariadb'])).resolves.toEqual([{ name: database, key: 'data-mariadb', create: true }]);
    });

    it('refuses a volume name that something other than this app already has', async () => {
      docker.listVolumes.mockResolvedValue({ Volumes: [] } as never);
      docker.getVolume.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Name: database, Labels: { 'com.docker.compose.project': 'other' } }),
      } as never);

      await expect(service.restoreTargets(appUrn, ['data-mariadb'])).rejects.toThrow(database);
    });
  });

  it("will not run without the Hub's own image, rather than pull another one", async () => {
    docker.getContainer.mockImplementation((() => ({ inspect: vi.fn().mockRejectedValue(notFound()) })) as never);

    await expect(service.restoreTargets(appUrn, ['data-mariadb'])).rejects.toThrow("the Hub's own container");
    await expect(service.exportVolume(database, archive)).rejects.toThrow("the Hub's own container");
    expect(spawn).not.toHaveBeenCalled();
  });
});
