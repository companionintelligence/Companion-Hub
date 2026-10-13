import { describe, expect, it } from 'vitest';
import { linkedMountSource, mountedDataRoot, parseMountInfo } from '../mount-source';

/**
 * `/proc/self/mountinfo` lines from a Hub container, one shape per engine. The WSL engine lines and
 * the volume line were read in a container on Docker Engine in WSL2, with `<P>` standing for a
 * folder under the user's profile; the others are written the way those engines lay them out.
 */
const P = '/Users/ci/AppData/Roaming/companion-hub';
const DRVFS = '9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=5,access=client,msize=65536,trans=fd,rfd=6,wfd=6';

const container = (...lines: string[]) =>
  [
    '836 506 0:104 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
    '838 836 0:123 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
    ...lines,
    '880 838 0:123 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw',
  ].join('\n');

const folders = ['app-data', 'apps', 'repos', 'backups', 'user-config'] as const;
const mountPointOf = (name: (typeof folders)[number]) => (name === 'app-data' ? '/app-data' : `/data/${name}`);

/** Each folder the reset empties, mounted from `<root>/<name>` the way the compose files mount it. */
const install = (root: string, rest: string) =>
  container(...folders.map((name, index) => `${861 + index} 836 0:69 ${root}/${name} ${mountPointOf(name)} rw,noatime - ${rest}`));

const linkedFolders = (text: string) =>
  folders.flatMap((name) => {
    const source = linkedMountSource(parseMountInfo(text), mountPointOf(name), [name]);
    return source ? [`${name} <- ${source}`] : [];
  });

describe('parseMountInfo', () => {
  it('reads the root and the mount point of each line, undoing the octal escapes', () => {
    expect(
      parseMountInfo(
        '1187 1168 0:179 /ci/Library/Application\\040Support/companion-hub/backups /data/backups rw,relatime - fakeowner /run/host_mark/Users rw,fakeowner',
      ),
    ).toEqual([{ root: '/ci/Library/Application Support/companion-hub/backups', mountPoint: '/data/backups' }]);
  });

  it('keeps optional fields out of the paths and skips lines that are not mounts', () => {
    expect(
      parseMountInfo(
        [
          '845 836 8:48 /var/lib/docker/volumes/c486/_data /app-data rw,relatime master:224 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered',
          '',
          'not a mountinfo line',
        ].join('\n'),
      ),
    ).toEqual([{ root: '/var/lib/docker/volumes/c486/_data', mountPoint: '/app-data' }]);
  });
});

