/**
 * Does the Hub env file still name the image the Hub is actually running?
 *
 * Measured on the fleet, 2026-09-21: the `:dev` tag moved at 20:49Z, and by 20:59Z fifteen of
 * seventeen appliances had recreated `ci-hub` onto the new digest `sha256:35de8a86…`. Every one of
 * them still pinned an older digest in its env file — `sha256:8add981a…`, or `sha256:73d4919f…` on
 * core-1 — and both env files were last modified the previous day. Nothing wrote back.
 *
 * That is not cosmetic. Compose reads the env file on every `up`, so the next restart of any of
 * those nodes deploys the OLD digest: the fleet silently reverts to a build it was moved off,
 * whenever each node happens to reboot. The env file is the only durable record of what a node is
 * supposed to run, and it was lying.
 *
 * Two halves, both here:
 *
 * - {@link decideImagePinWrite} — after a redeploy that came up healthy, persist the reference that
 *   was deployed, so a restart reproduces it. `cihub pool update` accepts the image as an
 *   environment variable (`CI_HUB_IMAGE=<ref> cihub pool update`, the shape a fleet roll uses) and
 *   passed it only to the `docker` child processes; the file was never touched.
 * - {@link compareDeclaredToRunning} — report the gap wherever it already exists, whatever opened
 *   it, because a node in that state looks completely healthy from every other angle.
 *
 * Deliberately NOT here: rewriting a node's channel. Persisting the reference that was deployed
 * keeps a `:dev` node on `:dev` and a digest-pinned node on its digest. Which release line a node
 * follows is the operator's edit — see `channelUpdateRefusal` in the backend's hub-deployment.ts,
 * which refuses to move a node off a digest or a floating tag for exactly the same reason.
 */
import { existsSync } from 'node:fs';
import { parseEnvFile } from '../env-file.js';
import type { ComposeIdentity } from './compose-discovery.js';

export const HUB_IMAGE_VAR = 'CI_HUB_IMAGE';

/**
 * The env file compose ACTUALLY read, which is not always the one this CLI would have picked.
 *
 * `com.docker.compose.project.environment_file` records it. On the fleet it is
 * `~/.local/share/companion-hub/.env.dev` while the CLI's own notion of an appliance env file is
 * `.env` in the same directory — so a write aimed at `.env` lands in a file compose never opens,
 * and a read from `.env` reports a pin that is not in force. Both files existing with different
 * contents is the trap; naming the file in the output is how an operator sees it.
 */
export function resolveComposeEnvFile(identity: ComposeIdentity | null, fallback: string): { path: string; fromCompose: boolean } {
  const declared = identity?.envFiles?.[0]?.trim();
  return declared ? { path: declared, fromCompose: true } : { path: fallback, fromCompose: false };
}

/** `CI_HUB_IMAGE` as that file declares it, or undefined when the file has none (or does not exist). */
export function readDeclaredHubImage(envFilePath: string): string | undefined {
  const value = parseEnvFile(envFilePath)[HUB_IMAGE_VAR]?.trim();
  return value || undefined;
}

export type PinDrift =
  | { kind: 'agrees'; image: string }
  /** The file names no image, so there is no pin to contradict — a source checkout, or a fresh install. */
  | { kind: 'no-declaration' }
  | { kind: 'not-running' }
  | { kind: 'drifted'; declared: string; running: string };

export function compareDeclaredToRunning(declared: string | undefined, runningReference: string | null): PinDrift {
  if (!runningReference) return { kind: 'not-running' };
  if (!declared) return { kind: 'no-declaration' };
  return declared.trim() === runningReference.trim()
    ? { kind: 'agrees', image: declared.trim() }
    : { kind: 'drifted', declared: declared.trim(), running: runningReference.trim() };
}

/** Enough of a reference to tell two digests apart on one line. */
export function shortImageRef(reference: string): string {
  const at = reference.indexOf('@');
  if (at < 0) return reference;
  return `${reference.slice(0, at)}@${reference.slice(at + 1, at + 1 + 19)}…`;
}

