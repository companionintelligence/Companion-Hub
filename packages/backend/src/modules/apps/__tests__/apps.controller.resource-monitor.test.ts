/**
 * `GET /api/apps/resource-monitor` names every app on the Hub with its CPU, memory and containers.
 * A member who sees two apps on Home must see the same two on Resources, in the current figures and
 * in every history sample, while the Hub's own row stays for everyone.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import type { AppsReadService } from '../apps-read.service';
import type { AppsService } from '../apps.service';
import { AppsController } from '../apps.controller';

const health = (appUrn: string) => ({
  appUrn,
  appName: appUrn.split(':')[0],
  status: 'running',
  cpuPercent: 1,
  memoryUsageBytes: 1024,
  memoryLimitBytes: 2048,
  highCpu: false,
  sustainedHighCpu: false,
  responsive: true,
  degraded: false,
  forceStopEligible: false,
  reason: null,
  cpuLimit: null,
  usesDefaultCpuLimit: true,
  sampledAt: '2026-11-12T05:00:00.000Z',
  containers: [],
  gpuVramMb: null,
  readiness: null,
});

const point = (appUrn: string) => ({
  appUrn,
  appName: appUrn.split(':')[0],
  status: 'running',
  cpuPercent: 1,
  memoryUsageBytes: 1024,
  containerCount: 1,
  gpuVramMb: null,
});

const URNS = ['ci-hub:system', 'immich:ci-marketplace', 'actual:ci-marketplace', 'recipes:_user'];

function controllerFor(whois: MarketplaceWhoIsService) {
  const monitor = mock<AppRuntimeMonitorService>();
  monitor.getRuntimeMonitorSnapshot.mockResolvedValue({
    sampledAt: '2026-11-12T05:00:00.000Z',
    apps: URNS.map(health),
    history: [{ sampledAt: '2026-11-12T04:59:00.000Z', apps: URNS.map(point) }],
    unattributedGpu: null,
    gpuVramSource: 'absent',
  } as never);
  return new AppsController(mock<AppsReadService>(), mock<AppsService>(), monitor, mock<ModuleRef>(), whois);
}

/** A whois that grants `view` on the listed apps only, the way the Portal answers for a member. */
function viewing(allowed: string[]) {
  const whois = mock<MarketplaceWhoIsService>();
  whois.filterSessionByView.mockImplementation(async (_req, items, urnOf) =>
    items.filter((item) => {
      const urn = urnOf(item);
      return urn === undefined || allowed.includes(urn);
    }),
  );
  return whois;
}

describe('AppsController.getResourceMonitor', () => {
  const member = { hubPrincipal: 'session', user: { id: 2 } } as Request;

  it('shows a member only the apps they may view, now and in the history', async () => {
    const result = await controllerFor(viewing(['immich:ci-marketplace'])).getResourceMonitor(member);

    expect(result.apps.map((app) => app.appUrn)).toEqual(['ci-hub:system', 'immich:ci-marketplace']);
    expect(result.history[0]?.apps.map((app) => app.appUrn)).toEqual(['ci-hub:system', 'immich:ci-marketplace']);
  });

  it('keeps the Hub itself, which no grant covers', async () => {
    const whois = viewing([]);

    const result = await controllerFor(whois).getResourceMonitor(member);

    expect(result.apps.map((app) => app.appUrn)).toEqual(['ci-hub:system']);
    expect(whois.filterSessionByView).toHaveBeenCalledWith(member, expect.any(Array), expect.any(Function), 'hub');
  });

  it('shows everything when the session may view everything', async () => {
    const result = await controllerFor(viewing(URNS)).getResourceMonitor(member);

    expect(result.apps).toHaveLength(4);
    expect(result.history[0]?.apps).toHaveLength(4);
  });
});
