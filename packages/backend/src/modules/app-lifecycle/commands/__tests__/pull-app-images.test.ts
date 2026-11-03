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
  let recordedTags: string[];
  // An image here under a name no reference asks for: Docker doesn't find it by those references, only in the list.
  let hereUnderAnotherName: string[];
  let tagsOf: Map<string, string[]>;
  let docker: {
    imageIdLocally: ReturnType<typeof vi.fn>;
    imageIdsLocally: ReturnType<typeof vi.fn>;
    imageTagsLocally: ReturnType<typeof vi.fn>;
  };
  let files: { readPulledImages: ReturnType<typeof vi.fn>; writePulledImages: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };

  const deps = () => ({ docker, files, logger }) as never;

  beforeEach(() => {
    onComputer = new Map();
    recorded = [];
    recordedTags = [];
    hereUnderAnotherName = [];
    tagsOf = new Map();
    docker = {
      imageIdLocally: vi.fn(async (ref: string) => onComputer.get(ref) ?? null),
      imageIdsLocally: vi.fn(async () => new Set([...onComputer.values(), ...hereUnderAnotherName])),
      imageTagsLocally: vi.fn(async (id: string) => tagsOf.get(id) ?? []),
    };
    files = {
      readPulledImages: vi.fn(async () => ({ imageIds: [...recorded], imageTags: [...recordedTags] })),
      writePulledImages: vi.fn(async (_urn: AppUrn, { imageIds, imageTags }: { imageIds: string[]; imageTags: string[] }) => {
        recorded = [...imageIds];
        recordedTags = [...imageTags];
        return true;
      }),
    };
    logger = { warn: vi.fn() };
  });

  it('records the image a pull brought onto the computer for the app', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine'], pull, { forced: false });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).toHaveBeenCalledWith(appUrn, { imageIds: ['sha256:py'], imageTags: [] });
    expect(recorded).toEqual(['sha256:py']);
  });

  it('never records an image that was already on the computer, even when the pull replaces it under the same name', async () => {
    onComputer.set('postgres:16', 'sha256:old');
    const pull = vi.fn(async () => {
      onComputer.set('postgres:16', 'sha256:new');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['postgres:16'], pull, { forced: false });

    expect(files.writePulledImages).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('records the replacement of an image the app recorded before, so an update leaves no image of its own unrecorded', async () => {
    onComputer.set('app-image:1', 'sha256:v1');
    recorded = ['sha256:v1'];
    const pull = vi.fn(async () => {
      onComputer.set('app-image:1', 'sha256:v2');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app-image:1'], pull, { forced: true });

    expect(files.writePulledImages).toHaveBeenCalledWith(appUrn, { imageIds: ['sha256:v1', 'sha256:v2'], imageTags: [] });
  });

  it('keeps the images that did arrive when the pull fails part-way, and rethrows the pull error', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
      throw new Error('registry unreachable');
    });

    await expect(pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine', 'ghcr.io/example/side:1'], pull, { forced: false })).rejects.toThrow(
      'registry unreachable',
    );
    expect(recorded).toEqual(['sha256:py']);
  });

  it('records an image that two references name once', async () => {
    const pull = vi.fn(async () => {
      onComputer.set('app-web:1', 'sha256:web');
      onComputer.set('app-web:latest', 'sha256:web');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app-web:1', 'app-web:latest'], pull, { forced: false });

    expect(recorded).toEqual(['sha256:web']);
  });

  it('does not stop a pull when the record cannot be written, and says so', async () => {
    files.writePulledImages.mockResolvedValue(false);
    const pull = vi.fn(async () => {
      onComputer.set('python:3.13-alpine', 'sha256:py');
    });

    await expect(pullAppImagesRecorded(deps(), appUrn, ['python:3.13-alpine'], pull, { forced: false })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not record the images pulled for test-app:store'));
  });

  it('writes nothing when the pull brought no image onto the computer', async () => {
    onComputer.set('postgres:16', 'sha256:old');
    const pull = vi.fn(async () => undefined);

    await pullAppImagesRecorded(deps(), appUrn, ['postgres:16'], pull, { forced: false });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).not.toHaveBeenCalled();
  });

  it('never records an image that was here under another name, which the reference did not find', async () => {
    hereUnderAnotherName = ['sha256:mine'];
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:mine');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: false });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).not.toHaveBeenCalled();
  });

  it('records the tags an image arrived with, so uninstall can tell them from one added later', async () => {
    tagsOf.set('sha256:app', ['app:1']);
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: false });

    expect(files.writePulledImages).toHaveBeenCalledWith(appUrn, { imageIds: ['sha256:app'], imageTags: ['app:1'] });
  });

  it('keeps the tags already recorded and adds the new image with its own', async () => {
    onComputer.set('app:1', 'sha256:v1');
    recorded = ['sha256:v1'];
    recordedTags = ['app:1'];
    tagsOf.set('sha256:v2', ['app:2']);
    const pull = vi.fn(async () => {
      onComputer.set('app:2', 'sha256:v2');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:2'], pull, { forced: false });

    expect(files.writePulledImages).toHaveBeenCalledWith(appUrn, { imageIds: ['sha256:v1', 'sha256:v2'], imageTags: ['app:1', 'app:2'] });
  });

  // Its tags by now can include one someone else added. Recorded as the app's, that tag would go with the image.
  it('takes no tags from an image the app already recorded', async () => {
    hereUnderAnotherName = ['sha256:app'];
    recorded = ['sha256:app'];
    tagsOf.set('sha256:app', ['app:1', 'mine:prod']);
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: false });

    expect(docker.imageTagsLocally).not.toHaveBeenCalled();
    expect(files.writePulledImages).not.toHaveBeenCalled();
  });

  it('still records the image and says so when its tags cannot be read', async () => {
    docker.imageTagsLocally.mockRejectedValue(new Error('engine went away'));
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: false });

    expect(recorded).toEqual(['sha256:app']);
    expect(recordedTags).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read the tags of sha256:app'));
  });

  it('still pulls and records nothing when the images here cannot be listed', async () => {
    docker.imageIdsLocally.mockRejectedValue(new Error('engine went away'));
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: false });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not list the images here'));
  });

  it('records no replacement of its own image either when a forced pull cannot list the images here', async () => {
    onComputer.set('app:1', 'sha256:v1');
    recorded = ['sha256:v1'];
    docker.imageIdsLocally.mockRejectedValue(new Error('engine went away'));
    const pull = vi.fn(async () => {
      onComputer.set('app:1', 'sha256:v2');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:1'], pull, { forced: true });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).not.toHaveBeenCalled();
  });

  it('does not list the images or read tags when nothing is missing and the pull is not forced, which is every ordinary start', async () => {
    onComputer.set('app:1', 'sha256:app');
    recorded = ['sha256:app'];
    onComputer.set('postgres:16', 'sha256:mine');

    await pullAppImagesRecorded(
      deps(),
      appUrn,
      ['app:1', 'postgres:16'],
      vi.fn(async () => undefined),
      { forced: false },
    );

    expect(docker.imageIdsLocally).not.toHaveBeenCalled();
    expect(docker.imageTagsLocally).not.toHaveBeenCalled();
    expect(files.writePulledImages).not.toHaveBeenCalled();
    expect(docker.imageIdLocally).toHaveBeenCalledTimes(3);
  });

  it("does not list the images when no reference is the app's to record", async () => {
    onComputer.set('postgres:16', 'sha256:mine');

    await pullAppImagesRecorded(
      deps(),
      appUrn,
      ['postgres:16'],
      vi.fn(async () => undefined),
      { forced: true },
    );

    expect(docker.imageIdsLocally).not.toHaveBeenCalled();
  });

  // The tags read after the pull would hold the other name too. Once `app:latest` moves on, that name is the image's only tag and uninstall takes it for the app's.
  it('never records an image a moved tag landed on that was here under another name', async () => {
    onComputer.set('app:latest', 'sha256:v1');
    recorded = ['sha256:v1'];
    recordedTags = ['app:latest'];
    hereUnderAnotherName = ['sha256:mine'];
    tagsOf.set('sha256:mine', ['app:2.0', 'app:latest']);
    const pull = vi.fn(async () => {
      onComputer.set('app:latest', 'sha256:mine');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:latest'], pull, { forced: true });

    expect(files.writePulledImages).not.toHaveBeenCalled();
    expect(recorded).toEqual(['sha256:v1']);
    expect(recordedTags).toEqual(['app:latest']);
  });

  it('still pulls when an image cannot be looked up and does not record that image', async () => {
    docker.imageIdLocally.mockRejectedValueOnce(new Error('invalid reference format'));
    const pull = vi.fn(async () => {
      onComputer.set('app:${VERSION}', 'sha256:app');
    });

    await pullAppImagesRecorded(deps(), appUrn, ['app:${VERSION}'], pull, { forced: false });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(files.writePulledImages).not.toHaveBeenCalled();
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

    await pullAppImagesRecorded(deps(), appUrn, ['a:1', 'b:1'], pull, { forced: false });

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
        { forced: false },
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
      await recordComposeUpPulls(
        moduleRef(),
        customApp,
        async () => {
          onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
        },
        { forced: false },
      );

      expect(recorded).toEqual(['sha256:whoami']);
    });

    it('records images for an official app whose compose uses an audited security grant', async () => {
      const image = 'homeassistant/home-assistant:stable';
      compose = {
        schemaVersion: 2,
        services: [{ name: 'web', image, isMain: true, internalPort: 80, privileged: true }],
      };

      await recordComposeUpPulls(
        moduleRef(),
        'home-assistant:ci-marketplace' as AppUrn,
        async () => {
          onComputer.set(image, 'sha256:home-assistant');
        },
        { forced: false },
      );

      expect(recorded).toEqual(['sha256:home-assistant']);
    });

    it('never records an image that was on the computer before the start', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:mine');

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined, { forced: false });

      expect(files.writePulledImages).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });

    it('does not start recording an image that was already there on any later start', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:mine');

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined, { forced: false });
      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined, { forced: false });

      expect(files.writePulledImages).not.toHaveBeenCalled();
    });

    it('writes nothing again when a later start finds the image it recorded', async () => {
      await recordComposeUpPulls(
        moduleRef(),
        customApp,
        async () => {
          onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
        },
        { forced: false },
      );
      files.writePulledImages.mockClear();

      await recordComposeUpPulls(moduleRef(), customApp, async () => undefined, { forced: false });

      expect(files.writePulledImages).not.toHaveBeenCalled();
      expect(recorded).toEqual(['sha256:whoami']);
    });

    it('adds the new image when the app is edited to use one that is not here and keeps the old one', async () => {
      onComputer.set('traefik/whoami:v1.10.2', 'sha256:old');
      recorded = ['sha256:old'];
      compose = composeNaming('traefik/whoami:v1.10.1');

      await recordComposeUpPulls(
        moduleRef(),
        customApp,
        async () => {
          onComputer.set('traefik/whoami:v1.10.1', 'sha256:new');
        },
        { forced: false },
      );

      expect(recorded).toEqual(['sha256:old', 'sha256:new']);
    });

    it('keeps what arrived when the start fails after pulling, so the next start does not take it for an image that was here', async () => {
      await expect(
        recordComposeUpPulls(
          moduleRef(),
          customApp,
          async () => {
            onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
            throw new Error('port is already allocated');
          },
          { forced: false },
        ),
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

      await recordComposeUpPulls(
        moduleRef(),
        customApp,
        async () => {
          onComputer.set('app:arm64', 'sha256:arm');
        },
        { forced: false },
      );

      expect(recorded).toEqual(['sha256:arm']);
    });

    it('still starts the app when its compose cannot be read, recording nothing', async () => {
      compose = { services: 'not services' };
      const up = vi.fn(async () => undefined);

      await recordComposeUpPulls(moduleRef(), customApp, up, { forced: false });

      expect(up).toHaveBeenCalledTimes(1);
      expect(files.writePulledImages).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read which images port-test:_user uses'));
    });

    it('records nothing for an app with no compose JSON', async () => {
      compose = null;
      const up = vi.fn(async () => undefined);

      await recordComposeUpPulls(moduleRef(), customApp, up, { forced: false });

      expect(up).toHaveBeenCalledTimes(1);
      expect(docker.imageIdLocally).not.toHaveBeenCalled();
    });
  });
});