describe('linkedMountSource', () => {
  describe('a normal install is never read as a link', () => {
    it.each([
      ['Docker Engine in WSL2, folders on C: through drvfs', install(P, DRVFS)],
      ['Linux, the data folder on the root filesystem', install('/home/ci/.local/share/companion-hub', 'ext4 /dev/nvme0n1p2 rw,errors=remount-ro')],
      ['Linux, /home on its own partition', install('/ci/.local/share/companion-hub', 'ext4 /dev/nvme0n1p3 rw')],
      ['Linux, btrfs with a home subvolume', install('/home/ci/.local/share/companion-hub', 'btrfs /dev/nvme0n1p3 rw,ssd,subvolid=256,subvol=/home')],
      ['Linux, the whole data folder moved to another disk through a link', install('/srv/hub-data', 'ext4 /dev/sdb1 rw')],
      [
        'Docker Desktop on Windows',
        install(
          P,
          '9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\;uid=0;gid=0;metadata;symlinkroot=/mnt/host/,mmap,access=client,msize=262144,trans=virtio',
        ),
      ],
      [
        'Docker Desktop on macOS, VirtioFS',
        install('/ci/Library/Application\\040Support/companion-hub', 'fakeowner /run/host_mark/Users rw,fakeowner'),
      ],
      [
        'Docker Desktop on macOS, gRPC FUSE',
        install(
          '/Users/ci/Library/Application\\040Support/companion-hub',
          'fuse.grpcfuse grpcfuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,allow_other,max_read=1048576',
        ),
      ],
      ['the dev compose file, folders under the checkout', install('/home/dev/CI-Hub/.internal', 'ext4 /dev/sda1 rw')],
      [
        'a Windows path whose letter case differs',
        install('/Users/ci/AppData/Roaming/Companion-Hub', DRVFS).replace('Companion-Hub/backups ', 'Companion-Hub/Backups '),
      ],
    ])('%s', (_shape, text) => {
      expect(linkedFolders(text)).toEqual([]);
    });

    it('a Docker volume, as the older installs mount /app-data and the smoke test mounts /data', () => {
      const text = container(
        '845 836 8:48 /var/lib/docker/volumes/c486d92d1df3c33e98a9ba584d83b2c9b97854ea3208eefd636cd134bd3e81d7/_data /app-data rw,relatime master:224 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered',
        '846 836 0:51 /ci/.local/share/containers/storage/volumes/hub_data/_data /data/backups rw,relatime - ext4 /dev/sda3 rw',
      );

      expect(linkedFolders(text)).toEqual([]);
    });

    it('no mount of its own, as when one volume holds all of /data or the backend runs outside a container', () => {
      expect(linkedFolders(container('845 836 8:48 /var/lib/docker/volumes/hub_data/_data /data rw,relatime - ext4 /dev/sdd rw'))).toEqual([]);
      expect(linkedFolders('')).toEqual([]);
    });

    it('the root of a whole filesystem, whose name cannot be told', () => {
      expect(linkedFolders(container('861 836 0:88 / /data/backups rw,relatime - nfs4 nas:/volume1/hub rw,vers=4.1'))).toEqual([]);
    });

    it('a source folder deleted after it was mounted', () => {
      expect(linkedFolders(container(`861 836 0:69 ${P}/backups//deleted /data/backups rw,noatime - ${DRVFS}`))).toEqual([]);
    });
  });

  describe('a folder that is a link to one with another name', () => {
    it('a Windows junction, which Docker in WSL2 follows to its target (as read in a container)', () => {
      const text = install(P, DRVFS).replace(`${P}/repos /data/repos`, '/Users/ci/Videos/library /data/repos');

      expect(linkedFolders(text)).toEqual(['repos <- /Users/ci/Videos/library']);
    });

    it('a symlink on Linux to a share mounted elsewhere', () => {
      const text = install('/home/ci/.local/share/companion-hub', 'ext4 /dev/nvme0n1p2 rw').replace(
        '/home/ci/.local/share/companion-hub/backups /data/backups',
        '/mnt/nas/Hub\\040Archive /data/backups',
      );

      expect(linkedFolders(text)).toEqual(['backups <- /mnt/nas/Hub Archive']);
    });

    it('the last mount on a point is the one that counts', () => {
      const linked = `870 836 0:69 /Users/ci/Videos/library /data/repos rw,noatime - ${DRVFS}`;
      const own = `871 836 0:69 ${P}/repos /data/repos rw,noatime - ${DRVFS}`;

      expect(linkedFolders(container(own, linked))).toEqual(['repos <- /Users/ci/Videos/library']);
      expect(linkedFolders(container(linked, own))).toEqual([]);
    });
  });
});

describe('mountedDataRoot', () => {
  const dataRoot = (text: string) =>
    mountedDataRoot(
      parseMountInfo(text),
      folders.map((name) => ({ mountPoint: mountPointOf(name), names: [name] })),
    );

  it.each([
    ['Docker Engine in WSL2', install(P, DRVFS), P],
    [
      'Linux, the data folder on the root filesystem',
      install('/home/ci/.local/share/companion-hub', 'ext4 /dev/sda1 rw'),
      '/home/ci/.local/share/companion-hub',
    ],
    ['Linux, /home on its own partition', install('/ci/.local/share/companion-hub', 'ext4 /dev/sda3 rw'), '/ci/.local/share/companion-hub'],
    ['a home folder, or a link to one', install('/home/ci', 'ext4 /dev/sda1 rw'), '/home/ci'],
    ['a Windows home folder, through drvfs', install('/Users/ci', DRVFS), '/Users/ci'],
    ['a data disk with the folders at its top', install('', 'ext4 /dev/sdb1 rw'), '/'],
  ])('%s', (_shape, text, root) => {
    expect(dataRoot(text)).toBe(root);
  });

  it('leaves out a folder that is a link to one with another name', () => {
    const text = install(P, DRVFS).replace(`${P}/repos /data/repos`, '/Users/ci/Videos/library /data/repos');

    expect(dataRoot(text)).toBe(P);
  });

  it('gives no answer when a folder is a link to one of the same name somewhere else', () => {
    const text = install(P, DRVFS).replace(`${P}/repos /data/repos`, '/Users/ci/repos /data/repos');

    expect(dataRoot(text)).toBeUndefined();
  });

  it('gives no answer with no mounts of their own, or only volumes', () => {
    expect(dataRoot('')).toBeUndefined();
    expect(dataRoot(container('845 836 8:48 /var/lib/docker/volumes/hub_data/_data /data rw,relatime - ext4 /dev/sdd rw'))).toBeUndefined();
    expect(
      dataRoot(container('845 836 8:48 /var/lib/docker/volumes/c486/_data /app-data rw,relatime master:224 - ext4 /dev/sdd rw')),
    ).toBeUndefined();
  });
});
