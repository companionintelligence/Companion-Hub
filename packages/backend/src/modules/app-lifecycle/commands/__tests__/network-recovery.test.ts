import { abortError } from '@/common/abort';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppLifecycleError, NETWORK_OVERLAP_CODE } from '../app-lifecycle-errors';
import { type ComposeRecoveryDeps, removeAppProjectNetworks, runComposeWithNetworkRecovery } from '../network-recovery';

const APP_URN = 'ghost:store' as AppUrn;
const FORM: AppEventFormInput = { skipPull: true };
const COMMAND = 'up --detach';

const FIRST_SUBNET = '10.128.10.0/24';
const SECOND_SUBNET = '10.128.11.0/24';

/** Overlaps FIRST_SUBNET while being a distinct string, so "named the range we collide with" stays
 * distinguishable from "named our own range back at us". */
const FOREIGN_OVERLAPPING_SUBNET = '10.128.0.0/16';
const UNRELATED_SUBNET = '10.200.5.0/24';

/** Distinct per-attempt CIDRs, deliberately outside the 10.128/9 fixture space so they can only
 * reach a translated detail via the error message of the attempt that carried them. */
const FIRST_ATTEMPT_CIDR = '172.31.1.0/24';
const SECOND_ATTEMPT_CIDR = '172.31.2.0/24';
const LAST_ATTEMPT_CIDR = '172.31.3.0/24';

/** Matches isDockerNetworkOverlapError and deliberately carries no CIDR, so any CIDR that shows up
 * in a translated error's detail must have come from the occupied-subnet lookup, not the message. */
const OVERLAP_MESSAGE = 'failed to create network ghost_ci-marketplace_network: networks have overlapping IPv4 address space';

/** An overlap failure whose message names one CIDR, so which attempt's error got translated is
 * readable off the resulting detail. */
function overlapErrorNaming(cidr: string): Error {
  return new Error(`failed to create network ghost_ci-marketplace_network: Pool overlaps with other one on this address space: ${cidr}`);
}

type AppRow = { subnet: string | null } | null;
type OccupiedEntry = { cidr: string; source: string; dockerNetworkName?: string };
type EnsureAppDirCall = { appUrn: AppUrn; form: AppEventFormInput; excludeSubnets: string[] | undefined };

function createHarness() {
  const callOrder: string[] = [];
  const ensureAppDirCalls: EnsureAppDirCall[] = [];
  const composeFailures: unknown[] = [];
  let composeAlwaysFails: unknown = null;

  const composeApp = vi.fn(async (_appUrn: AppUrn, _command: string, _signal?: AbortSignal) => {
    callOrder.push('composeApp');
    const failure = composeFailures.length > 0 ? composeFailures.shift() : composeAlwaysFails;
    if (failure) {
      throw failure;
    }
  });
  const removeAppNetworks = vi.fn(async (_appUrn: AppUrn) => undefined);

  const releaseSubnet = vi.fn(async (_appUrn: AppUrn) => {
    callOrder.push('releaseSubnet');
  });
  const listOccupiedSubnets = vi.fn<(excludeAppUrn?: AppUrn) => Promise<OccupiedEntry[]>>(async () => []);
  // Argument-sensitive on purpose: a lookup aimed at the wrong URN must come back empty rather than
  // handing this app's row over regardless, or a misdirected read is invisible to every assertion.
  const getAppByUrn = vi.fn<(appUrn: AppUrn) => Promise<AppRow>>(async (appUrn) => (appUrn === APP_URN ? { subnet: FIRST_SUBNET } : null));
  const warn = vi.fn();

  const registry = new Map<unknown, unknown>([
    [DockerService, { composeApp, removeAppNetworks }],
    [SubnetManagerService, { releaseSubnet, listOccupiedSubnets }],
    [AppsRepository, { getAppByUrn }],
    [LoggerService, { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }],
  ]);

  // Every provider below lives outside the lifecycle command's own module, so only a non-strict
  // lookup can reach it; a stub that discarded the options object would hide a resolution-scope
  // regression entirely.
  const moduleRef = {
    get: vi.fn((token: unknown, options?: { strict?: boolean }) => (options?.strict === false ? registry.get(token) : undefined)),
  } as unknown as ModuleRef;

  const ensureAppDir = vi.fn(async (appUrn: AppUrn, form: AppEventFormInput, options?: { excludeSubnets?: string[] }) => {
    callOrder.push('ensureAppDir');
    // The command threads ONE shared array through every attempt and pushes to it. Asserting on the
    // captured reference later would show the fully accumulated list for each call, so snapshot it.
    // A missing options object is recorded as `undefined` rather than flattened to `[]`, so
    // "excluded nothing" stays distinguishable from "was never asked to exclude anything".
    const excluded = options?.excludeSubnets;
    ensureAppDirCalls.push({ appUrn, form, excludeSubnets: excluded === undefined ? undefined : [...excluded] });
  });
  const removeStaleAppNetworks = vi.fn(async (_appUrn: AppUrn) => {
    callOrder.push('removeStaleAppNetworks');
  });

  const deps: ComposeRecoveryDeps = { moduleRef, ensureAppDir, removeStaleAppNetworks };

  return {
    deps,
    moduleRef,
    registry,
    callOrder,
    ensureAppDirCalls,
    composeApp,
    removeAppNetworks,
    releaseSubnet,
    listOccupiedSubnets,
    getAppByUrn,
    ensureAppDir,
    removeStaleAppNetworks,
    warn,
    failComposeOnce: (error: unknown) => {
      composeFailures.push(error);
    },
    failComposeAlways: (error: unknown) => {
      composeAlwaysFails = error;
    },
  };
}

