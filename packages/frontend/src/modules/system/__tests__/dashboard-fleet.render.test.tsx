import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResourceMonitorPage from '../pages/resource-monitor-page';

/*
 * THE WHOLE PAGE, AGAINST WHAT THE FLEET ACTUALLY SERVED.
 *
 * Every other test on this board builds its inputs by hand, and every bug this suite pins shipped
 * with those tests green: the inputs were shaped like the author's model of the API, not like the
 * API. The fixtures here are the real payloads of the eight endpoints this page reads (plus
 * `/system/load`), fetched from three nodes' own loopback at 2026-09-27T18:00Z — trimmed of identity
 * fields and of the model lists the page never reads, with the lab's MagicDNS suffix replaced by
 * `tailnet-example.ts.net` (docs/README.md, tip scrub policy; the page keys nodes by their first
 * label, so nothing reads it), and otherwise untouched. Each describes one failure the page made on
 * that data:
 *
 *   core-2  a request nine nodes each tried and dropped read as "1 request no node took", held the
 *           verdict red for eighteen hours, and rendered as "Unplaced · +9 tried"; Ollama's runners
 *           (24 GB, a bare `llama-server` under rocm-smi) are in Model memory and must read as
 *           Ollama's on the GPU tile, not as a second 24 GB held by something else; first bytes
 *           printed as "399710ms"; an idle half hour was captioned "busiest minute 1".
 *   core-1  a 96 GiB BIOS VRAM carve-out: Ollama reports 17 G of models while the host counts 6 G in
 *           use, and the budget said "17G of 29G" beside it.
 *   fzzy    ~42 GiB of GTT held by engines the Hub does not manage, invisible to the budget; history
 *           restored after a restart, zoneless, with a seven-hour hole drawn as one minute; and the
 *           one node where "residency unknown" was true (vLLM running, holding a model).
 *
 * `Date` is pinned to the moment each payload was fetched, so every window and age reads as it did.
 */

const FIXTURES = join(process.cwd(), 'src/modules/system/__tests__/fixtures/fleet-2026-09-27');

