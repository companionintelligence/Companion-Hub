import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { hubContainerName } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { DOCKERODE } from './constants';
import { DockerReadFacade } from './docker-read.facade';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';

/** Where the helper container mounts the volume it copies. */
const VOLUME_MOUNT = '/volume';

/** One of an app's named volumes. */
export type AppVolume = {
  /** The Docker volume: `<app>_<store>_<key>`, unless the compose file names it otherwise. */
  name: string;
  /** Its key in the app's compose file. A backup stores the volume under this. */
  key: string;
};

/** Where a volume archived under `key` goes back, and whether the volume has to be created first. */
export type VolumeRestoreTarget = AppVolume & { create: boolean };

/**
 * Copies an app's named Docker volumes into a backup and back.
 *
 * Where the app-data folder cannot carry file ownership (a Windows-backed path), the Hub mounts the
 * volumes that need it as named volumes (see "App volumes" in docs/system/backend.md). That is most
 * apps' databases, and they are not in the folders a backup copies.
 *
 * The Hub process cannot read a volume itself, so each copy is busybox `tar` in a short-lived container
 * that streams the volume through the `docker` client's stdin or stdout. The container runs the image
 * this Hub runs from, which is on the engine for as long as the Hub is, so nothing is pulled. It runs as
 * root, so ownership and modes come back as they were, with no network and only the one volume mounted.
 */
@Injectable()
export class AppVolumeArchiveService {
  private ownImage?: string;

  constructor(
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly dockerRead: DockerReadFacade,
    private readonly logger: LoggerService,
  ) {}

  /** The volumes compose created for the app's project. */
  public async listAppVolumes(appUrn: AppUrn): Promise<AppVolume[]> {
    const project = this.dockerRead.getComposeProjectName(appUrn);
    const { Volumes } = await this.docker.listVolumes({ filters: { label: [`${COMPOSE_PROJECT_LABEL}=${project}`, COMPOSE_VOLUME_LABEL] } });

    return (Volumes ?? []).map((volume) => ({ name: volume.Name, key: volume.Labels?.[COMPOSE_VOLUME_LABEL] ?? volume.Name }));
  }

  /** Write the volume's contents to `file` as a tar archive. */
  public async exportVolume(volume: string, file: string): Promise<void> {
    await this.runHelper(volume, ['tar', '-c', '-f', '-', '-C', VOLUME_MOUNT, '.'], { readOnly: true, stdout: file });

    // The archive holds at least the volume's root folder, so an empty file means the stream never
    // arrived, and a backup without the volume must not be reported as one.
    if ((await fs.promises.stat(file)).size === 0) {
      throw new Error(`docker returned nothing for volume ${volume}`);
    }
  }

  /**
   * Where each volume archived under `keys` goes back: the app's own volume with that key, or a new
   * one named as compose names it. Throws, before a restore changes anything, when that name belongs to
   * a volume that is not this app's, or when there is no image to run the copy in.
   */
  public async restoreTargets(appUrn: AppUrn, keys: string[]): Promise<VolumeRestoreTarget[]> {
    const project = this.dockerRead.getComposeProjectName(appUrn);
    const own = await this.listAppVolumes(appUrn);
    const targets: VolumeRestoreTarget[] = [];

    for (const key of keys) {
      const existing = own.find((volume) => volume.key === key);

      if (existing) {
        targets.push({ ...existing, create: false });
        continue;
      }

      const name = `${project}_${key}`;

      if (await this.volumeExists(name)) {
        throw new Error(`Volume ${name} does not belong to ${appUrn}, so the backup was not restored into it`);
      }

      targets.push({ name, key, create: true });
    }

    await this.helperImage();
    return targets;
  }

  /** Replace the volume's contents with the tar archive in `file`. */
  public async importVolume(appUrn: AppUrn, target: VolumeRestoreTarget, file: string): Promise<void> {
    if (target.create) {
      // Labelled as compose labels its own volumes, so `up` takes it over and the next backup finds it.
      const project = this.dockerRead.getComposeProjectName(appUrn);
      await this.docker.createVolume({ Name: target.name, Labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_VOLUME_LABEL]: target.key } });
    }

    // Emptied first: files the backup does not have (newer redo logs, say) would sit beside the restored ones.
    await this.runHelper(target.name, ['find', VOLUME_MOUNT, '-mindepth', '1', '-delete']);
    await this.runHelper(target.name, ['tar', '--numeric-owner', '-x', '-f', '-', '-C', VOLUME_MOUNT], { stdin: file });
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        return false;
      }

      throw error;
    }
  }

  /**
   * The image this Hub's container runs, by ID. Looked up the way the self-updater finds its own
   * container: the hostname is the container ID unless compose sets one, and the names cover the rest.
   */
  private async helperImage(): Promise<string> {
    if (this.ownImage) {
      return this.ownImage;
    }

    for (const candidate of new Set([os.hostname(), hubContainerName(), 'ci-hub', 'ci-os-hub'])) {
      const image = await this.docker
        .getContainer(candidate)
        .inspect()
        .then((container) => container.Image)
        .catch(() => undefined);

      if (image) {
        this.ownImage = image;
        return image;
      }
    }

    throw new Error("Could not find the Hub's own container, so there is no image to copy the app's Docker volumes with");
  }

  /** Run `command` in a throwaway container of the Hub's image with `volume` mounted. */
  private async runHelper(
    volume: string,
    [entrypoint, ...args]: [entrypoint: string, ...args: string[]],
    io: { readOnly?: boolean; stdin?: string; stdout?: string } = {},
  ) {
    const image = await this.helperImage();
    const dockerArgs = [
      'run',
      '--rm',
      ...(io.stdin ? ['-i'] : []),
      '--network',
      'none',
      '--user',
      '0:0',
      '--pull',
      'never',
      // The tar stream goes to the client over the attach stream. A log driver would also write every
      // byte of it to the container's log file on the engine's disk.
      '--log-driver',
      'none',
      '-v',
      `${volume}:${VOLUME_MOUNT}${io.readOnly ? ':ro' : ''}`,
      '--entrypoint',
      entrypoint,
      image,
      ...args,
    ];

    this.logger.debug(`Running docker ${dockerArgs.join(' ')}`);
    await runDocker(dockerArgs, io);
  }
}

/**
 * `docker <args>` without a shell, with stdin read from one file and stdout written to another. Rejects
 * on a non-zero exit with what docker printed to stderr.
 */
async function runDocker(args: string[], io: { stdin?: string; stdout?: string }): Promise<void> {
  const input = io.stdin ? await fs.promises.open(io.stdin, 'r') : undefined;

  try {
    const output = io.stdout ? await fs.promises.open(io.stdout, 'w') : undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', args, { stdio: [input?.fd ?? 'ignore', output?.fd ?? 'ignore', 'pipe'] });
        let stderr = '';

        child.stderr?.on('data', (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-4096);
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`))));
      });
    } finally {
      await output?.close();
    }
  } finally {
    await input?.close();
  }
}
