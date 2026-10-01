import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearProcessDockerEnginePin,
  dockerEngineStatePath,
  loadPersistedDockerEngine,
  persistDockerEngine,
  securityOptionsSayRootless,
  selectDockerEngine,
  splitBrainConflict,
  type PinnedDockerEngine,
  type ReachableEngine,
} from '../lib/docker-engine';

function reachable(label: string, host: string, kind: ReachableEngine['candidate']['kind'], hasHubIdentity: boolean): ReachableEngine {
  return {
    candidate: { label, dockerHost: host, kind },
    hasHubIdentity,
    hubHostPorts: [],
  };
}

describe('selectDockerEngine', () => {
  it('prefers affinity over Desktop', () => {
    const { candidate, reason } = selectDockerEngine(
      [reachable('Desktop', 'unix:///desktop.sock', 'desktop', false), reachable('system', 'unix:///var/run/docker.sock', 'system', true)],
      null,
    );
    expect(candidate.dockerHost).toBe('unix:///var/run/docker.sock');
    expect(reason).toContain('affinity');
  });

  it('prefers Desktop on fresh install', () => {
    const { candidate, reason } = selectDockerEngine(
      [reachable('system', 'unix:///var/run/docker.sock', 'system', false), reachable('Desktop', 'unix:///desktop.sock', 'desktop', false)],
      null,
    );
    expect(candidate.kind).toBe('desktop');
    expect(reason).toContain('fresh');
  });

  it('pairs Windows WSL engine affinity', () => {
    const { candidate } = selectDockerEngine(
      [reachable('Desktop', 'npipe:////./pipe/docker_engine', 'desktop', false), reachable('WSL', 'tcp://127.0.0.1:2375', 'wsl-engine', true)],
      null,
    );
    expect(candidate.kind).toBe('wsl-engine');
  });
});

describe('docker-engine persistence', () => {
  let dir: string;

  afterEach(() => {
    clearProcessDockerEnginePin();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips camelCase state for CLI/desktop parity', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-hub-docker-engine-'));
    const engine: PinnedDockerEngine = {
      dockerHost: 'unix:///var/run/docker.sock',
      kind: 'system',
      reason: 'affinity',
      selectedAt: 42,
      pathStyle: 'wsl-mnt',
    };
    persistDockerEngine(dir, engine);
    const raw = JSON.parse(readFileSync(dockerEngineStatePath(dir), 'utf8')) as Record<string, unknown>;
    expect(raw.dockerHost).toBe(engine.dockerHost);
    expect(loadPersistedDockerEngine(dir)).toMatchObject(engine);
  });

  it('loads Rust-style camelCase files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-hub-docker-engine-'));
    mkdirSync(path.join(dir, 'state'), { recursive: true });
    writeFileSync(
      dockerEngineStatePath(dir),
      JSON.stringify({
        dockerHost: 'unix:///run/docker.sock',
        kind: 'desktop',
        reason: 'fresh',
        selectedAt: 1,
        pathStyle: 'drive',
      }),
    );
    expect(loadPersistedDockerEngine(dir)?.pathStyle).toBe('drive');
  });
});

describe('splitBrainConflict', () => {
  it('flags override away from the stack engine', () => {
    const selected: PinnedDockerEngine = {
      dockerHost: 'unix:///desktop.sock',
      kind: 'desktop',
      reason: 'override',
      selectedAt: 1,
    };
    const msg = splitBrainConflict(selected, [
      reachable('Desktop', 'unix:///desktop.sock', 'desktop', false),
      reachable('system', 'unix:///var/run/docker.sock', 'system', true),
    ]);
    expect(msg).toContain('Hub stack is on');
  });

  it('allows affinity selection when selected engine owns the stack', () => {
    const selected: PinnedDockerEngine = {
      dockerHost: 'unix:///var/run/docker.sock',
      kind: 'system',
      reason: 'affinity',
      selectedAt: 1,
    };
    expect(
      splitBrainConflict(selected, [
        reachable('Desktop', 'unix:///desktop.sock', 'desktop', false),
        reachable('system', 'unix:///var/run/docker.sock', 'system', true),
      ]),
    ).toBeNull();
  });
});

describe('securityOptionsSayRootless', () => {
  it('reads `docker info --format {{json .SecurityOptions}}`', () => {
    expect(securityOptionsSayRootless('["name=apparmor","name=seccomp,profile=builtin","name=rootless","name=cgroupns"]')).toBe(true);
    expect(securityOptionsSayRootless('["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]')).toBe(false);
  });

  it('says no to output it cannot read', () => {
    expect(securityOptionsSayRootless('')).toBe(false);
    expect(securityOptionsSayRootless('null')).toBe(false);
    expect(securityOptionsSayRootless('name=rootless')).toBe(false);
  });
});
