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
 * fields and of the model lists the page never reads, and otherwise untouched. Each describes one
 * failure the page made on that data:
 *
 *   core-2  a request nine nodes each tried and dropped read as "1 request no node took", held the
 *           verdict red for eighteen hours, and rendered as "Unplaced · +9 tried"; 24 GB held by
 *           `llama-server` never appeared; first bytes printed as "399710ms"; an idle half hour was
 *           captioned "busiest minute 1".
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

async function renderNode(node: 'core-2' | 'core-1' | 'fzzy') {
  fx.data = JSON.parse(readFileSync(join(FIXTURES, `${node}.json`), 'utf8'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(fx.data.now as string));

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

  it('shows the GPU memory held by llama-server outside every workload', async () => {
    const container = await renderNode('core-2');
    const footer = container.querySelector('[data-testid="workload-trend-gpu-unattributed"]');

    expect(footer?.textContent).toContain('llama-server');
    expect(footer?.textContent).toContain('24 GB');
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
