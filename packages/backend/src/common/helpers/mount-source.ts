import path from 'node:path';

/**
 * One line of `/proc/self/mountinfo` (see proc(5)): `root` is the folder inside its filesystem that the
 * mount shows, and `mountPoint` is where it shows up in this process's view. `fsType`, `source`, and
 * `superOptions` describe that filesystem, which says where `root` is on the host.
 */
export type MountInfoEntry = { root: string; mountPoint: string; fsType: string; source: string; superOptions: string };

/** mountinfo writes a space, tab, newline or backslash in a path as an octal escape (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The mounts in a `/proc/self/mountinfo` text. A line that does not read as one is skipped. */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];

  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    // The optional fields end at a lone `-` somewhere after the mount point. The filesystem's type,
    // source, and options follow it.
    const separator = fields.indexOf('-', 6);

    if (fields.length < 10 || separator === -1) {
      continue;
    }

    entries.push({
      root: unescapeMountField(fields[3] ?? ''),
      mountPoint: unescapeMountField(fields[4] ?? ''),
      fsType: fields[separator + 1] ?? '',
      source: unescapeMountField(fields[separator + 2] ?? ''),
      superOptions: fields[separator + 3] ?? '',
    });
  }

  return entries;
}

/**
 * The folder the mount at `mountPoint` comes from, when its name is clearly none of `names`.
 *
 * The compose files mount `<ROOT_FOLDER_HOST>/backups` at `/data/backups`, and so on. When that host
 * folder is a symlink, or a junction on Windows, Docker follows it and mounts the target, and the
 * mount's root names the target. A target with another name is a folder outside the Hub's data
 * folder, such as a library on another drive.
 *
 * Undefined whenever that can't be told for sure, so the caller carries on as it would without
 * asking: no mount at `mountPoint` (the folder is part of a bigger mount, as in the dev and e2e
 * layouts, or the process is not in a container), the root of a whole filesystem, or a Docker or
 * Podman volume (`.../volumes/<name>/_data`). Names compare without letter case, since drvfs and
 * macOS file sharing ignore it. A link to a folder with the same name looks like the folder itself;
 * {@link mountedFromFolder} says where it is.
 */
export function linkedMountSource(entries: MountInfoEntry[], mountPoint: string, names: string[]): string | undefined {
  const root = mountAt(entries, mountPoint)?.root;

  if (root === undefined) {
    return undefined;
  }

  const segments = root.split(/[\\/]/).filter(Boolean);
  const last = segments.at(-1);

  if (!last || (last === '_data' && segments.at(-3) === 'volumes')) {
    return undefined;
  }

  return names.some((name) => name.toLowerCase() === last.toLowerCase()) ? undefined : root;
}

/**
 * Filesystems on a Linux disk. A mount root on one is a path inside that filesystem, which is the
 * host's own path only when the filesystem is the host's `/`.
 */
const LINUX_DISK_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs', 'jfs', 'reiserfs']);

/**
 * The folder on the host that holds the folder mounted at `mountPoint`, when that folder has one of
 * `names`, named as the host names it. (A folder with another name is a link, which
 * {@link linkedMountSource} reports.) The mount root is a path inside its filesystem, so that depends
 * on the filesystem:
 *
 * - A Windows drive, through drvfs (Docker Engine in WSL2 and Docker Desktop): the root is a path on
 *   the drive the mount names, so `/Users/ci` on `C:\` is `C:\Users\ci`, and `/home/hub` on `D:\` is
 *   `D:\home\hub`, which is no Linux home folder.
 * - Docker Desktop on macOS: with gRPC FUSE or osxfs the root is the Mac's own path. With VirtioFS it
 *   is a path in the folder the source shares, so `/ci` from `/run/host_mark/Users` is `/Users/ci`.
 * - A Linux disk: the root is the host's path when the disk is the host's `/`, and lacks the disk's
 *   mount point otherwise. With `/home` on its own partition `/home/ci` reads `/ci`, and from a disk
 *   mounted at `/data`, `/data/home/hub` reads `/home/hub`. So a folder that `rootFolderHost` ends in,
 *   the top of a disk included, is taken to be `rootFolderHost`, and any other is the path it reads.
 *
 * Undefined with no such mount, and on any other filesystem (a network share, a virtual machine's
 * shared folder), whose place on the host can't be told.
 */
export function mountedFromFolder(entries: MountInfoEntry[], mountPoint: string, names: string[], rootFolderHost: string): string | undefined {
  const mount = sameNameMount(entries, mountPoint, names);

  return mount && hostFolder(mount.entry, mount.parent, rootFolderHost);
}

