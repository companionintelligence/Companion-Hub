import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { FactoryResetService } from '@/modules/system/factory-reset.service';
import type { AppUrn } from '@ci-hub/common/types';
import { recordComposeUpPulls } from '../pull-app-images';
import { UninstallAppCommand } from '../uninstall-app-command';

const SHARED = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const TAG = 'postgres:16-alpine';
const PIN = 'postgres:16-alpine@sha256:d1';
const DIGEST_NAME = 'postgres@sha256:d1';

const FIRST = 'first-app:store' as AppUrn;
const SECOND = 'second-app:store' as AppUrn;
const THIRD = 'third-app:store' as AppUrn;

/** A Docker engine that answers as the live checks in #2226 saw one answer: removal by ID takes a single tag without asking and refuses two. */
class FakeEngine {
  readonly images = new Map<string, { tags: string[]; digestNames: string[] }>();
  failTagReadsFor: string | null = null;

  add(id: string, tags: string[], digestNames: string[] = []) {
    this.images.set(id, { tags, digestNames });
  }

  has(id: string) {
    return this.images.has(id);
  }

  private resolve(ref: string) {
    if (this.images.has(ref)) {
      return ref;
    }
    for (const [id, { tags, digestNames }] of this.images) {
      const [name, digest] = ref.split('@');
      const repo = name?.split(':')[0];
      if (tags.includes(ref) || digestNames.includes(ref) || (digest && digestNames.includes(`${repo}@${digest}`))) {
        return id;
      }
    }
    return null;
  }

  getImage(ref: string) {
    const id = this.resolve(ref);
    return {
      inspect: async () => {
        if (!id) {
          throw new Error(`No such image: ${ref}`);
        }
        if (id === this.failTagReadsFor && ref === id) {
          throw new Error('the engine went away');
        }
        return { Id: id, RepoTags: this.images.get(id)?.tags ?? [] };
      },
      remove: async () => {
        if (!id) {
          throw new Error(`No such image: ${ref}`);
        }
        if ((this.images.get(id)?.tags.length ?? 0) > 1) {
          throw new Error('conflict: unable to delete, must be forced');
        }
        this.images.delete(id);
      },
    };
  }
}

