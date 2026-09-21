/**
 * The env file that does not name the image the Hub runs.
 *
 * Measured on the fleet, 2026-09-21: the `:dev` tag moved at 20:49Z and by 20:59Z fifteen of
 * seventeen appliances had recreated `ci-hub` onto `sha256:35de8a86…`, while every env file still
 * pinned `sha256:8add981a…` (`sha256:73d4919f…` on core-1) and had not been written since the day
 * before. Compose reads that file on every start, so each of those nodes was one reboot away from
 * reverting to the build it had just been moved off — and nothing said so.
 *
 * The digests below are the measured ones, so a regression reads as the incident it came from.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareDeclaredToRunning,
  decideImagePinWrite,
  describePinDrift,
  HUB_IMAGE_VAR,
  inspectImagePin,
  readDeclaredHubImage,
  resolveComposeEnvFile,
  shortImageRef,
} from '../lib/cli-image-pin.js';
import type { ComposeIdentity } from '../lib/compose-discovery.js';
import { upsertEnvVar } from '../env-file.js';

const REPO = 'ghcr.io/companionintelligence/ci-hub';
const ROLLED = `${REPO}@sha256:35de8a86274a8aa9fb22aa9c35026e7de021be4a75004b7243625c1e3438f3e6`;
const PINNED = `${REPO}@sha256:8add981ab8b6970097b9dd3b1b28519468e1087be0d15865733300c455b2835b`;

const identity = (envFiles: string[]): ComposeIdentity => ({
  container: 'ci-hub',
  project: 'ci-hub',
  workingDir: '/home/ci/.local/share/companion-hub',
  configFiles: ['/home/ci/.local/share/companion-hub/docker-compose.yml'],
  envFiles,
});

describe('resolveComposeEnvFile', () => {
  it('prefers the env file compose recorded over this CLI’s own guess', () => {
    // The fleet trap: compose reads `.env.dev`, the CLI would have guessed `.env`, and both exist.
    const resolved = resolveComposeEnvFile(identity(['/home/ci/.local/share/companion-hub/.env.dev']), '/home/ci/.local/share/companion-hub/.env');
    expect(resolved).toEqual({ path: '/home/ci/.local/share/companion-hub/.env.dev', fromCompose: true });
  });

  it('falls back, and says it is a guess, when the stack records no env file', () => {
    expect(resolveComposeEnvFile(identity([]), '/data/.env')).toEqual({ path: '/data/.env', fromCompose: false });
    expect(resolveComposeEnvFile(null, '/data/.env')).toEqual({ path: '/data/.env', fromCompose: false });
  });
});

describe('compareDeclaredToRunning', () => {
  it('reports the measured fleet state as drift', () => {
    expect(compareDeclaredToRunning(PINNED, ROLLED)).toEqual({ kind: 'drifted', declared: PINNED, running: ROLLED });
  });

  it('agrees when the file names exactly what is running', () => {
    expect(compareDeclaredToRunning(`${REPO}:dev`, `${REPO}:dev`)).toEqual({ kind: 'agrees', image: `${REPO}:dev` });
  });

  it('treats a tag and a digest of the same repository as drift, not a match', () => {
    // A digest pin that is not in force is precisely the case worth catching.
    expect(compareDeclaredToRunning(PINNED, `${REPO}:dev`).kind).toBe('drifted');
  });

  it('has no complaint when nothing is pinned, or nothing is running', () => {
    expect(compareDeclaredToRunning(undefined, `${REPO}:dev`).kind).toBe('no-declaration');
    expect(compareDeclaredToRunning(PINNED, null).kind).toBe('not-running');
  });
});

describe('describePinDrift', () => {
  it('fails, names both references, and says what the next restart would do', () => {
    const report = describePinDrift(compareDeclaredToRunning(PINNED, ROLLED), '/home/ci/.local/share/companion-hub/.env.dev', true);
    expect(report.severity).toBe('fail');
    expect(report.headline).toContain('sha256:8add981ab8b6');
    expect(report.headline).toContain('sha256:35de8a86274a');
    expect(report.lines.join(' ')).toContain('next restart');
    expect(report.lines.join(' ')).toContain('.env.dev');
  });

  it('marks a fallback env file as a guess, so a wrong file is visible rather than authoritative', () => {
    const report = describePinDrift(compareDeclaredToRunning(PINNED, ROLLED), '/data/.env', false);
    expect(report.lines.join(' ')).toContain('guess');
  });

  it('says nothing alarming when there is no pin to contradict', () => {
    expect(describePinDrift({ kind: 'no-declaration' }, '/data/.env', true).severity).toBe('ok');
    expect(describePinDrift({ kind: 'not-running' }, '/data/.env', true).severity).toBe('ok');
  });

  it('keeps a digest readable on one line without losing which digest it is', () => {
    expect(shortImageRef(PINNED)).toBe(`${REPO}@sha256:8add981ab8b6…`);
    expect(shortImageRef(`${REPO}:dev`)).toBe(`${REPO}:dev`);
  });
});

describe('decideImagePinWrite', () => {
  const base = { envFile: '/data/.env.dev', envFileExists: true, declaredImage: PINNED, deployedImage: ROLLED, healthy: true };

  it('writes back the image that was deployed, naming what it replaced', () => {
    const decision = decideImagePinWrite(base);
    expect(decision).toMatchObject({ action: 'write', envFile: '/data/.env.dev', image: ROLLED, previous: PINNED });
    expect(decision.action === 'write' && decision.reason).toContain('would have reverted');
  });

  it('refuses to pin a build that did not come up', () => {
    // A pin naming a broken image makes the next restart fail the same way.
    const decision = decideImagePinWrite({ ...base, healthy: false });
    expect(decision).toMatchObject({ action: 'skip' });
    expect(decision.reason).toContain('/api/health');
  });

  it('does nothing when the file already names the deployed image', () => {
    expect(decideImagePinWrite({ ...base, declaredImage: ROLLED }).action).toBe('skip');
  });

  it('records a first pin when the file declares none', () => {
    const decision = decideImagePinWrite({ ...base, declaredImage: undefined });
    expect(decision).toMatchObject({ action: 'write', previous: undefined });
    expect(decision.action === 'write' && decision.reason).toContain('compose default');
  });

  it('will not create an env file that does not exist', () => {
    expect(decideImagePinWrite({ ...base, envFileExists: false }).action).toBe('skip');
  });

  it('refuses a reference with a line break rather than corrupting the file', () => {
    // The desktop app parses this file as KEY=value lines at launch.
    const decision = decideImagePinWrite({ ...base, deployedImage: `${ROLLED}\nMALICIOUS=1` });
    expect(decision).toMatchObject({ action: 'skip' });
    expect(decision.reason).toContain('line break');
  });
});

describe('the write, against a real env file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('replaces only the pin, and the node then reads back what is running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-pin-'));
    dirs.push(dir);
    const envFile = join(dir, '.env.dev');
    writeFileSync(envFile, [`${HUB_IMAGE_VAR}=${PINNED}`, 'JWT_SECRET=keep-me', 'DOMAIN=core-6.example', ''].join('\n'));

    const decision = decideImagePinWrite({
      envFile,
      envFileExists: true,
      declaredImage: readDeclaredHubImage(envFile),
      deployedImage: ROLLED,
      healthy: true,
    });
    expect(decision.action).toBe('write');
    if (decision.action === 'write') upsertEnvVar(decision.envFile, HUB_IMAGE_VAR, decision.image);

    const written = readFileSync(envFile, 'utf-8');
    expect(written).toContain(`${HUB_IMAGE_VAR}=${ROLLED}`);
    expect(written).not.toContain(PINNED);
    // Everything else in a Hub env file is credentials and identity; losing any of it is worse
    // than the drift being fixed.
    expect(written).toContain('JWT_SECRET=keep-me');
    expect(written).toContain('DOMAIN=core-6.example');

    // And the node now agrees with itself.
    const after = inspectImagePin(identity([envFile]), join(dir, '.env'), ROLLED);
    expect(after.drift.kind).toBe('agrees');
    expect(after.report.severity).toBe('ok');
  });

  it('sees the fleet state when the pin and the container disagree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-pin-'));
    dirs.push(dir);
    const envDev = join(dir, '.env.dev');
    writeFileSync(envDev, `${HUB_IMAGE_VAR}=${PINNED}\n`);
    // `.env` exists too and says the same thing — reading the wrong one still had to fail loudly.
    writeFileSync(join(dir, '.env'), `${HUB_IMAGE_VAR}=${PINNED}\n`);

    const pin = inspectImagePin(identity([envDev]), join(dir, '.env'), ROLLED);
    expect(pin.envFile).toBe(envDev);
    expect(pin.fromCompose).toBe(true);
    expect(pin.report.severity).toBe('fail');
  });
});
