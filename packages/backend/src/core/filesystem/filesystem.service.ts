import fs from 'node:fs';
import os, { EOL } from 'node:os';
import path from 'node:path';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { resolveContainerDataPath } from '@/common/helpers/container-paths';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

/** A path the check has approved. */
interface CheckedPath {
  /** The path as the caller wrote it, made absolute. */
  written: string;
  /** Where it really is: every link on the way followed, so nothing is left to redirect it. */
  real: string;
  /** Added to the open flags, so a link that appears at the last moment fails the open. */
  noFollow: number;
}

/**
 * One allowed folder, and how far a link inside it may lead.
 *
 * `areaDepth` says how many levels below `dir` make up one area, and a link has to stay inside the
 * area it starts in: one app's data, or one of the Hub's folders in its data folder. `null` means
 * links are not followed for the check at all, for folders no app or store can put a link in, where
 * the path as written is the answer.
 */
interface AllowedRoot {
  dir: string;
  areaDepth: number | null;
}

@Injectable()
export class FilesystemService {
  constructor(private readonly logger: LoggerService) {}

  private allowedRoots(): AllowedRoot[] {
    const roots: AllowedRoot[] = [
      // Each app's data is its own: `<APP_DATA_DIR>/<store>/<app>`.
      { dir: path.resolve(APP_DATA_DIR), areaDepth: 2 },
      // `apps`, `repos`, `state`, `backups` and the rest. One of those can itself be a link or a mount.
      { dir: path.resolve(DATA_DIR), areaDepth: 1 },
      { dir: path.resolve(os.tmpdir()), areaDepth: 0 },
      // The Hub's own install, including `assets` when a build links them in.
      { dir: path.resolve(APP_DIR), areaDepth: null },
    ];

    // /host/proc is Linux-only (Docker host /proc mount)
    if (process.platform !== 'win32') {
      roots.push({ dir: path.resolve('/host/proc/'), areaDepth: null });
      roots.push({ dir: path.resolve('/dev/kfd'), areaDepth: null });
      roots.push({ dir: path.resolve('/dev/dri'), areaDepth: null });
      // amdgpu publishes each card's real VRAM total under sysfs, readable from the Hub
      // container without device passthrough (HardwareInspectorService.detectAmdCardsFromSysfs).
      // Every entry here is a kernel link into /sys/devices, outside this folder by design.
      roots.push({ dir: path.resolve('/sys/class/drm'), areaDepth: null });
    }

    return roots;
  }

  /** `candidate` is `dir` or below it, by the text of the path alone. */
  private isSameOrInside(dir: string, candidate: string): boolean {
    const relative = path.relative(dir, candidate);

    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }

  /**
   * Where `target` really is, with every link on the way followed. What does not exist yet (a file or
   * folder about to be created) is kept as written, below the real location of its nearest parent that
   * does. A link whose target is gone is an error rather than a missing file, because creating a file
   * at that path would create it wherever the link points. A loop is an error too.
   */
  private async realLocation(target: string): Promise<string> {
    try {
      return await fs.promises.realpath(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }

      const isLink = await fs.promises.lstat(target).then(
        (stats) => stats.isSymbolicLink(),
        () => false,
      );
      const parent = path.dirname(target);

      if (isLink || parent === target) {
        throw error;
      }

      return path.join(await this.realLocation(parent), path.basename(target));
    }
  }