/** Hands control back between each step, as the real file calls do, so two uninstalls at once really do interleave. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeFiles {
  readonly files = new Map<string, string>();
  readonly unwritable = new Set<string>();
  readonly calls: string[] = [];

  readTextFile = async (filePath: string) => {
    await nextTurn();
    return this.files.get(filePath) ?? null;
  };

  writeTextFile = async (filePath: string, content: string) => {
    await nextTurn();
    this.calls.push(`write ${filePath}`);
    if (this.unwritable.has(filePath)) {
      return false;
    }
    this.files.set(filePath, content);
    return true;
  };

  pathExists = async (filePath: string) => this.files.has(filePath);

  removeFile = async (filePath: string) => {
    this.calls.push(`remove ${filePath}`);
    return this.files.delete(filePath);
  };

  removeDirectory = async (dirPath: string) => {
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(dirPath)) {
        this.files.delete(filePath);
      }
    }
    return true;
  };
}

const listPath = (urn: AppUrn) => {
  const [name, store] = urn.split(':');
  return `/data/state/pulled-images/${store}/${name}.json`;
};

describe('An image two installed apps share', () => {
  let engine: FakeEngine;
  let disk: FakeFiles;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let files: AppFilesManager;
  let docker: DockerService;
  let rows: Array<{ appName: string; appStoreSlug: string; status?: string }>;
  let composeOf: Map<AppUrn, string[] | null>;
  let beforeDown: Map<AppUrn, () => Promise<void> | void>;
  let moduleRef: ModuleRef;

  const install = (urn: AppUrn, images: string[], status?: string) => {
    const [appName = '', appStoreSlug = ''] = urn.split(':');
    rows.push({ appName, appStoreSlug, ...(status ? { status } : {}) });
    composeOf.set(urn, images);
  };

  const dropRow = (urn: AppUrn) => {
    rows = rows.filter((row) => `${row.appName}:${row.appStoreSlug}` !== urn);
  };

  const record = (urn: AppUrn, imageIds: string[], imageTags: string[] = []) => files.writePulledImages(urn, { imageIds, imageTags });
  const recordOf = (urn: AppUrn) => files.readPulledImages(urn);
  const hasRecord = (urn: AppUrn) => disk.files.has(listPath(urn));

  // The lifecycle service takes the row away once the command succeeds.
  const uninstall = async (urn: AppUrn) => {
    const result = await new UninstallAppCommand(moduleRef, mock<Dockerode>()).execute(urn);
    if (result.success) {
      dropRow(urn);
    }
    return result;
  };

  beforeEach(() => {
    engine = new FakeEngine();
    disk = new FakeFiles();
    logger = mock<LoggerService>();
    rows = [];
    composeOf = new Map();
    beforeDown = new Map();

    const configuration = {
      getConfig: () => ({ directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' } }),
    } as unknown as ConfigurationService;
    files = new AppFilesManager(configuration, disk as unknown as FilesystemService, logger);
    vi.spyOn(files, 'getInstalledAppInfo').mockResolvedValue(null);
    vi.spyOn(files, 'deleteAppFolder').mockResolvedValue(true);
    vi.spyOn(files, 'deleteAppDataDirDetailed').mockResolvedValue({ removed: true, permissionDenied: false });
    vi.spyOn(files, 'getDockerComposeJson').mockImplementation(async (urn: AppUrn) => {
      const images = composeOf.get(urn);
      return {
        path: '/tmp',
        content: images
          ? { schemaVersion: 2, services: images.map((image, index) => ({ name: `s${index}`, image, isMain: index === 0, internalPort: 80 })) }
          : null,
      };
    });

    const dockerode = {
      getImage: (ref: string) => engine.getImage(ref),
      // Only the lookup for images compose built passes a filter and these apps built none.
      listImages: async (options?: { filters?: unknown }) => (options?.filters ? [] : [...engine.images.keys()].map((Id) => ({ Id }))),
    };
    docker = new DockerService(logger, mock(), mock(), mock(), mock(), dockerode as never, mock());
    vi.spyOn(docker, 'composeApp').mockImplementation((async (urn: AppUrn) => {
      await beforeDown.get(urn)?.();
      await nextTurn();
      return { success: true };
    }) as never);
    vi.spyOn(docker, 'removeAppNetworks').mockResolvedValue(undefined);
    vi.spyOn(docker as unknown as { getComposeProjectName: () => string }, 'getComposeProjectName').mockReturnValue('project');

    moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppFilesManager) return files;
        if (token === DockerService) return docker;
        if (token === AppsRepository) return { getApps: async () => [...rows] };
        if (token === ConfigurationService) return { get: () => undefined };
        return null;
      }),
    } as unknown as ModuleRef;
  });

  it('stays while the second app is installed, then goes with it', async () => {
    engine.add(SHARED, [], [DIGEST_NAME]);
    install(FIRST, [PIN]);
    install(SECOND, [PIN]);
    await record(FIRST, [SHARED]);

    await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

    expect(engine.has(SHARED)).toBe(true);
    expect(hasRecord(FIRST)).toBe(false);
    await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await expect(uninstall(SECOND)).resolves.toMatchObject({ success: true });

    expect(engine.has(SHARED)).toBe(false);
    expect(hasRecord(SECOND)).toBe(false);
  });

  it('moves along three apps and goes with the last', async () => {
    engine.add(SHARED, [], [DIGEST_NAME]);
    install(FIRST, [PIN]);
    install(SECOND, [PIN]);
    install(THIRD, [PIN]);
    await record(FIRST, [SHARED]);

    await uninstall(FIRST);
    expect(engine.has(SHARED)).toBe(true);
    await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await uninstall(SECOND);
    expect(engine.has(SHARED)).toBe(true);
    expect(hasRecord(SECOND)).toBe(false);
    await expect(recordOf(THIRD)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await uninstall(THIRD);
    expect(engine.has(SHARED)).toBe(false);
  });

  it('goes with the last app when an app without the record leaves first', async () => {
    engine.add(SHARED, [], [DIGEST_NAME]);
    install(FIRST, [PIN]);
    install(SECOND, [PIN]);
    install(THIRD, [PIN]);
    await record(FIRST, [SHARED]);

    await uninstall(SECOND);
    expect(engine.has(SHARED)).toBe(true);
    await expect(recordOf(FIRST)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await uninstall(FIRST);
    expect(engine.has(SHARED)).toBe(true);
    await expect(recordOf(THIRD)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await uninstall(THIRD);
    expect(engine.has(SHARED)).toBe(false);
  });

  it('adds to what the other app already recorded', async () => {
    engine.add(SHARED, [TAG]);
    engine.add(OTHER, ['own:1']);
    install(FIRST, [TAG]);
    install(SECOND, [TAG, 'own:1']);
    await record(FIRST, [SHARED], [TAG]);
    await record(SECOND, [OTHER], ['own:1']);

    await uninstall(FIRST);

    await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [OTHER, SHARED], imageTags: ['own:1', TAG] });
  });

  it("goes to a stopped custom app, in that app's own folder", async () => {
    const custom = 'mine:_user' as AppUrn;
    engine.add(SHARED, [TAG]);
    install(FIRST, [TAG]);
    install(custom, [TAG], 'stopped');
    await record(FIRST, [SHARED], [TAG]);

    await uninstall(FIRST);

    expect(disk.files.has('/data/state/pulled-images/_user/mine.json')).toBe(true);

    await uninstall(custom);
    expect(engine.has(SHARED)).toBe(false);
  });

  it('survives the other app starting again, which pulls nothing', async () => {
    engine.add(SHARED, [TAG]);
    install(FIRST, [TAG]);
    install(SECOND, [TAG]);
    await record(FIRST, [SHARED], [TAG]);
    await uninstall(FIRST);

    await recordComposeUpPulls(moduleRef, SECOND, async () => undefined, { forced: false });

    await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
    await uninstall(SECOND);
    expect(engine.has(SHARED)).toBe(false);
  });

  it('survives the other app pulling something else while it is handed over', async () => {
    engine.add(SHARED, [TAG]);
    install(FIRST, [TAG]);
    install(SECOND, [TAG, 'new:1']);
    await record(FIRST, [SHARED], [TAG]);

    await recordComposeUpPulls(
      moduleRef,
      SECOND,
      async () => {
        await uninstall(FIRST);
        engine.add(OTHER, ['new:1']);
      },
      { forced: false },
    );

    await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED, OTHER], imageTags: [TAG, 'new:1'] });
  });

  it('comes back to the first app when it is installed again and the second goes', async () => {
    engine.add(SHARED, [], [DIGEST_NAME]);
    install(FIRST, [PIN]);
    install(SECOND, [PIN]);
    await record(FIRST, [SHARED]);
    await uninstall(FIRST);
    install(FIRST, [PIN]);

    await uninstall(SECOND);
    expect(engine.has(SHARED)).toBe(true);
    await expect(recordOf(FIRST)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

    await uninstall(FIRST);
    expect(engine.has(SHARED)).toBe(false);
  });

  describe('its tags', () => {
    it("go with it, or the next uninstall would take them for someone else's and keep it", async () => {
      engine.add(SHARED, [TAG]);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED], [TAG]);

      await uninstall(FIRST);

      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
      await uninstall(SECOND);
      expect(engine.has(SHARED)).toBe(false);
    });

    it('stay behind when someone pulled one by hand, so the image stays when the last app goes', async () => {
      engine.add(SHARED, [TAG], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      // The first app pinned the image, which leaves no tag. Docker removes an image with one tag without asking.
      await record(FIRST, [SHARED], []);

      await uninstall(FIRST);

      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
      await uninstall(SECOND);
      expect(engine.has(SHARED)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`it has a tag this app did not bring in (${TAG})`));
    });

    it('leave out a second tag someone gave it', async () => {
      engine.add(SHARED, [TAG, 'mine:prod']);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED], [TAG]);

      await uninstall(FIRST);

      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
      await uninstall(SECOND);
      expect(engine.has(SHARED)).toBe(true);
    });

    it('leave out a tag of another image on the same record, which stays with that image', async () => {
      engine.add(SHARED, [TAG]);
      engine.add(OTHER, ['own:1']);
      install(FIRST, [TAG, 'own:1']);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED, OTHER], [TAG, 'own:1']);

      await uninstall(FIRST);

      expect(engine.has(OTHER)).toBe(false);
      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
    });

    it('leave out one the image no longer has: it moved to another image', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED], [TAG]);

      await uninstall(FIRST);

      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
    });
  });

  describe('under different references', () => {
    it('goes with the second app when the first named a tag and the second pins the digest', async () => {
      engine.add(SHARED, [TAG], [DIGEST_NAME]);
      install(FIRST, [TAG]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED], [TAG]);

      await uninstall(FIRST);
      expect(engine.has(SHARED)).toBe(true);

      await uninstall(SECOND);
      expect(engine.has(SHARED)).toBe(false);
    });

    // Nothing shows whether the second app's pull or a person gave it that tag, so it counts as a person's.
    it('stays when the first pinned the digest and the second named a tag, since that tag was never on the record', async () => {
      engine.add(SHARED, [TAG], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED], []);

      await uninstall(FIRST);
      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

      await uninstall(SECOND);
      expect(engine.has(SHARED)).toBe(true);
    });
  });

  it('never touches an image that was here before any app: it is on no record to hand over', async () => {
    engine.add(SHARED, [TAG]);
    install(FIRST, [TAG]);
    install(SECOND, [TAG]);

    await uninstall(FIRST);
    await uninstall(SECOND);

    expect(engine.has(SHARED)).toBe(true);
    expect(disk.calls.filter((call) => call.startsWith('write'))).toEqual([]);
  });

  describe('when the handover fails', () => {
    it('stays and the uninstall still succeeds when the other record cannot be written and the first record keeps it', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED]);
      disk.unwritable.add(listPath(SECOND));

      await expect(uninstall(FIRST)).resolves.toEqual({ success: true, message: `App ${FIRST} uninstalled successfully` });

      expect(engine.has(SHARED)).toBe(true);
      await expect(recordOf(FIRST)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Could not hand image ${SHARED} over to ${SECOND}`));
    });

    it('leaves on the first record only what it could not hand over', async () => {
      const third = `sha256:${'c'.repeat(64)}`;
      engine.add(SHARED, [TAG]);
      engine.add(OTHER, ['handed:1']);
      engine.add(third, ['alone:1']);
      install(FIRST, [TAG, 'handed:1', 'alone:1']);
      install(SECOND, [TAG]);
      install(THIRD, ['handed:1']);
      await record(FIRST, [SHARED, OTHER, third], [TAG, 'handed:1', 'alone:1']);
      disk.unwritable.add(listPath(SECOND));

      await uninstall(FIRST);

      await expect(recordOf(FIRST)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
      await expect(recordOf(THIRD)).resolves.toEqual({ imageIds: [OTHER], imageTags: ['handed:1'] });
      expect(engine.has(third)).toBe(false);
    });

    it("hands nothing over when its tags cannot be read, since one of them could be a person's", async () => {
      engine.add(SHARED, [TAG]);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED], [TAG]);
      engine.failTagReadsFor = SHARED;

      await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

      expect(engine.has(SHARED)).toBe(true);
      expect(hasRecord(SECOND)).toBe(false);
      await expect(recordOf(FIRST)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
    });

    it('says so when the first record cannot be cut down either', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED]);
      disk.unwritable.add(listPath(SECOND));
      disk.unwritable.add(listPath(FIRST));

      await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Could not cut the record of the images pulled for ${FIRST}`));
    });

    it('writes the other record before it forgets the first, so a Hub that stops between them loses nothing', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED]);

      await uninstall(FIRST);

      const handed = disk.calls.indexOf(`write ${listPath(SECOND)}`);
      expect(handed).toBeGreaterThanOrEqual(0);
      expect(handed).toBeLessThan(disk.calls.indexOf(`remove ${listPath(FIRST)}`));
    });

    it('never fails the uninstall when the first record cannot be forgotten', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      install(SECOND, [PIN]);
      await record(FIRST, [SHARED]);
      vi.spyOn(files, 'deletePulledImages').mockRejectedValue(new Error('disk went away'));

      await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
    });

    it("keeps every image and hands none over when another app's compose cannot be read", async () => {
      engine.add(SHARED, [TAG]);
      engine.add(OTHER, ['own:1']);
      install(FIRST, [TAG, 'own:1']);
      install(SECOND, [TAG]);
      install(THIRD, ['anything:1']);
      composeOf.set(THIRD, null);
      await record(FIRST, [SHARED, OTHER], [TAG, 'own:1']);

      await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

      expect(engine.has(SHARED)).toBe(true);
      expect(engine.has(OTHER)).toBe(true);
      expect(hasRecord(SECOND)).toBe(false);
    });
  });

  describe('with two uninstalls at once', () => {
    const held = () => {
      let release: () => void = () => undefined;
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { until, release };
    };

    it('goes when the app holding it finishes first, as the other reads its record after compose down', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      await record(FIRST, [SHARED]);
      const second = held();
      beforeDown.set(SECOND, () => second.until);

      const secondDone = uninstall(SECOND);
      await uninstall(FIRST);
      second.release();
      await secondDone;

      expect(engine.has(SHARED)).toBe(false);
    });

    it('goes when the other app finishes first, as the check on other apps runs after compose down', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      await record(FIRST, [SHARED]);
      const first = held();
      beforeDown.set(FIRST, () => first.until);

      const firstDone = uninstall(FIRST);
      await uninstall(SECOND);
      first.release();
      await firstDone;

      expect(engine.has(SHARED)).toBe(false);
    });

    // Too little is the safe way to lose this race: each saw the other still installed.
    it('stays when each sees the other still installed and neither uninstall fails', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      await record(FIRST, [SHARED]);

      const results = await Promise.all([uninstall(FIRST), uninstall(SECOND)]);

      expect(results.map((result) => result.success)).toEqual([true, true]);
      expect(engine.has(SHARED)).toBe(true);
    });

    it('goes to the app that is staying rather than one on its way out', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      install(THIRD, [PIN]);
      await record(FIRST, [SHARED]);

      await Promise.all([uninstall(FIRST), uninstall(SECOND)]);

      expect(engine.has(SHARED)).toBe(true);
      await expect(recordOf(THIRD)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });

      await uninstall(THIRD);
      expect(engine.has(SHARED)).toBe(false);
    });

    it('goes to the app that is staying when the one on its way out names it another way', async () => {
      engine.add(SHARED, [TAG], [DIGEST_NAME]);
      install(FIRST, [TAG], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      install(THIRD, [TAG]);
      await record(FIRST, [SHARED], [TAG]);

      await uninstall(FIRST);

      await expect(recordOf(THIRD)).resolves.toEqual({ imageIds: [SHARED], imageTags: [TAG] });
      expect(hasRecord(SECOND)).toBe(false);
    });

    it('loses neither image when two apps hand one over to the same app at once', async () => {
      engine.add(SHARED, ['one:1']);
      engine.add(OTHER, ['two:1']);
      install(FIRST, ['one:1']);
      install(SECOND, ['two:1']);
      install(THIRD, ['one:1', 'two:1']);
      await record(FIRST, [SHARED], ['one:1']);
      await record(SECOND, [OTHER], ['two:1']);

      await Promise.all([uninstall(FIRST), uninstall(SECOND)]);

      const { imageIds, imageTags } = await recordOf(THIRD);
      expect(imageIds.toSorted()).toEqual([SHARED, OTHER]);
      expect(imageTags.toSorted()).toEqual(['one:1', 'two:1']);
    });

    // An unreadable compose keeps every image, even when that app is on its way out: its uninstall can still fail.
    it('stays when the other app has already deleted its folder and is still deleting its data', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN], 'uninstalling');
      install(SECOND, [PIN], 'uninstalling');
      composeOf.set(SECOND, null);
      await record(FIRST, [SHARED]);

      await expect(uninstall(FIRST)).resolves.toMatchObject({ success: true });

      expect(engine.has(SHARED)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('leaves its images in place'));
    });

    it('sees an app installed while compose down ran', async () => {
      engine.add(SHARED, [], [DIGEST_NAME]);
      install(FIRST, [PIN]);
      await record(FIRST, [SHARED]);
      beforeDown.set(FIRST, () => install(SECOND, [PIN]));

      await uninstall(FIRST);

      expect(engine.has(SHARED)).toBe(true);
      await expect(recordOf(SECOND)).resolves.toEqual({ imageIds: [SHARED], imageTags: [] });
    });
  });

  describe('with a factory reset', () => {
    const tearDown = () => {
      const database = {
        query: { app: { findMany: async () => [...rows] } },
        // Apps go one at a time in name order, each row once its uninstall succeeds.
        delete: () => ({
          where: async () => {
            rows = rows.slice(1);
          },
        }),
      };
      const reset = new FactoryResetService(database as never, mock(), moduleRef, mock(), mock(), mock(), mock(), logger, mock());
      return reset.tearDownApps();
    };

    it('goes, along the apps in name order, whichever of them recorded it', async () => {
      engine.add(SHARED, [TAG]);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);
      install(THIRD, [TAG]);
      await record(SECOND, [SHARED], [TAG]);

      await tearDown();

      expect(rows).toEqual([]);
      expect(engine.has(SHARED)).toBe(false);
      expect([...disk.files.keys()]).toEqual([]);
    });

    it('keeps an image with a tag someone pulled by hand', async () => {
      engine.add(SHARED, [TAG, 'mine:prod']);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);
      await record(FIRST, [SHARED], [TAG]);

      await tearDown();

      expect(engine.has(SHARED)).toBe(true);
    });

    it('keeps an image that was here before any app', async () => {
      engine.add(SHARED, [TAG]);
      install(FIRST, [TAG]);
      install(SECOND, [TAG]);

      await tearDown();

      expect(engine.has(SHARED)).toBe(true);
    });
  });
});
