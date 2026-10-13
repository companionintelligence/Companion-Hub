/**
 * One line of `/proc/self/mountinfo` (see proc(5)): `root` is the folder inside its filesystem that the
 * mount shows, and `mountPoint` is where it shows up in this process's view.
 */
export type MountInfoEntry = { root: string; mountPoint: string };

/** mountinfo writes a space, tab, newline or backslash in a path as an octal escape (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The mounts in a `/proc/self/mountinfo` text. A line that does not read as one is skipped. */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];

  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');

    // Ten fields at least, with the optional ones ending at a lone `-` somewhere after the mount point.
    if (fields.length < 10 || fields.indexOf('-', 6) === -1) {
      continue;
    }

    entries.push({ root: unescapeMountField(fields[3] ?? ''), mountPoint: unescapeMountField(fields[4] ?? '') });
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
 * macOS file sharing ignore it. A link to a folder with the same name looks like the folder itself.
 */
export function linkedMountSource(entries: MountInfoEntry[], mountPoint: string, names: string[]): string | undefined {
  let mount: MountInfoEntry | undefined;

  // The last one wins: a later mount on the same point hides the earlier ones.
  for (const entry of entries) {
    if (entry.mountPoint === mountPoint) {
      mount = entry;
    }
  }

  if (!mount) {
    return undefined;
  }

  // A source folder deleted after it was mounted reads `<path>//deleted`.
  const root = mount.root.replace(/\/\/deleted$/, '');
  const segments = root.split(/[\\/]/).filter(Boolean);
  const last = segments.at(-1);

  if (!last || (last === '_data' && segments.at(-3) === 'volumes')) {
    return undefined;
  }

  return names.some((name) => name.toLowerCase() === last.toLowerCase()) ? undefined : root;
}