  /**
   * Decides whether `filePath` may be used and where it really is.
   *
   * The path as written has to be inside an allowed folder, and where it really is, after every link
   * on the way, has to stay inside the same area of that folder (see {@link AllowedRoot}). Both ends
   * are resolved, so a data folder that is itself a link or a mount (`/var` on macOS) still matches.
   * Any error while resolving refuses, with the original error so callers still see EACCES.
   *
   * `followLastLink: false` is for what acts on a directory entry itself (lstat, unlink, rm): only the
   * parent is resolved, so a link that leads out or nowhere can still be seen and removed.
   */
  private async checkPath(filePath: string, { followLastLink = true }: { followLastLink?: boolean } = {}): Promise<CheckedPath> {
    // Resolve container `/data/...` paths to DATA_DIR when running outside Docker.
    const written = resolveContainerDataPath(filePath);
    const root = this.allowedRoots()
      .filter(({ dir }) => this.isSameOrInside(dir, written))
      .sort((a, b) => b.dir.length - a.dir.length)[0];

    if (!root) {
      this.logger.error(`File path "${filePath}" is not allowed. Resolved: "${written}"`);
      throw new Error('File path is not allowed');
    }

    if (root.areaDepth === null) {
      return { written, real: written, noFollow: 0 };
    }

    const segments = path.relative(root.dir, written).split(path.sep).filter(Boolean);
    const area = segments.length >= root.areaDepth ? path.join(root.dir, ...segments.slice(0, root.areaDepth)) : root.dir;
    const real = followLastLink
      ? await this.realLocation(written)
      : path.join(await this.realLocation(path.dirname(written)), path.basename(written));

    // Acting on the entry at the top of an area means acting in the folder above it.
    if (followLastLink || written !== area) {
      const realArea = await this.realLocation(area);
      const location = followLastLink ? real : path.dirname(real);

      if (!this.isSameOrInside(realArea, location)) {
        this.logger.error(`File path "${filePath}" leads outside ${area}. Resolved: "${real}"`);
        throw new Error('File path is not allowed');
      }
    }

    return { written, real, noFollow: fs.constants.O_NOFOLLOW ?? 0 };
  }

  /** The real location of an allowed path. See {@link checkPath}. Throws when it is not allowed. */
  public async getSafeFilePath(filePath: string, options?: { followLastLink?: boolean }): Promise<string> {
    return (await this.checkPath(filePath, options)).real;
  }