function detailOf(error: unknown): string {
  return error instanceof AppLifecycleError ? (error.errorDetail ?? '') : `not an AppLifecycleError: ${String(error)}`;
}

/** The exact range list the user is shown — an exact-equality target, so an extra, duplicated or
 * missing CIDR fails rather than slipping past a substring check. */
function conflictingRangesOf(error: unknown): string[] {
  const listed = /Conflicting ranges: (.+)$/.exec(detailOf(error))?.[1];
  return listed ? listed.split(', ') : [];
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : `not an Error: ${String(error)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : `not an Error: ${String(error)}`;
}

describe('runComposeWithNetworkRecovery', () => {
  it('runs compose once and clears stale networks before it', async () => {
    const harness = createHarness();

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).resolves.toBeUndefined();

    expect(harness.callOrder).toEqual(['removeStaleAppNetworks', 'composeApp']);
    expect(harness.ensureAppDir).not.toHaveBeenCalled();
    expect(harness.releaseSubnet).not.toHaveBeenCalled();
  });

  // The signal has to reach composeApp or an in-flight `docker compose` keeps running after cancel.
  it('forwards the command and the abort signal to composeApp', async () => {
    const harness = createHarness();
    const controller = new AbortController();

    await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 3, controller.signal);

    expect(harness.composeApp).toHaveBeenCalledWith(APP_URN, COMMAND, controller.signal);
  });

  it('releases the subnet and regenerates compose excluding the failed subnet before retrying', async () => {
    const harness = createHarness();
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).resolves.toBeUndefined();

    // Ordering is load-bearing: the old subnet must be released before regeneration reallocates.
    expect(harness.callOrder).toEqual([
      'removeStaleAppNetworks',
      'composeApp',
      'releaseSubnet',
      'ensureAppDir',
      'removeStaleAppNetworks',
      'composeApp',
    ]);
    expect(harness.releaseSubnet).toHaveBeenCalledWith(APP_URN);
    expect(harness.getAppByUrn).toHaveBeenCalledWith(APP_URN);
    expect(harness.ensureAppDirCalls).toEqual([{ appUrn: APP_URN, form: FORM, excludeSubnets: [FIRST_SUBNET] }]);
    // A recovered install looks like a plain success from outside; this warning is the only trace
    // an operator gets that a subnet was reassigned underneath them.
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining(`${APP_URN} on attempt 1/3`));
  });

  it('accumulates every failed subnet across attempts instead of only excluding the latest', async () => {
    const harness = createHarness();
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));
    harness.getAppByUrn.mockResolvedValueOnce({ subnet: FIRST_SUBNET }).mockResolvedValueOnce({ subnet: SECOND_SUBNET });

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).resolves.toBeUndefined();

    expect(harness.ensureAppDirCalls.map((call) => call.excludeSubnets)).toEqual([[FIRST_SUBNET], [FIRST_SUBNET, SECOND_SUBNET]]);
    expect(harness.composeApp).toHaveBeenCalledTimes(3);
    expect(harness.releaseSubnet).toHaveBeenCalledTimes(2);
  });

  // Deliberately above the default of 3: a loop bound that ignores the argument stays hidden at
  // maxAttempts <= 3, because the separate `attempt < maxAttempts` retry guard masks it.
  it('honours a maxAttempts above the default and still translates the final failure', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 4).catch((err: unknown) => err);

    // The class alone is not enough — the frontend keys its message off errorCode.
    expect(error).toBeInstanceOf(AppLifecycleError);
    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(harness.composeApp).toHaveBeenCalledTimes(4);
    // No regeneration after the final attempt — that work would be thrown away.
    expect(harness.ensureAppDir).toHaveBeenCalledTimes(3);
  });

  it('never retries when maxAttempts is 1', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 1)).rejects.toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });

    expect(harness.composeApp).toHaveBeenCalledTimes(1);
    expect(harness.ensureAppDir).not.toHaveBeenCalled();
    expect(harness.releaseSubnet).not.toHaveBeenCalled();
  });

  // Behaviour change: a below-1 maxAttempts used to run the loop zero times and then throw
  // `new Error(String(lastError))` over a `lastError` that was never assigned, so the caller and the
  // log got the bare word "undefined" for a call that had touched nothing — unreadable as either a
  // compose failure or a bad argument. It is now rejected as a precondition, naming the value it
  // got. Exact message equality, not a substring: the point of the fix is that the text is
  // diagnostic, so a regression back to "undefined" has to fail here.
  it.each([0, -1, Number.NaN])('rejects a maxAttempts of %s before doing any work', async (maxAttempts) => {
    const harness = createHarness();

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, maxAttempts).catch((err: unknown) => err);

    expect(messageOf(error)).toBe(`runComposeWithNetworkRecovery requires maxAttempts >= 1, received ${maxAttempts}`);
    // The guard sits ahead of every side effect, so a rejected call leaves Docker untouched rather
    // than tearing down the app's networks on its way out.
    expect(harness.removeStaleAppNetworks).not.toHaveBeenCalled();
    expect(harness.composeApp).not.toHaveBeenCalled();
    expect(harness.releaseSubnet).not.toHaveBeenCalled();
    expect(harness.ensureAppDir).not.toHaveBeenCalled();
  });

  it('translates an exhausted overlap into a network_overlap error naming only the conflicting ranges', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));
    harness.listOccupiedSubnets.mockResolvedValue([
      { cidr: FOREIGN_OVERLAPPING_SUBNET, source: 'docker', dockerNetworkName: 'other_ci-marketplace_network' },
      { cidr: UNRELATED_SUBNET, source: 'docker', dockerNetworkName: 'unrelated_network' },
    ]);

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppLifecycleError);
    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(conflictingRangesOf(error)).toEqual([FOREIGN_OVERLAPPING_SUBNET]);
    expect(harness.composeApp).toHaveBeenCalledTimes(3);
  });

  // Each attempt reallocates, so each attempt collides with something different. Reporting the
  // first collision would send the user chasing a range that is no longer involved.
  it('translates the last attempt failure rather than the first one it saw', async () => {
    const harness = createHarness();
    harness.failComposeOnce(overlapErrorNaming(FIRST_ATTEMPT_CIDR));
    harness.failComposeOnce(overlapErrorNaming(SECOND_ATTEMPT_CIDR));
    harness.failComposeOnce(overlapErrorNaming(LAST_ATTEMPT_CIDR));

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(conflictingRangesOf(error)).toEqual([LAST_ATTEMPT_CIDR]);
    expect(harness.composeApp).toHaveBeenCalledTimes(3);
  });

  // The app's own reservation always overlaps its own candidate, so forgetting the exclude-self
  // argument would report the app's range back to the user as the thing it conflicts with.
  it('asks for occupied subnets excluding this app so its own range is never named as the conflict', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));
    harness.listOccupiedSubnets.mockImplementation(async (excludeAppUrn) => {
      const rows: OccupiedEntry[] = [
        { cidr: FIRST_SUBNET, source: 'app', dockerNetworkName: 'ghost_ci-marketplace_network' },
        { cidr: FOREIGN_OVERLAPPING_SUBNET, source: 'docker', dockerNetworkName: 'other_ci-marketplace_network' },
      ];
      return excludeAppUrn === APP_URN ? rows.slice(1) : rows;
    });

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 1).catch((err: unknown) => err);

    expect(harness.listOccupiedSubnets).toHaveBeenCalledWith(APP_URN);
    expect(conflictingRangesOf(error)).toEqual([FOREIGN_OVERLAPPING_SUBNET]);
  });

  // Without a subnet row there is nothing to compare against, so the whole occupied list is the
  // diagnostic; returning nothing here would leave the user with a bare "range conflict".
  it('lists every occupied range when the app has no subnet row to compare against', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));
    harness.getAppByUrn.mockResolvedValue({ subnet: null });
    harness.listOccupiedSubnets.mockResolvedValue([
      { cidr: FOREIGN_OVERLAPPING_SUBNET, source: 'docker' },
      { cidr: UNRELATED_SUBNET, source: 'docker' },
    ]);

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 1).catch((err: unknown) => err);

    expect(conflictingRangesOf(error)).toEqual([FOREIGN_OVERLAPPING_SUBNET, UNRELATED_SUBNET]);
  });

  it('still reports a network_overlap error when the app row cannot be read while translating', async () => {
    const harness = createHarness();
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));
    harness.getAppByUrn.mockRejectedValue(new Error('database unavailable'));
    harness.listOccupiedSubnets.mockResolvedValue([{ cidr: UNRELATED_SUBNET, source: 'docker' }]);

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 1).catch((err: unknown) => err);

    // A raw DB error escaping here would strip the errorCode the frontend keys its i18n message off.
    expect(error).toBeInstanceOf(AppLifecycleError);
    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(conflictingRangesOf(error)).toEqual([UNRELATED_SUBNET]);
  });

  it('rethrows a non-overlap compose failure unchanged and without retrying', async () => {
    const harness = createHarness();
    const failure = new Error('failed to create network ghost_ci-marketplace_network: network with name ghost_ci-marketplace_network already exists');
    harness.failComposeAlways(failure);

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toBe(failure);
    expect(harness.composeApp).toHaveBeenCalledTimes(1);
    expect(harness.releaseSubnet).not.toHaveBeenCalled();
    expect(harness.ensureAppDir).not.toHaveBeenCalled();
  });

  // Each abort error below carries overlap wording on purpose: a cancellation that reaches the
  // retry classifier first would be retried instead of propagating, silently ignoring the cancel.
  const abortCases: { label: string; makeError: () => unknown }[] = [
    { label: 'a DOMException AbortError', makeError: () => abortError(OVERLAP_MESSAGE) },
    { label: "Node's spawn ABORT_ERR", makeError: () => Object.assign(new Error(OVERLAP_MESSAGE), { code: 'ABORT_ERR' }) },
  ];

  it.each(abortCases)('propagates $label without retrying', async ({ makeError }) => {
    const harness = createHarness();
    const aborted = makeError();
    harness.failComposeAlways(aborted);

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toBe(aborted);
    expect(harness.composeApp).toHaveBeenCalledTimes(1);
    expect(harness.releaseSubnet).not.toHaveBeenCalled();
    expect(harness.ensureAppDir).not.toHaveBeenCalled();
  });

  it('throws before the first attempt when the signal is already aborted', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 3, controller.signal).catch((err: unknown) => err);

    expect(nameOf(error)).toBe('AbortError');
    expect(harness.removeStaleAppNetworks).not.toHaveBeenCalled();
    expect(harness.composeApp).not.toHaveBeenCalled();
  });

  // The abort check has to sit INSIDE the retry loop. Cancelling during regeneration is the common
  // case — the user hits cancel while the first attempt is already unwinding.
  it('stops between attempts when the signal aborts during compose regeneration', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));
    harness.ensureAppDir.mockImplementation(async () => {
      controller.abort();
    });

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND, 3, controller.signal).catch((err: unknown) => err);

    expect(nameOf(error)).toBe('AbortError');
    expect(harness.composeApp).toHaveBeenCalledTimes(1);
    expect(harness.removeStaleAppNetworks).toHaveBeenCalledTimes(1);
  });

  it('fails before touching networks when DockerService is unavailable', async () => {
    const harness = createHarness();
    harness.registry.delete(DockerService);

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).rejects.toThrow('DockerService unavailable');

    expect(harness.removeStaleAppNetworks).not.toHaveBeenCalled();
  });

  // Both AppsRepository reads — the retry path's and the translation path's — are optional. A
  // Hub booted without the apps module must still recover and still surface the coded error.
  it('recovers and still translates the failure when AppsRepository is unavailable', async () => {
    const harness = createHarness();
    harness.registry.delete(AppsRepository);
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(harness.composeApp).toHaveBeenCalledTimes(3);
    expect(harness.ensureAppDirCalls.map((call) => call.excludeSubnets)).toEqual([[], []]);
  });

  it('retries and still translates the failure when SubnetManagerService is unavailable', async () => {
    const harness = createHarness();
    harness.registry.delete(SubnetManagerService);
    harness.failComposeAlways(new Error(OVERLAP_MESSAGE));

    const error = await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND).catch((err: unknown) => err);

    expect(error).toMatchObject({ errorCode: NETWORK_OVERLAP_CODE });
    expect(harness.composeApp).toHaveBeenCalledTimes(3);
    // Nothing can be enumerated without the subnet manager, so no range list is offered at all.
    expect(conflictingRangesOf(error)).toEqual([]);
  });

  // The deps indirection exists so subclass overrides and instance spies still win; calling
  // DockerService.removeAppNetworks directly here would bypass them.
  it('clears networks through the injected callback rather than DockerService directly', async () => {
    const harness = createHarness();

    await runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND);

    expect(harness.removeStaleAppNetworks).toHaveBeenCalledWith(APP_URN);
    expect(harness.removeAppNetworks).not.toHaveBeenCalled();
  });

  it('still retries with an empty exclusion list when the app row cannot be read', async () => {
    const harness = createHarness();
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));
    harness.getAppByUrn.mockRejectedValue(new Error('database unavailable'));

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).resolves.toBeUndefined();

    expect(harness.ensureAppDirCalls.map((call) => call.excludeSubnets)).toEqual([[]]);
  });

  // `[[]]` rather than `[undefined]`: regeneration must still be TOLD to exclude, with an empty
  // list, so a later attempt keeps threading the accumulator instead of dropping the option.
  it('excludes nothing when the app has no subnet allocated yet', async () => {
    const harness = createHarness();
    harness.failComposeOnce(new Error(OVERLAP_MESSAGE));
    harness.getAppByUrn.mockResolvedValue({ subnet: null });

    await expect(runComposeWithNetworkRecovery(harness.deps, APP_URN, FORM, COMMAND)).resolves.toBeUndefined();

    expect(harness.ensureAppDirCalls.map((call) => call.excludeSubnets)).toEqual([[]]);
  });
});

describe('removeAppProjectNetworks', () => {
  it('removes the app project networks through DockerService', async () => {
    const harness = createHarness();

    await removeAppProjectNetworks(harness.moduleRef, APP_URN);

    expect(harness.removeAppNetworks).toHaveBeenCalledWith(APP_URN);
  });

  it('resolves quietly when DockerService is unavailable', async () => {
    const harness = createHarness();
    harness.registry.delete(DockerService);

    await expect(removeAppProjectNetworks(harness.moduleRef, APP_URN)).resolves.toBeUndefined();
  });

  it('propagates a DockerService failure rather than swallowing it', async () => {
    const harness = createHarness();
    harness.removeAppNetworks.mockRejectedValue(new Error('docker daemon offline'));

    await expect(removeAppProjectNetworks(harness.moduleRef, APP_URN)).rejects.toThrow('docker daemon offline');
  });
});
