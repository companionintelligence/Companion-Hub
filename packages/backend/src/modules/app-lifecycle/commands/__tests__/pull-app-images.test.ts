import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { pullAppImagesRecorded } from '../pull-app-images';

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
});