  async readJsonFile<T extends object>(filePath: string, schema?: z.ZodType<T>): Promise<T | null> {
    try {
      const { real, noFollow } = await this.checkPath(filePath);
      const fileContent = await fs.promises.readFile(real, { encoding: 'utf8', flag: fs.constants.O_RDONLY | noFollow });
      const parsedContent = JSON.parse(fileContent);

      if (schema) {
        const validatedContent = schema.safeParse(parsedContent);
        if (!validatedContent.success) {
          this.logger.debug(`File ${filePath} validation error:`, validatedContent.error);
          return null;
        }
        return validatedContent.data;
      }

      return parsedContent;
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async readTextFile(filePath: string): Promise<string | null> {
    try {
      const { real, noFollow } = await this.checkPath(filePath);

      return await fs.promises.readFile(real, { encoding: 'utf8', flag: fs.constants.O_RDONLY | noFollow });
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async readBinaryFile(filePath: string): Promise<Buffer | null> {
    try {
      const { real, noFollow } = await this.checkPath(filePath);

      return await fs.promises.readFile(real, { flag: fs.constants.O_RDONLY | noFollow });
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async writeJsonFile<T>(filePath: string, data: T): Promise<boolean> {
    try {
      const { real, noFollow } = await this.checkPath(filePath);

      await fs.promises.writeFile(real, `${JSON.stringify(data, null, 2)}${EOL}`, { encoding: 'utf8', flag: this.writeFlags(noFollow) });
      return true;
    } catch (error) {
      this.logger.error(`Error writing file ${filePath}:`, error);
      return false;
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<boolean> {
    try {
      await fs.promises.mkdir(await this.getSafeFilePath(path.dirname(filePath)), { recursive: true });
      const { real, noFollow } = await this.checkPath(filePath);

      await fs.promises.writeFile(real, `${content}${EOL}`, { encoding: 'utf8', flag: this.writeFlags(noFollow) });
      return true;
    } catch (error) {
      this.logger.error(`Error writing file ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Creates `filePath` with `content` and `mode` (less the process umask), unless something already
   * exists at that path. The check and the write are one exclusive open, so a file another process
   * created first is never overwritten.
   */
  async createFileIfMissing(filePath: string, content: string, mode: number): Promise<'created' | 'exists' | 'failed'> {
    try {
      await fs.promises.mkdir(await this.getSafeFilePath(path.dirname(filePath)), { recursive: true });
    } catch (error) {
      // Never `exists`: mkdir says EEXIST when the parent is a file. Nothing is at filePath then.
      this.logger.error(`Error creating the directory for ${filePath}:`, error);
      return 'failed';
    }
    try {
      await fs.promises.writeFile(await this.getSafeFilePath(filePath), content, { flag: 'wx', mode });
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
        return 'exists';
      }
      this.logger.error(`Error creating file ${filePath}:`, error);
      return 'failed';
    }
  }

  async writeBinaryFile(filePath: string, data: Buffer): Promise<boolean> {
    try {
      await fs.promises.mkdir(await this.getSafeFilePath(path.dirname(filePath)), { recursive: true });
      const { real, noFollow } = await this.checkPath(filePath);

      await fs.promises.writeFile(real, data, { flag: this.writeFlags(noFollow) });
      return true;
    } catch (error) {
      this.logger.error(`Error writing binary file ${filePath}:`, error);
      return false;
    }
  }

  async pathExists(filePath: string): Promise<boolean> {
    return this.checkPath(filePath)
      .then(({ real }) => fs.promises.access(real))
      .then(() => true)
      .catch(() => false);
  }

  async copyFile(src: string, dest: string): Promise<boolean> {
    try {
      await fs.promises.copyFile(await this.getSafeFilePath(src), await this.getSafeFilePath(dest));
      return true;
    } catch (error) {
      this.logger.error(`Error copying file from ${src} to ${dest}:`, error);
      return false;
    }
  }

  private writeFlags(noFollow: number): number {
    return fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
  }

  /**
   * Leaves a file readable and writable by its owner alone (mode 0600), so no other account on the computer can read
   * it. Returns `false`, logged, when the mode cannot be set; the caller then must not keep the file.
   */
  async restrictToOwner(filePath: string): Promise<boolean> {
    try {
      await fs.promises.chmod(await this.getSafeFilePath(filePath), 0o600);
      return true;
    } catch (error) {
      this.logger.error(`Error restricting ${filePath} to its owner:`, error);
      return false;
    }
  }

  /** Marks a file executable (mode 0755). Returns `false`, logged, when the mode cannot be set. */
  async makeExecutable(filePath: string): Promise<boolean> {
    try {
      await fs.promises.chmod(await this.getSafeFilePath(filePath), 0o755);
      return true;
    } catch (error) {
      this.logger.error(`Error making ${filePath} executable:`, error);
      return false;
    }
  }

  async createDirectory(dirPath: string): Promise<boolean> {
    try {
      // Always validate the path for safety
      const { real } = await this.checkPath(dirPath);
      await fs.promises.mkdir(real, { recursive: true });
      return true;
    } catch (error) {
      this.logger.error(`Error creating directory ${dirPath}:`, error);
      return false;
    }
  }

  async createDirectories(dirPaths: string[]): Promise<boolean> {
    try {
      // Create directories in parallel for better performance
      const createPromises = dirPaths.map(async (dirPath, index) => {
        try {
          const { real } = await this.checkPath(dirPath);
          this.logger.debug(`Creating directory ${index + 1}/${dirPaths.length}: ${real}`);
          await fs.promises.mkdir(real, { recursive: true });
          this.logger.debug(`Successfully created directory: ${real}`);
          return true;
        } catch (error) {
          this.logger.error(`Failed to create directory ${dirPath}:`, error);
          return false;
        }
      });

      this.logger.debug(`Starting creation of ${dirPaths.length} directories in parallel`);
      const results = await Promise.all(createPromises);
      const successCount = results.filter((r) => r === true).length;
      this.logger.debug(`Created ${successCount}/${dirPaths.length} directories successfully`);
      return results.every((result) => result === true);
    } catch (error) {
      this.logger.error(`Error in createDirectories: ${error}`);
      return false;
    }
  }

  async copyDirectory(src: string, dest: string, options: fs.CopyOptions = {}): Promise<boolean> {
    const { copied, error } = await this.tryCopyDirectory(src, dest, options);
    if (!copied) this.logger.error(`Error copying directory from ${src} to ${dest}:`, error);
    return copied;
  }

  /**
   * Like {@link copyDirectory}, but tells the caller WHY a copy failed so it can escalate.
   * `permissionDenied` (EACCES/EPERM) is the signature of files a container created under another
   * user (every database image) that the Hub, a plain user on a native Linux host, cannot read.
   * Every caller hands that case to a root helper and reports how it went, so it is logged at debug
   * here: an error line for a copy that then succeeds as root is a red line for nothing.
   */
  async copyDirectoryDetailed(src: string, dest: string, options: fs.CopyOptions = {}): Promise<{ copied: boolean; permissionDenied: boolean }> {
    const { copied, permissionDenied, error } = await this.tryCopyDirectory(src, dest, options);
    if (!copied && permissionDenied) {
      this.logger.debug(`Could not copy ${src} to ${dest} as the Hub's user:`, error);
    } else if (!copied) {
      this.logger.error(`Error copying directory from ${src} to ${dest}:`, error);
    }
    return { copied, permissionDenied };
  }

  private async tryCopyDirectory(src: string, dest: string, options: fs.CopyOptions) {
    try {
      // As written, because a caller's `filter` compares against the folder it named. `cp` copies links as links.
      const [{ written: from }, { written: to }] = await Promise.all([this.checkPath(src), this.checkPath(dest)]);

      await fs.promises.cp(from, to, { recursive: true, ...options });
      return { copied: true, permissionDenied: false, error: undefined };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return { copied: false, permissionDenied: code === 'EACCES' || code === 'EPERM', error };
    }
  }

  /**
   * Looks for entries under `dirPath` that this process cannot read: a folder it cannot list, or a
   * file it cannot open. A copy made by the Hub stops at the first one, so a backup looks first: data
   * like that needs the root helper, and finding out the helper cannot run after the app was stopped
   * is downtime for nothing.
   *
   * Breadth first and bounded: a data folder can hold millions of files, and the ones this exists to
   * find (a database's own, a level or two down) come early. It reports at most `maxFound` paths and
   * looks at no more than `maxEntries` entries, so an empty answer means "none among the first
   * entries", not a proof that every file is readable. Symbolic links are not followed. An entry
   * `skip` accepts (one the caller's copy leaves out) is neither checked nor walked into.
   */
  async findUnreadable(
    dirPath: string,
    options: { maxEntries?: number; maxFound?: number; skip?: (entry: string) => boolean } = {},
  ): Promise<string[]> {
    const maxEntries = options.maxEntries ?? 2000;
    const maxFound = options.maxFound ?? 5;
    const found: string[] = [];
    const queue: string[] = [];
    let seen = 0;

    try {
      queue.push((await this.checkPath(dirPath)).written);
    } catch {
      return found;
    }

    while (queue.length > 0 && seen < maxEntries && found.length < maxFound) {
      const dir = queue.shift() as string;
      let names: string[];

      try {
        names = await fs.promises.readdir(dir);
      } catch (error) {
        // A folder that does not exist is nothing to copy; one that exists but cannot be listed is the case this looks for.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') found.push(dir);
        continue;
      }

      for (const name of names) {
        if (seen >= maxEntries || found.length >= maxFound) break;
        const full = path.join(dir, name);
        if (options.skip?.(full)) continue;
        seen++;

        try {
          const stat = await fs.promises.lstat(full);

          if (stat.isSymbolicLink()) continue;

          if (stat.isDirectory()) {
            queue.push(full);
          } else {
            await fs.promises.access(full, fs.constants.R_OK);
          }
        } catch {
          found.push(full);
        }
      }
    }

    return found;
  }

  /**
   * Looks for folders under `dirPath` whose entries this process could not delete: a folder it cannot
   * list, or one that holds something and that it cannot write into (a file is deleted through its
   * folder, not by its owner). What a container running as root writes into a folder of its own looks
   * like this to a Hub that runs as the host user. Bounded and breadth first like
   * {@link findUnreadable}, with the same caveat: an empty answer covers the first entries only.
   */
  async findUndeletable(dirPath: string, options: { maxEntries?: number; maxFound?: number } = {}): Promise<string[]> {
    const maxEntries = options.maxEntries ?? 2000;
    const maxFound = options.maxFound ?? 5;
    const found: string[] = [];
    const queue: string[] = [];
    let seen = 0;

    try {
      queue.push((await this.checkPath(dirPath)).written);
    } catch {
      return found;
    }

    while (queue.length > 0 && seen < maxEntries && found.length < maxFound) {
      const dir = queue.shift() as string;
      let names: string[];

      try {
        names = await fs.promises.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') found.push(dir);
        continue;
      }

      if (names.length > 0) {
        try {
          await fs.promises.access(dir, fs.constants.W_OK | fs.constants.X_OK);
        } catch {
          found.push(dir);
          continue;
        }
      }

      for (const name of names) {
        if (seen >= maxEntries || found.length >= maxFound) break;
        seen++;
        const full = path.join(dir, name);
        const stat = await fs.promises.lstat(full).catch(() => null);

        if (stat?.isDirectory()) queue.push(full);
      }
    }

    return found;
  }

  async removeDirectory(dirPath: string): Promise<boolean> {
    const { removed, error } = await this.tryRemoveDirectory(dirPath);
    if (!removed) this.logger.error(`Error removing directory ${dirPath}:`, error);
    return removed;
  }

  /**
   * Like {@link removeDirectory}, but tells the caller WHY a delete failed so it can
   * escalate. `permissionDenied` (EACCES/EPERM/EBUSY) is the signature of a path a
   * container created as root that the non-root Hub process cannot remove (e.g.
   * MinIO's `.minio.sys`); uninstall, reset, restore and the update rollback use it to
   * fall back to a privileged cleanup and report how that went, so this logs that case
   * at debug only. `force: true` means a missing dir is still a success (`removed: true`).
   */
  async removeDirectoryDetailed(dirPath: string): Promise<{ removed: boolean; permissionDenied: boolean }> {
    const { removed, permissionDenied, error } = await this.tryRemoveDirectory(dirPath);
    if (!removed && permissionDenied) {
      this.logger.debug(`Could not remove ${dirPath} as the Hub's user:`, error);
    } else if (!removed) {
      this.logger.error(`Error removing directory ${dirPath}:`, error);
    }
    return { removed, permissionDenied };
  }

  private async tryRemoveDirectory(dirPath: string) {
    try {
      await fs.promises.rm(await this.getSafeFilePath(dirPath, { followLastLink: false }), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return { removed: true, permissionDenied: false, error: undefined };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return { removed: false, permissionDenied: code === 'EACCES' || code === 'EPERM' || code === 'EBUSY', error };
    }
  }

  async removeFile(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(await this.getSafeFilePath(filePath, { followLastLink: false }));
      return true;
    } catch (error) {
      this.logger.error(`Error removing file ${filePath}:`, error);
      return false;
    }
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(await this.getSafeFilePath(dirPath));
    } catch (error) {
      this.logger.error(`Error listing files in ${dirPath}:`, error);
      return [];
    }
  }

  /**
   * True only for a real directory. `lstat`, so a symlink to a directory is NOT one, and a
   * missing path is `false` rather than a thrown ENOENT.
   */
  async isDirectory(dirPath: string): Promise<boolean> {
    try {
      return (await fs.promises.lstat(await this.getSafeFilePath(dirPath, { followLastLink: false }))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * True only for a regular file. `lstat`, so a symlink is never one, whatever it points at.
   *
   * ⚠ PREFER THIS TO `pathExists` WHENEVER THE NEXT STEP READS THE FILE. `pathExists` is
   * `access`, which follows links, so it answers "does the target exist" — and a link planted
   * inside a user-supplied archive points wherever its author likes.
   */
  async isFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.lstat(await this.getSafeFilePath(filePath, { followLastLink: false }))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Is `targetPath` a regular file (or directory) that really lives inside `rootDir`?
   *
   * ⚠ THIS ANSWERS A QUESTION `pathExists` AND `isFile` CANNOT. Both look only at the LAST
   * component of the path, so `metadata -> /data` followed by `metadata/logo.png` passes either:
   * the link is in the middle, and the file at the end is perfectly real. A cloned third-party
   * repo controls every link in its tree. This resolves all of them (`realpath`) and requires the
   * result to stay under the resolved root, so no link anywhere on the way can lead out.
   *
   * Narrower than `getSafeFilePath`, which keeps a path inside its whole area. This is for a caller
   * that has one folder in mind, such as the app folder of a cloned repo. Both are resolved, so a data
   * directory that is itself a link or a mount (`/var` on macOS) still matches.
   */
  async isWithin(targetPath: string, rootDir: string, kind: 'file' | 'directory' = 'file'): Promise<boolean> {
    try {
      const [{ real: checkedTarget }, { real: checkedRoot }] = await Promise.all([this.checkPath(targetPath), this.checkPath(rootDir)]);
      const [realTarget, realRoot] = await Promise.all([fs.promises.realpath(checkedTarget), fs.promises.realpath(checkedRoot)]);
      const relative = path.relative(realRoot, realTarget);

      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        return false;
      }

      const stats = await fs.promises.stat(realTarget);

      return kind === 'file' ? stats.isFile() : stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * `prefix` is a caller-chosen label (e.g. an app URN), not a path — `fs.mkdtemp`
   * resolves a non-absolute prefix against `process.cwd()`, which is unwritable in the
   * Hub's container, so this always roots it under the OS temp dir first.
   */
  async createTempDirectory(prefix: string): Promise<string | null> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async getStats(filePath: string) {
    return await fs.promises.stat(await this.getSafeFilePath(filePath));
  }

  /**
   * Stat a path WITHOUT following a symlink.
   *
   * ⚠ USE THIS WHEN THE ANSWER DECIDES WHETHER TO DESCEND OR TO REPORT. `stat`
   * follows links, so a walk built on it reports the TARGET's kind and walks where
   * the link leads. This one looks at the entry itself, and only its parent has to
   * resolve inside the allowed area.
   */
  async getLinkStats(filePath: string) {
    return await fs.promises.lstat(await this.getSafeFilePath(filePath, { followLastLink: false }));
  }

  /**
   * Open a read stream over an allowed path, optionally for a byte range.
   * Prefer this over `readBinaryFile` for anything large enough to matter (media, archives) so the
   * whole payload never has to sit in the appliance's heap.
   */
  public async createReadStream(filePath: string, options?: { start?: number; end?: number }): Promise<fs.ReadStream> {
    const { real, noFollow } = await this.checkPath(filePath);
    const handle = await fs.promises.open(real, fs.constants.O_RDONLY | noFollow);

    return handle.createReadStream(options);
  }

  async getFileEtag(filePath: string): Promise<string | null> {
    try {
      const stats = await this.getStats(filePath);
      return `"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
    } catch {
      return null;
    }
  }
}