/**
 * The folder that holds every one of `mounts` that comes from a folder with its own name, by
 * {@link mountedFromFolder}. With `ROOT_FOLDER_HOST` a link, Docker follows it, so this names the
 * folder it points to.
 *
 * Undefined when none of them has a mount of its own, when the place of one on the host can't be
 * told, or when they sit in different folders, as they do when one of them is a link to a folder of
 * the same name somewhere else.
 */
export function mountedDataRoot(
  entries: MountInfoEntry[],
  mounts: Array<{ mountPoint: string; names: string[] }>,
  rootFolderHost: string,
): string | undefined {
  const folders = mounts.flatMap(({ mountPoint, names }) => {
    const mount = sameNameMount(entries, mountPoint, names);

    return mount ? [hostFolder(mount.entry, mount.parent, rootFolderHost)] : [];
  });
  const [first] = folders;

  return first !== undefined && folders.every((folder) => folder?.toLowerCase() === first.toLowerCase()) ? first : undefined;
}

/** The mount at `mountPoint`, or undefined when nothing is mounted there. */
function mountAt(entries: MountInfoEntry[], mountPoint: string): MountInfoEntry | undefined {
  let mount: MountInfoEntry | undefined;

  // The last one wins: a later mount on the same point hides the earlier ones.
  for (const entry of entries) {
    if (entry.mountPoint === mountPoint) {
      mount = entry;
    }
  }

  // A source folder deleted after it was mounted reads `<path>//deleted`.
  return mount && { ...mount, root: mount.root.replace(/\/\/deleted$/, '') };
}

/**
 * The mount at `mountPoint` and the folders above the one it shows, when that one has one of `names`.
 * Never a Docker or Podman volume, whose folder is `_data`.
 */
function sameNameMount(entries: MountInfoEntry[], mountPoint: string, names: string[]): { entry: MountInfoEntry; parent: string[] } | undefined {
  const entry = mountAt(entries, mountPoint);
  const segments = entry?.root.split(/[\\/]/).filter(Boolean) ?? [];
  const last = segments.at(-1);

  return entry && last && names.some((name) => name.toLowerCase() === last.toLowerCase()) ? { entry, parent: segments.slice(0, -1) } : undefined;
}

/** The folders `parent` inside the filesystem of `entry`, as the host names them. See {@link mountedFromFolder}. */
function hostFolder(entry: MountInfoEntry, parent: string[], rootFolderHost: string): string | undefined {
  const drive = windowsDrive(entry);

  if (drive) {
    return `${drive}:\\${parent.join('\\')}`;
  }

  const share = macShare(entry);

  if (share !== undefined) {
    return path.posix.join('/', share, ...parent);
  }

  if (LINUX_DISK_FILESYSTEMS.has(entry.fsType)) {
    return endsInFolders(rootFolderHost, parent) ? rootFolderHost : `/${parent.join('/')}`;
  }

  return undefined;
}

/**
 * The letter of the Windows drive a mount comes from. drvfs names it as its source (`C:\`) and in its
 * options (`path=C:\`); Docker Desktop's virtual machine mounts it at `/run/desktop/mnt/host/c`.
 */
function windowsDrive({ source, superOptions }: MountInfoEntry): string | undefined {
  const letter =
    /^([a-z]):(\\|\/|$)/i.exec(source)?.[1] ??
    /^\/run\/desktop\/mnt\/host\/([a-z])$/i.exec(source)?.[1] ??
    (/(^|[,;])aname=drvfs([,;]|$)/.test(superOptions) ? /(?:^|[,;])path=([a-z]):/i.exec(superOptions)?.[1] : undefined);

  return letter?.toUpperCase();
}

/**
 * The Mac folder a Docker Desktop for Mac mount shares its root from: the one VirtioFS names as
 * `/run/host_mark/<folder>`, or the Mac's `/` for gRPC FUSE and osxfs, whose roots are the Mac's paths.
 */
function macShare({ fsType, source }: MountInfoEntry): string | undefined {
  const shared = /^\/run\/host_mark(\/.+)$/.exec(source)?.[1];

  if (shared) {
    return shared;
  }

  return fsType === 'fuse.grpcfuse' || fsType === 'fuse.osxfs' || fsType === 'osxfs' ? '/' : undefined;
}

/** Whether the path `folder` ends in the folders `tail`, ignoring letter case. */
function endsInFolders(folder: string, tail: string[]): boolean {
  const segments = path.posix.normalize(folder.replace(/\\/g, '/')).split('/').filter(Boolean);
  const offset = segments.length - tail.length;

  return offset >= 0 && tail.every((name, index) => name.toLowerCase() === segments[offset + index]?.toLowerCase());
}
