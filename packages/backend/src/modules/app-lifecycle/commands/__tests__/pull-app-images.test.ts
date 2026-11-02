import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@ci-hub/common/types';
import { pullAppImagesRecorded, recordComposeUpPulls } from '../pull-app-images';

describe('pullAppImagesRecorded', () => {
  const appUrn = 'test-app:store' as AppUrn;

  // The images on this computer by reference. A reference with no entry names no image yet.
  let onComputer: Map<string, string>;
  // The record the app holds, as AppFilesManager keeps it.
  let recorded: string[];
  let docker: { imageIdLocally: ReturnType<typeof vi.fn> };
  let files: { readPulledImageIds: ReturnType<typeof vi.fn>; writePulledImageIds: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };

  const deps = () => ({ docker, files, logger }) as never;

  beforeEach(() => {
    onComputer = new Map();
    recorded = [];
    docker = { imageIdLocally: vi.fn(async (ref: string) => onComputer.get(ref) ?? null) };
    files = {
      readPulledImageIds: vi.fn(async () => [...recorded]),
      writePulledImageIds: vi.fn(async (_urn: AppUrn, ids: string[]) => {
        recorded = [...ids];
        return true;
      }),
    };
    logger = { warn: vi.fn() };
  });

  it('records the image a pull brought onto the computer for the app', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine'], pull);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImageIds).toHaveBeenCalledWith(appUrn, ['sha256:py']);
    expect(recorded).toEqual(['sha256:py']);
  });

  it('never records an image that was already on the computer, even when the pull replaces it under the same name', async () => {
    onComputer.set('postgres:16', 'sha256:old');
    const pull = vi.fn(async () => {
      onComputer.set('postgres:16', 'sha256:new');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['postgres:16'], pull);

    expect(files.writePulledImageIds).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('records the replacement of an image the app recorded before, so an update leaves no image of its own unrecorded', async () => {
    onComputer.set('app-image:1', 'sha256:v1');
    recorded = ['sha256:v1'];
    const pull = vi.fn(async () => {
      onComputer.set('app-image:1', 'sha256:v2');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app-image:1'], pull);

    expect(files.writePulledImageIds).toHaveBeenCalledWith(appUrn, ['sha256:v1', 'sha256:v2']);
  });

  it('keeps the images that did arrive when the pull fails part-way, and rethrows the pull error', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
      throw new Error('registry unreachable');
    });

    await expect(pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine', 'ghcr.io/example/side:1'], pull)).rejects.toThrow(
      'registry unreachable',
    );
    expect(recorded).toEqual(['sha256:py']);
  });

  it('records an image that two references name once', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('app-web:1', 'sha256:web');
      onComputer.set('app-web:latest', 'sha256:web');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app-web:1', 'app-web:latest'], pull);

    expect(recorded).toEqual(['sha256:web']);
  });

  it('does not stop a pull when the record cannot be written, and says so', async () => {
    files.writePulledImageIds.mockResolvedValue(false);
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
    });

    await expect(pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine'], pull)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not record the images pulled for test-app:store'));
  });

  it('writes nothing when the pull brought no image onto the computer', async () => {
    onComputer.set('postgres:16', 'sha256:old');
    const pull = vi.fn(async () => undefined);

    await pullAppImagesRecorded(deps(), appUrn, ['postgres:16'], pull);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImageIds).not.toHaveBeenCalled();
  });

  it('still pulls when an image cannot be looked up and does not record that image', async () => {
    docker.imageIdLocally.mockRejectedValueOnce(new Error('invalid reference format'));
    const pull = vi.fn(async () => {
      onComputer.set('app:${VERSION}', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:${VERSION}'], pull);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImageIds).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not look up app:${VERSION}'));
  });

  it('records the other images when one cannot be looked up after the pull', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('a:1', 'sha256:a');
      onComputer.set('b:1', 'sha256:b');
    });
    docker.imageIdLocally.mockImplementation(async (ref: string) => {
      if (ref === 'a:1' && onComputer.has(ref)) throw new Error('engine went away');
      return onComputer.get(ref) ?? null;
    });

    await pullAppImagesRecorded(deps(), appUrn, ['a:1', 'b:1'], pull);

    expect(recorded).toEqual(['sha256:b']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not look up a:1 after pulling'));
  });

  it('stops waiting for a Docker engine that does not answer', async () => {
    vi.useFakeTimers();
    try {
      docker.imageIdLocally.mockImplementation(() => new Promise(() => undefined));

      const run = pullAppImagesRecorded(
        deps(),
        appUrn,
        ['a:1'],
        vi.fn(async () => undefined),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await run;

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer in time'));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('recordComposeUpPulls', () => {
    const customApp = 'port-test:_user' as AppUrn;
    let compose: unknown;
    let architecture: string;

    const moduleRef = () =>
      ({
        get: (token: unknown) => {
          if (token === LoggerService) return logger;
          if (token === DockerService) return docker;
          if (token === ConfigurationService) return { get: () => architecture };
          if (token === AppFilesManager) return { ...files, getDockerComposeJson: vi.fn(async () => ({ path: '/tmp', content: compose })) };
          return undefined;
        },
      }) as unknown as ModuleRef;

    const composeNaming = (image: string) => ({
      schemaVersion: 2,
      services: [{ name: 'web', image, isMain: true, internalPort: 80 }],
    });

    beforeEach(() => {
      architecture = 'amd64';
      compose = composeNaming('traefik/whoami:v1.10.2');
    });

    it('records the image a first start pulled', async () => {
      await recordComposeUpPulls(moduleRef(), customApp, async () => {
        onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
      });

      expect(recorded).toEqual(['sha256:whoami']);
    });

    it('never records an image that was on the computer before the start', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:mine');

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined);

      expect(files.writePulledImageIds).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });

    it('does not start recording an image that was already there on any later start', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:mine');

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined);
      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined);

      expect(files.writePulledImageIds).not.toHaveBeenCalled();
    });

    it('writes nothing again when a later start finds the image it recorded', async () => {
      await recordComposeUpPulls(moduleRef(), customApp, async () => {
        onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
      });
      files.writePulledImageIds.mockClear();

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined);

      expect(files.writePulledImageIds).not.toHaveBeenCalled();
      expect(recorded).toEqual(['sha256:whoami']);
    });

    it('adds the new image when the app is edited to use one that is not here and keeps the old one', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:old');
      recorded = ['sha256:old'];
      compose = composeNaming('traefik/whoami:v1.10.1');

      await recordComposeUpPulls(moduleRef(), customApp, async () => {
        onComputer.set('traefik/whoami:v1.10.1', 'sha256:new');
      });

      expect(recorded).toEqual(['sha256:old', 'sha256:new']);
    });

    it('keeps what arrived when the start fails after pulling, so the next start does not take it for an image that was here', async () => {
      await expect(
        recordComposeUpPulls(moduleRef(), customApp, async () => {
          onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
          throw new Error('port is already allocated');
        }),
      ).rejects.toThrow('port is already allocated');

      expect(recorded).toEqual(['sha256:whoami']);
    });

    it('looks at the image the architecture override names, which is the one compose pulls', async () => {
      architecture = 'arm64';
      compose = {
        schemaVersion: 2,
        services: [{ name: 'web', image: 'app:amd64', isMain: true, internalPort: 80 }],
        overrides: [{ architecture: 'arm64', services: [{ name: 'web', image: 'app:arm64' }] }],
      };

      await recordComposeUpPulls(moduleRef(), customApp, async () => {
        onComputer.set('app:arm64', 'sha256:arm');
      });

      expect(recorded).toEqual(['sha256:arm']);
    });

    it('still starts the app when its compose cannot be read, recording nothing', async () => {
      compose = { services: 'not services' };
      const up = vi.fn(async () => undefined);

      await recordComposeUpPulls(moduleRef(), customApp, up);

      expect(up).toHaveBeenCalledTimes(1);
      expect(files.writePulledImageIds).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read which images port-test:_user uses'));
    });

    it('records nothing for an app with no compose JSON', async () => {
      compose = null;
      const up = vi.fn(async () => undefined);

      await recordComposeUpPulls(moduleRef(), customApp, up);

      expect(up).toHaveBeenCalledTimes(1);
      expect(docker.imageIdLocally).not.toHaveBeenCalled();
    });
  });
});