export interface PinReport {
  severity: 'ok' | 'warn' | 'fail';
  headline: string;
  lines: string[];
}

/**
 * The drift as an operator reads it.
 *
 * A drift is a failure, not a note: unlike a version skew, which costs you a missing command, this
 * one silently undoes itself. The node is running one build and configured to start another, and
 * nothing but a restart stands between those two states.
 */
export function describePinDrift(drift: PinDrift, envFilePath: string, fromCompose: boolean): PinReport {
  const where = `${envFilePath}${fromCompose ? '' : ' (this CLI’s guess — the running stack records no env file)'}`;
  switch (drift.kind) {
    case 'not-running':
      return { severity: 'ok', headline: 'no Hub container running, so there is no image to compare the pin against', lines: [] };
    case 'no-declaration':
      return { severity: 'ok', headline: `no ${HUB_IMAGE_VAR} in ${envFilePath} — nothing pinned to contradict`, lines: [] };
    case 'agrees':
      return { severity: 'ok', headline: `${HUB_IMAGE_VAR} matches the running image`, lines: [] };
    case 'drifted':
      return {
        severity: 'fail',
        headline: `${HUB_IMAGE_VAR} names ${shortImageRef(drift.declared)}, but this Hub runs ${shortImageRef(drift.running)}`,
        lines: [
          `Declared in ${where}.`,
          'Compose reads that file on every start, so the next restart of this node deploys the declared image and undoes whatever moved it.',
          `Fix by recording what is running: CI_HUB_IMAGE=${drift.running} cihub pool update`,
        ],
      };
  }
}

export type PinWriteDecision =
  | { action: 'write'; envFile: string; image: string; previous: string | undefined; reason: string }
  | { action: 'skip'; reason: string };

/**
 * Should this redeploy persist the image it just deployed?
 *
 * Health first, and not as a formality: writing the pin for a build that did not come up would
 * replace a working reference with a broken one and make the next restart fail too. The write only
 * ever happens for an image this node is demonstrably serving on.
 */
export function decideImagePinWrite(input: {
  envFile: string;
  envFileExists: boolean;
  declaredImage: string | undefined;
  deployedImage: string;
  healthy: boolean;
}): PinWriteDecision {
  if (!input.healthy) {
    return { action: 'skip', reason: 'the redeploy did not answer /api/health, so the previous pin is left naming a build that did' };
  }
  const image = input.deployedImage.trim();
  if (!image) return { action: 'skip', reason: 'this run deployed no named image' };
  if (/[\r\n]/.test(image)) {
    // The desktop app reads this file at launch and parses it as KEY=value lines.
    return { action: 'skip', reason: 'the deployed image reference contains a line break, which would corrupt the env file' };
  }
  if (!input.envFileExists) {
    return { action: 'skip', reason: `${input.envFile} does not exist, so there is no env file to record the image in` };
  }
  if (input.declaredImage?.trim() === image) {
    return { action: 'skip', reason: `${HUB_IMAGE_VAR} already names ${shortImageRef(image)}` };
  }
  return {
    action: 'write',
    envFile: input.envFile,
    image,
    previous: input.declaredImage,
    reason: input.declaredImage
      ? `${HUB_IMAGE_VAR} still named ${shortImageRef(input.declaredImage)}; a restart would have reverted this node to it`
      : `${HUB_IMAGE_VAR} was unset, so a restart would have fallen back to the compose default`,
  };
}

/** The whole read half in one call: which file, what it declares, and how that compares to the container. */
export function inspectImagePin(
  identity: ComposeIdentity | null,
  fallbackEnvFile: string,
  runningReference: string | null,
): { envFile: string; fromCompose: boolean; declared: string | undefined; drift: PinDrift; report: PinReport } {
  const { path: envFile, fromCompose } = resolveComposeEnvFile(identity, fallbackEnvFile);
  const declared = existsSync(envFile) ? readDeclaredHubImage(envFile) : undefined;
  const drift = compareDeclaredToRunning(declared, runningReference);
  return { envFile, fromCompose, declared, drift, report: describePinDrift(drift, envFile, fromCompose) };
}
