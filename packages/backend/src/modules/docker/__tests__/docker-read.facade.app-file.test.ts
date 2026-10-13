import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { DockerReadFacade } from '../docker-read.facade';

const OPENCLAW = 'ci-openclaw:ci-marketplace' as AppUrn;
const CONFIG = '/data/.openclaw/openclaw.json';

/** One tar entry as Docker's archive API writes it: a ustar header block, then the data padded to 512 bytes. */
function tarEntry(name: string, type: string, body = ''): Buffer {
  const data = Buffer.from(body, 'utf-8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf-8');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** A PAX extended header, which Docker writes before an entry whose metadata ustar can't hold (an xattr, a long name). */
function paxHeader(key: string, value: string): Buffer {
  const record = ` ${key}=${value}\n`;
  let length = record.length + 1;
  while (`${length}${record}`.length !== length) length += 1;
  return tarEntry('PaxHeaders.0/openclaw.json', 'x', `${length}${record}`);
}

const archive = (...entries: Buffer[]) => Readable.from([Buffer.concat([...entries, Buffer.alloc(1024)])]);

describe('DockerReadFacade.readRunningAppFile', () => {
  let listContainers: ReturnType<typeof vi.fn>;
  let getArchive: ReturnType<typeof vi.fn>;
  let getContainer: ReturnType<typeof vi.fn>;
  let facade: DockerReadFacade;

  const container = (mounts: Array<{ Type: string; Destination: string; Source?: string; Name?: string }>) => ({
    Id: 'c0ffee00c0ffee',
    Labels: { 'ci-hub.managed': 'true', 'ci-hub.appurn': OPENCLAW },
    Mounts: mounts,
  });

  beforeEach(() => {
    listContainers = vi.fn();
    getArchive = vi.fn();
    getContainer = vi.fn(() => ({ getArchive }));
    facade = new DockerReadFacade({ warn: vi.fn(), debug: vi.fn() } as never, { listContainers, getContainer } as never);
  });

  it.each([
    [
      'a named volume (an app-data folder that cannot hold POSIX permissions, as on Windows)',
      { Type: 'volume', Name: 'ci-openclaw_ci-marketplace_data', Destination: '/data' },
    ],
    ['a bind mount of the app-data folder (Linux, macOS)', { Type: 'bind', Source: '/srv/ci-hub/app-data/ci-openclaw/data', Destination: '/data' }],
  ])('reads the file out of the running container when /data is %s', async (_, mount) => {
    listContainers.mockResolvedValue([container([mount])]);
    getArchive.mockResolvedValue(archive(tarEntry('openclaw.json', '0', '{"agents":{}}')));

    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).resolves.toBe('{"agents":{}}');

    expect(getContainer).toHaveBeenCalledWith('c0ffee00c0ffee');
    expect(getArchive).toHaveBeenCalledWith(expect.objectContaining({ path: CONFIG }));
    for (const [options] of listContainers.mock.calls) {
      expect(options).toMatchObject({ all: false });
    }
  });

  it('skips the PAX header Docker can write before the file', async () => {
    listContainers.mockResolvedValue([container([{ Type: 'volume', Destination: '/data' }])]);
    getArchive.mockResolvedValue(
      archive(paxHeader('SCHILY.xattr.security.selinux', 'system_u:object_r:container_file_t:s0'), tarEntry('openclaw.json', '0', '{"a":1}')),
    );

    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).resolves.toBe('{"a":1}');
  });

  it('returns null without asking for the file when no running container of the app mounts the folder', async () => {
    listContainers.mockResolvedValue([]);
    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).resolves.toBeNull();

    listContainers.mockResolvedValue([container([{ Type: 'volume', Destination: '/home/linuxbrew' }])]);
    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).resolves.toBeNull();

    expect(getArchive).not.toHaveBeenCalled();
  });

  it('returns null when the file is not in the container yet', async () => {
    listContainers.mockResolvedValue([container([{ Type: 'volume', Destination: '/data' }])]);
    getArchive.mockRejectedValue(
      Object.assign(new Error(`(HTTP code 404) no such container - Could not find the file ${CONFIG} in container c0ffee00c0ffee`), {
        statusCode: 404,
      }),
    );

    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).resolves.toBeNull();
  });

  it('throws when Docker fails or sends back something other than one file', async () => {
    listContainers.mockResolvedValue([container([{ Type: 'volume', Destination: '/data' }])]);

    getArchive.mockRejectedValueOnce(Object.assign(new Error('(HTTP code 500) server error - mount failed'), { statusCode: 500 }));
    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).rejects.toThrow('server error');

    getArchive.mockResolvedValueOnce(archive(tarEntry('openclaw.json', '2')));
    await expect(facade.readRunningAppFile(OPENCLAW, '/data', CONFIG)).rejects.toThrow('no regular file');
  });
});
