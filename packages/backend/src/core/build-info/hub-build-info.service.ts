import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { LoggerService } from '@/core/logger/logger.service';
import { hubContainerName } from '@/common/constants';
import { type HubBuildInfo, resolveHubBuildInfo, summarizeHubBuild } from './hub-build-info';

/**
 * The digest lookup is a convenience, not the answer. Everything that identifies the build is
 * already in the env stamp, so a slow or absent Docker socket must cost a caller nothing beyond
 * `imageDigest: null`.
 */
const DIGEST_LOOKUP_TIMEOUT_MS = 2_000;

/** `sha256:` followed by 64 hex. Anything else is not a digest and is discarded rather than echoed. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

/**
 * Where to look for this Hub's own container. Mirrors `selfContainerCandidates()` in
 * system-update.service.ts: the hostname is the container ID unless compose sets `hostname:`, and
 * the names cover the rest, legacy topology included.
 */
function selfContainerCandidates(): string[] {
  return [...new Set([os.hostname(), hubContainerName(), 'ci-hub', 'ci-os-hub'].filter(Boolean))];
}

/** Hub container probe — `/.dockerenv` plus Podman's containerenv, same test the self-updater uses. */
function inContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

/**
 * Serves the build identity behind `GET /api/hub/build`.
 *
 * The env stamp is read once: it cannot change without the process restarting, and re-reading it
 * per request would only invite a caller to mutate `process.env` and get a different answer.
 *
 * The digest is resolved lazily and then cached for the life of the process, for the same reason —
 * the running container's image cannot change underneath it. A failed lookup is cached as "tried
 * and failed", so a node with no Docker socket does not spawn a doomed `docker` on every request.
 */
@Injectable()
export class HubBuildInfoService {
  private readonly stamp: HubBuildInfo = resolveHubBuildInfo();
  private digest: Promise<string | null> | null = null;

  constructor(private readonly logger: LoggerService) {}

  /** The env stamp alone — synchronous, always available, used for the boot log line. */
  getBuildInfo(): HubBuildInfo {
    return this.stamp;
  }

  /** The stamp plus the running image's digest when Docker can be reached. */
  async getBuildInfoWithDigest(): Promise<HubBuildInfo> {
    const imageDigest = await this.resolveImageDigest();
    if (!imageDigest) return this.stamp;
    const merged = { ...this.stamp, imageDigest };
    return { ...merged, summary: summarizeHubBuild(merged) };
  }

  private resolveImageDigest(): Promise<string | null> {
    this.digest ??= this.readImageDigest().catch((error) => {
      // Never fatal: the endpoint's whole point is answering when other things are broken.
      this.logger.debug(`Could not read the running Hub image digest: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    return this.digest;
  }

  /**
   * The digest of the image this container runs, via `docker inspect`.
   *
   * `RepoDigests` is the registry's own name for the image, which is what an operator comparing a
   * node against GHCR needs — `Image` is the local config ID and matches nothing in a registry.
   * A locally built image has no RepoDigests at all, and null is the correct answer there.
   */
  private async readImageDigest(): Promise<string | null> {
    if (!inContainer()) return null;
    for (const candidate of selfContainerCandidates()) {
      const imageId = await this.dockerInspect(['inspect', '--type', 'container', '--format', '{{.Image}}', candidate]);
      if (!imageId) continue;
      const repoDigests = await this.dockerInspect(['image', 'inspect', '--format', '{{join .RepoDigests ","}}', imageId]);
      const digest = (repoDigests ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .flatMap((entry) => {
          const at = entry.lastIndexOf('@');
          return at >= 0 ? [entry.slice(at + 1)] : [];
        })
        .find((value) => DIGEST_PATTERN.test(value));
      return digest ?? null;
    }
    return null;
  }

  /** Bounded `docker` capture. Resolves null on any failure — a missing socket is an expected state. */
  private dockerInspect(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
      } catch {
        resolve(null);
        return;
      }
      const chunks: string[] = [];
      // `settle` rather than resolving inline: the timeout and the exit race each other, and a
      // second resolve would be silently ignored while the timer kept the event loop warm.
      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      };
      const timer = globalThis.setTimeout(() => {
        child.kill('SIGKILL');
        settle(null);
      }, DIGEST_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      child.on('error', () => settle(null));
      child.on('close', (code) => {
        const output = chunks.join('').trim();
        settle(code === 0 && output && output !== '<no value>' ? output : null);
      });
    });
  }
}
