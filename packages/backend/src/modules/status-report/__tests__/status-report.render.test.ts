import { describe, expect, it } from 'vitest';
import { renderHubStatusMarkdown } from '../status-report.render';
import type { HubStatusReport } from '../status-report.types';

/**
 * The property these tests exist to defend: **a section that could not be read
 * never renders as an empty one.** An auditor reading "no workloads" must be able
 * to tell "none are installed" from "the Docker socket was unreachable".
 */

const EMPTY: HubStatusReport = {
  generatedAt: '2026-09-09T12:00:00.000Z',
  hubVersion: null,
  connection: null,
  system: null,
  backends: null,
  models: null,
  workloads: null,
  problems: [],
};

function render(overrides: Partial<HubStatusReport> = {}): string {
  return renderHubStatusMarkdown({ ...EMPTY, ...overrides });
}

describe('renderHubStatusMarkdown', () => {
  it('carries the generation timestamp, and says what a stale one means', () => {
    const out = render();

    expect(out).toContain('2026-09-09T12:00:00.000Z');
    expect(out).toMatch(/not running/i);
  });

  it('renders all five requested sections', () => {
    const out = render();

    expect(out).toContain('## Connection details');
    expect(out).toContain('## LLM backends running');
    expect(out).toContain('## LLM / AI models installed');
    expect(out).toContain('## Installed containerized workloads');
    expect(out).toContain('## System status');
  });

  // ── unreadable is not empty ──────────────────────────────────────────────

  it('distinguishes an unreadable model list from an empty one', () => {
    expect(render({ models: null })).toContain('Could not be read');
    expect(render({ models: null })).not.toContain('No models are installed');

    expect(render({ models: [] })).toContain('No models are installed');
    expect(render({ models: [] })).not.toMatch(/models installed[\s\S]{0,80}Could not be read/);
  });

  it('distinguishes an unreadable workload list from an empty one', () => {
    expect(render({ workloads: null })).toContain('Could not be read');
    expect(render({ workloads: [] })).toContain('No apps are installed');
  });

  it('distinguishes unreadable backends from none running', () => {
    expect(render({ backends: null })).toContain('Could not be read');
    expect(render({ backends: [] })).toContain('No inference backend is running');
  });

  it('lists the sections that failed, rather than silently dropping them', () => {
    const out = render({ problems: ['inference: connect ECONNREFUSED'] });

    expect(out).toContain('Some sections could not be read');
    expect(out).toContain('inference: connect ECONNREFUSED');
  });

  // ── the disagreement an audit is for ─────────────────────────────────────

  it('flags an app the Hub calls running that has no running container', () => {
    const out = render({
      workloads: [
        {
          name: 'immich',
          urn: 'immich:1',
          desiredStatus: 'running',
          containers: [{ name: 'immich-server', state: 'exited', status: 'Exited (1)', ports: [] }],
        },
      ],
    });

    expect(out).toMatch(/have no running container/);
    expect(out).toContain('immich');
    expect(out).toContain('0/1');
  });

  it('does not flag an app whose container is genuinely up', () => {
    const out = render({
      workloads: [
        {
          name: 'immich',
          urn: 'immich:1',
          desiredStatus: 'running',
          containers: [
            { name: 'immich-server', state: 'running', status: 'Up 2 hours', ports: [{ hostPort: 2283, containerPort: 3001, protocol: 'tcp' }] },
          ],
        },
      ],
    });

    expect(out).not.toMatch(/have no running container/);
    expect(out).toContain('2283->3001/tcp');
    expect(out).toContain('1/1');
  });

  // ── models ───────────────────────────────────────────────────────────────

  it('marks a model that is on disk but refuses to serve', () => {
    const out = render({
      models: [
        { name: 'qwen3:8b', backend: 'ollama', sizeBytes: 5_225_388_164, unservable: false },
        { name: 'gemma3:1b', backend: 'ollama', sizeBytes: null, unservable: true },
      ],
    });

    expect(out).toContain('qwen3:8b');
    expect(out).toContain('4.9 GiB');
    expect(out).toMatch(/failed to serve/);
    // A size nothing reported is unknown, never zero.
    expect(out).toContain('_unknown_');
  });

  it('omits the size column entirely when no engine reports a size', () => {
    // Every cell unknown is not a measurement; it reads as missing data. The
    // router's model list carries no size today, so this is the common case.
    const out = render({
      models: [{ name: 'qwen3:8b', backend: 'ollama', sizeBytes: null, unservable: false }],
    });

    expect(out).toContain('| Model | Backend | Servable |');
    expect(out).not.toContain('| Model | Backend | Size | Servable |');
  });

  it('says a model list is unverified when nothing is healthy to serve it', () => {
    // The Hub's record is not a live check. Left unqualified beside a "Servable"
    // column, it reads as confirmed when nothing confirmed it.
    const out = render({
      models: [{ name: 'qwen3:8b', backend: 'ollama', sizeBytes: null, unservable: false }],
      backends: [{ type: 'ollama', running: false, healthy: false, url: null, modelsLoaded: null }],
    });

    expect(out).toMatch(/what the Hub last recorded/);
  });

  it('does not add that caveat when a backend is healthy', () => {
    const out = render({
      models: [{ name: 'qwen3:8b', backend: 'ollama', sizeBytes: null, unservable: false }],
      backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://x', modelsLoaded: 1 }],
    });

    expect(out).not.toMatch(/what the Hub last recorded/);
  });

  // ── backends ─────────────────────────────────────────────────────────────

  it('separates running backends from the ones that are merely possible', () => {
    const out = render({
      backends: [
        { type: 'ollama', running: true, healthy: true, url: 'http://127.0.0.1:11434', modelsLoaded: 2 },
        { type: 'vllm', running: false, healthy: false, url: null, modelsLoaded: null },
      ],
    });

    expect(out).toContain('ollama');
    expect(out).toContain('http://127.0.0.1:11434');
    expect(out).toMatch(/Not running: `vllm`/);
  });

  // ── injection-ish safety ─────────────────────────────────────────────────

  it('escapes a pipe in a name so one app cannot break the table', () => {
    const out = render({
      workloads: [{ name: 'evil|name', urn: null, desiredStatus: 'running', containers: [] }],
    });

    expect(out).toContain('evil\\|name');
  });

  it('renders a GPU whose driver is dead as a problem, not as absent', () => {
    const out = render({
      system: {
        platform: 'linux',
        uptimeSeconds: 90_000,
        cpu: null,
        memory: null,
        disk: null,
        dockerVersion: null,
        containerCount: null,
        gpu: { vendor: 'NVIDIA', model: 'RTX 3070', vramMb: 8192, driverWorking: false, visibleToHubContainer: false },
        hardwareTier: 'cpu-only',
      },
    });

    expect(out).toMatch(/driver not responding/);
    expect(out).toContain('1d 1h');
  });

  it('does not call the driver dead when the host drives a GPU the Hub container cannot see', () => {
    // The normal Linux AMD layout: no device passthrough into the Hub container, Ollama on the
    // host using the card. The report once read the container's view alone and printed
    // "driver not responding" next to a tier of `high` computed from the host's proof.
    const out = render({
      system: {
        platform: 'linux',
        uptimeSeconds: 90_000,
        cpu: null,
        memory: null,
        disk: null,
        dockerVersion: null,
        containerCount: null,
        gpu: { vendor: 'amd', model: 'Radeon RX 7900 XTX', vramMb: 24_560, driverWorking: true, visibleToHubContainer: false },
        hardwareTier: 'high',
      },
    });

    expect(out).not.toMatch(/driver not responding/);
    expect(out).toContain('Radeon RX 7900 XTX');
    expect(out).toContain('not visible inside the Hub container');
  });

  it('adds nothing to the GPU line when the Hub container reaches the card itself', () => {
    const out = render({
      system: {
        platform: 'linux',
        uptimeSeconds: 90_000,
        cpu: null,
        memory: null,
        disk: null,
        dockerVersion: null,
        containerCount: null,
        gpu: { vendor: 'nvidia', model: 'RTX 3080', vramMb: 10_240, driverWorking: true, visibleToHubContainer: true },
        hardwareTier: 'medium',
      },
    });

    expect(out).toContain('| GPU | nvidia RTX 3080, 10.0 GiB VRAM |');
  });
});
