import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { LocalContainers } from '@/modules/system/panels/local-resources';
import { NetworkModels } from '@/modules/system/panels/network-resources';
import { PoolActivity } from '@/modules/system/panels/pool-activity';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

/*
 * Every column this board drops below a breakpoint, checked in one place.
 *
 * A `hidden sm:table-cell` on the cells and nothing on the header — or the reverse — does not
 * throw, does not fail a type check and does not look broken in the one width the author happened
 * to test. It shifts the whole table by one column at 639px and puts every value under the wrong
 * heading, which on a monitoring page is worse than rendering nothing.
 *
 * So the rule is structural: for each table, the sequence of breakpoints across `<th>` must equal
 * the sequence across the cells of a data row. The comparison is token-wise because `cn` preserves
 * author order, so "hidden text-muted-foreground sm:table-cell" and "hidden sm:table-cell" are the
 * same instruction spelled two ways.
 */

const READY = { pending: false, failed: false };

function breakpointOf(element: Element): string {
  const classes = element.className.split(/\s+/);
  if (!classes.includes('hidden')) return 'always';

  return classes.find((name) => /^@?(sm|md|lg|xl|2xl|3xl):table-cell$/.test(name)) ?? 'hidden-with-no-breakpoint';
}

function expectHeadersAndCellsToAgree(element: ReactElement) {
  const { container } = render(element);
  const tables = [...container.querySelectorAll('table')];
  expect(tables.length).toBeGreaterThan(0);

  for (const table of tables) {
    const headers = [...table.querySelectorAll('thead th')];
    // The first body row that is a real row of data — `TableEmpty` renders a single spanning cell.
    const row = [...table.querySelectorAll('tbody tr')].find((candidate) => candidate.querySelectorAll('td').length === headers.length);
    expect(row, 'no data row with a full complement of cells').toBeTruthy();

    expect(headers.map(breakpointOf)).toEqual([...(row?.querySelectorAll('td') ?? [])].map(breakpointOf));
  }
}

const app: AppRuntimeHealth = {
  appUrn: 'urn:one',
  appName: 'One',
  status: 'running',
  cpuPercent: 12,
  memoryUsageBytes: 100_000_000,
  memoryLimitBytes: 400_000_000,
  highCpu: false,
  sustainedHighCpu: false,
  responsive: true,
  degraded: false,
  forceStopEligible: false,
  reason: null,
  cpuLimit: null,
  usesDefaultCpuLimit: true,
  sampledAt: '2026-09-10T02:31:00Z',
  containers: [],
  gpuVramMb: null,
  readiness: null,
};

describe('column drops', () => {
  it('keeps the containers table aligned at every width', () => {
    expectHeadersAndCellsToAgree(<LocalContainers apps={[app]} history={[]} state={READY} />);
  });

  it('keeps the pool model index aligned at every width', () => {
    expectHeadersAndCellsToAgree(
      <NetworkModels
        peers={[]}
        node={{ backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:1b'] }] }}
        localLabel="This Hub"
        state={READY}
      />,
    );
  });

  it('keeps the routing feed aligned at every width', () => {
    expectHeadersAndCellsToAgree(
      <PoolActivity
        entries={[{ at: new Date().toISOString(), direction: 'outbound', model: 'gemma3:1b', node: 'core-2', backend: 'ollama', outcome: 'served' }]}
        buckets={[{ at: Date.now(), served: 1, failed: 0 }]}
        state={READY}
      />,
    );
  });
});

/*
 * NO COLUMN DROP ON THIS BOARD MAY KEY OFF THE VIEWPORT.
 *
 * The page is a 12-column grid, so a panel's width is its TRACK, not the window. A column written
 * `md:table-cell` appears at a 768px viewport and is then handed whatever the track gives it —
 * which for `xl:col-span-5` is about 510px. Three tables shipped that way and scrolled sideways
 * inside their own cards at every desktop width, while the page-level check stayed green because
 * `KpiTable`'s `overflow-x-auto` absorbed it.
 *
 * `Panel` is a `@container`, so the fix is to key every drop to `@`-variants, which resolve against
 * the nearest container ancestor. This is a source-level scan rather than a render assertion
 * because the failure is a class an author types, and it is invisible at the one width they tried.
 */
describe('column drops are container-keyed, never viewport-keyed', () => {
  // vitest runs from the package root; `import.meta.url` resolves against the vite root here.
  const PANEL_DIR = join(process.cwd(), 'src/modules/system/panels');
  const PANELS = ['pool-nodes.tsx', 'pool-activity.tsx', 'local-resources.tsx', 'network-resources.tsx', 'workload-trends.tsx'];

  it.each(PANELS)('%s keys every table-cell drop to its container', (file) => {
    const source = readFileSync(join(PANEL_DIR, file), 'utf8');
    // A bare `sm:`/`md:`/`lg:`/`xl:` before `table-cell` — i.e. not preceded by the `@` that makes
    // it a container query. Matched on the class token so a comment mentioning one does not trip it.
    const viewportKeyed = [...source.matchAll(/(?<![@\w-])(sm|md|lg|xl|2xl):table-cell/g)].map((match) => match[0]);

    expect(viewportKeyed).toEqual([]);
  });
});