const fx = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock('@/lib/app-runtime-monitor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAppRuntimeMonitor: async () => fx.data['apps_resource-monitor'],
}));
vi.mock('@/lib/api-routes/named-status-routes', () => ({
  inferenceStatusOptions: () => ({ queryKey: ['inference-status'], queryFn: async () => fx.data.inference_status }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusOptions: () => ({ queryKey: ['pool-status'], queryFn: async () => fx.data.inference_pool_status }),
  getPoolRoutingLogOptions: () => ({ queryKey: ['pool-log'], queryFn: async () => fx.data['inference_pool_routing-log'] }),
  getHardwareOptions: () => ({ queryKey: ['hardware'], queryFn: async () => fx.data.inference_hardware }),
  getMemoryOptions: () => ({ queryKey: ['memory'], queryFn: async () => fx.data.inference_memory }),
  getCloudProvidersOptions: () => ({ queryKey: ['cloud'], queryFn: async () => fx.data['inference_cloud-providers'] }),
  getResidentModelsOptions: () => ({ queryKey: ['residency'], queryFn: async () => fx.data.inference_models_resident }),
  systemLoadOptions: () => ({ queryKey: ['system-load'], queryFn: async () => fx.data.system_load }),
}));

async function renderNode(node: 'core-2' | 'core-1' | 'fzzy', options: { routingLog?: string } = {}) {
  fx.data = JSON.parse(readFileSync(join(FIXTURES, `${node}.json`), 'utf8'));
  let now = fx.data.now as string;
  // A routing log from another instant replaces the node's own, and the clock moves to that instant.
  if (options.routingLog) {
    const rewound = JSON.parse(readFileSync(join(FIXTURES, options.routingLog), 'utf8'));
    fx.data['inference_pool_routing-log'] = rewound['inference_pool_routing-log'];
    now = rewound.now;
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ResourceMonitorPage />
    </QueryClientProvider>,
  );
  // Every panel and rail stat past its skeleton: all nine queries answered.
  await waitFor(() => expect(view.container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0), { timeout: 8000 });

  return view.container;
}

/** The routing feed — the table whose last header is "Result". */
function feed(container: HTMLElement): HTMLTableElement {
  const table = [...container.querySelectorAll('table')].find(
    (candidate) => candidate.querySelector('thead th:last-child')?.textContent === 'Result',
  );
  expect(table, 'no routing feed on the page').toBeTruthy();

  return table as HTMLTableElement;
}

/** A rail stat's text, found by its label. */
function railStat(container: HTMLElement, label: string): string {
  const cell = [...container.querySelectorAll('span')].find(
    (span) => span.textContent === label && span.className.includes('uppercase'),
  )?.parentElement;
  expect(cell, `no rail stat labelled ${label}`).toBeTruthy();

  return cell?.textContent ?? '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resource monitor on core-2 (pool hub, 16 peers)', () => {
  it('reads all clear: an eighteen-hour-old failed request is outside the window, and it was never unplaced', async () => {
    const container = await renderNode('core-2');

    expect(container.textContent).toContain('All clear');
    expect(container.textContent).not.toContain('no node took');
  });

  it('names the request nine nodes tried and dropped for what it was, not "Unplaced"', async () => {
    const container = await renderNode('core-2');
    const table = feed(container);

    expect(table.textContent).toContain('All 9 failed');
    expect(table.textContent).not.toContain('Unplaced');
  });

  it('prints a six-minute first byte as one, not as 399710ms', async () => {
    const container = await renderNode('core-2');
    const cells = [...feed(container).querySelectorAll('tbody td')].map((cell) => (cell.textContent ?? '').trim());

    expect(cells).toContain('6m 40s');
    expect(feed(container).textContent).not.toMatch(/\d{4,}ms/);
  });

  it("lists llama-server's 24 GB outside every workload as Ollama's runner, the memory Model memory already shows", async () => {
    const container = await renderNode('core-2');
    const lines = [...container.querySelectorAll('[data-testid="workload-trend-gpu-unattributed"] li')].map((li) => li.textContent);

    // 24,331 + 493 MB = the 24,824 MB `/inference/memory` reports for Ollama from the same process read.
    expect(lines).toEqual(['llama-server · ollama, in Model memory24 GB', 'llama-server · ollama, in Model memory493 MB']);
  });

  it('does not print the axis floor as a measurement over an idle half hour', async () => {
    const container = await renderNode('core-2');

    expect(container.textContent).not.toContain('busiest minute 1');
    expect(container.querySelector('[data-testid="decision-bars-total"]')?.textContent).toBe('Nothing routed in the last 30 minutes');
  });

  it('does not name engines that are simply off as residency it could not read', async () => {
    const container = await renderNode('core-2');

    expect(railStat(container, 'Resident')).not.toContain('Residency unknown');
  });

  it("labels the Hub container's GPU runtime as that, and gives the host's ROCm its own row", async () => {
    const container = await renderNode('core-2');

    expect(container.textContent).toContain('GPU in Hub container');
    expect(container.textContent).toContain('Host ROCm');
    expect(container.textContent).not.toContain('GPU runtime');
  });
});

describe('resource monitor on core-1 (96 GiB BIOS VRAM carve-out)', () => {
  it('says the engines hold memory the host does not count, beside the budget that cannot see it', async () => {
    const container = await renderNode('core-1');

    expect(container.querySelector('[data-testid="model-memory-outside-host"]')?.textContent).toContain('more than this host has in use');
    expect(container.querySelector('[data-testid="model-memory-unaccounted"]')).toBeNull();
  });
});

describe('resource monitor on fzzy (GTT held by unmanaged engines, restarted Hub)', () => {
  it('says how much host RAM in use nothing the engines report accounts for', async () => {
    const container = await renderNode('fzzy');

    expect(container.querySelector('[data-testid="model-memory-unaccounted"]')?.textContent).toContain('48G of host RAM in use is held by nothing');
  });

  it("leads the GPU footer with dflash_server, the one holder no managed engine accounts for, and marks vLLM's as counted", async () => {
    const container = await renderNode('fzzy');
    const lines = [...container.querySelectorAll('[data-testid="workload-trend-gpu-unattributed"] li')].map((li) => li.textContent);

    expect(lines).toEqual(['dflash_server · no managed engine17 GB', 'VLLM::EngineCor · vllm, in Model memory314 MB']);
  });

  it('breaks the trend where the Hub was down, and says for how long', async () => {
    const container = await renderNode('fzzy');

    const gaps = [...container.querySelectorAll('[data-testid="workload-trend-gap"]')].map((note) => note.textContent);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toBe('7h 17m gap — the Hub was not sampling');
  });

  it('names vLLM — running, holding a model, and unable to say so — as the one residency blind spot', async () => {
    const container = await renderNode('fzzy');

    expect(railStat(container, 'Resident')).toContain('Residency unknown for: vllm');
    expect(railStat(container, 'Resident')).not.toContain('lemonade');
  });
});

/*
 * THE 30-MINUTE FIGURES, ON ROWS THAT ARE INSIDE THE 30 MINUTES.
 *
 * Every routing row in the 18:00Z captures is fifteen hours old, so on them the rail's windowed
 * figures — waiting, first byte, failovers, routed, failed — only ever render their empty states. The
 * fleet was idle when this was written (both pool Hubs: nothing placed or changed in the previous 30
 * minutes) and generating a turn to capture is outside what a read-only look at the fleet allows. So
 * this is core-2's OWN log, rewound to 2026-09-26T23:56:30Z, in the middle of the agent-turn burst it
 * recorded: twenty rows, every one placed inside the window. Nothing is invented. A row's state at that
 * instant follows from its own timings (it settles at `at + durationMs`; the usage frame is its last
 * `updatedAt`), and the one failover hop comes from the Hub's log — core-7 "failed: No response headers
 * within 329000ms" at 23:55:50.870, and core-14 took the turn. The rest of the page stays on its
 * 18:00Z payloads; only the routing log and the clock move.
 *
 * At that instant the turn is `pending` on core-14, placed 6m 8s earlier against a 329 s budget. Timed
 * from placement, the page raised "Request waiting 6m 8s of 5m 29s on core-14" about a node that had
 * held it for 39 seconds.
 */
describe('resource monitor on core-2 mid-burst (its routing log as it stood at 23:56:30Z)', () => {
  const REWOUND = 'core-2-routing-2026-09-26T235630Z.json';

  it("does not charge core-7's spent budget to core-14, which took the turn 39 seconds ago", async () => {
    const container = await renderNode('core-2', { routingLog: REWOUND });

    expect(container.textContent).toContain('All clear');
    expect(container.textContent).not.toContain('Request waiting');
    expect(railStat(container, 'Waiting')).toBe('1Waitingoldest 39.1 s · core-14, after 1 failover');
  });

  it('counts the window the log covers: every decision, the one failure, both failovers, nothing partial', async () => {
    const container = await renderNode('core-2', { routingLog: REWOUND });

    expect(railStat(container, 'Routed 30m')).toBe('20Routed 30m');
    // All nine refused in 307 s of a 780 s budget: a failure, but not one that ran out a budget.
    expect(railStat(container, 'Failed 30m')).toBe('1Failed 30m');
    expect(railStat(container, 'Failover 30m')).toBe('2Failover 30m');
    expect(container.textContent).not.toContain('at least');
  });

  it('gives the slowest streamed first byte and where, leaving out the failed-over turn and the non-streamed call', async () => {
    const container = await renderNode('core-2', { routingLog: REWOUND });

    // core-6, 91,716 ms for a ~39k-token prompt. core-14's 399,710 ms turn had not answered yet, and
    // core-7's 16,450 ms row was not streamed, so its duration is a whole completion.
    expect(railStat(container, '1st byte 30m')).toBe('1m 32s1st byte 30mcore-6 · ~39k tok');
  });

  it("fills each node's 1st-byte column from the same rows, and leaves the nodes with no clean sample blank", async () => {
    const container = await renderNode('core-2', { routingLog: REWOUND });
    // Expand, state, node, tier, now, 1st byte: the sixth cell of a node's row.
    const firstByte = (key: string) => container.querySelector(`tr[data-node="${key}"]`)?.querySelectorAll('td')[5]?.textContent;

    expect(firstByte('peer-core-6')).toBe('1m 32s');
    expect(firstByte('peer-beta-1')).toBe('29.7 s');
    // This Hub: its own outbound rows AND beta-max's forwards into it (32,227 ms), one engine.
    expect(firstByte('local')).toBe('32.2 s');
    expect(firstByte('peer-core-14')).toBe('—');
    expect(firstByte('peer-core-7')).toBe('—');
  });
});
