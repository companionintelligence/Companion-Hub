import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { deriveNodeUuid, HubPoolNodeIdentityService } from '../hub-pool-node-identity.service';

const resolveDeviceId = vi.hoisted(() => vi.fn());
vi.mock('@/modules/registration/device-id.resolver', () => ({ resolveDeviceId }));

/** RFC 9562 layout with the version-8 nibble and the `10xx` variant bits. */
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveNodeUuid', () => {
  it('is stable for the same device and data dir', () => {
    expect(deriveNodeUuid('chassis-serial-1', '/data')).toBe(deriveNodeUuid('chassis-serial-1', '/data'));
  });

  it('separates two Hub stacks on one host', () => {
    // A dev stack beside a prod one shares a chassis serial, and two nodes sharing one identity is
    // exactly the collision the UUID exists to make impossible.
    expect(deriveNodeUuid('chassis-serial-1', '/data')).not.toBe(deriveNodeUuid('chassis-serial-1', '/tmp/ci-hub-dev'));
  });

  it('separates two machines', () => {
    expect(deriveNodeUuid('chassis-serial-1', '/data')).not.toBe(deriveNodeUuid('chassis-serial-2', '/data'));
  });

  it('is a well-formed RFC 9562 version-8 UUID', () => {
    const uuid = deriveNodeUuid('chassis-serial-1', '/data');
    // Version 8 says "custom" — the honest answer for a value derived from hardware identity, and
    // not a claim that it is random (v4) or reversible to its name (v5).
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('never contains the raw device id', () => {
    // `resolveDeviceId` can return a chassis serial or an IOPlatformUUID. That value goes to the
    // Portal at registration; it must not become something this Hub hands to any node that asks.
    const serial = 'C02XY1234567';
    expect(deriveNodeUuid(serial, '/data')).not.toContain(serial.toLowerCase());
  });
});

describe('HubPoolNodeIdentityService', () => {
  let service: HubPoolNodeIdentityService;

  beforeEach(() => {
    resolveDeviceId.mockReset();
    service = new HubPoolNodeIdentityService(mock<LoggerService>());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the UUID once and caches it', async () => {
    resolveDeviceId.mockResolvedValue('chassis-serial-1');

    const first = await service.nodeUuid();
    const second = await service.nodeUuid();

    expect(first).toMatch(UUID_V8);
    expect(second).toBe(first);
    // Cached forever after: the probe chain behind it is `execSync` with 5s timeouts, and it is
    // reached from the peer-facing capabilities path.
    expect(resolveDeviceId).toHaveBeenCalledTimes(1);
  });

  it('never throws out of onModuleInit when the device probe fails', async () => {
    // The probe chain is `execSync` over `ioreg`/`dmidecode`. A throw here would crash-loop the
    // whole appliance — including single-node Hubs that have never paired with anything — over a
    // subsystem they do not use.
    resolveDeviceId.mockRejectedValue(new Error('dmidecode: permission denied'));

    expect(() => service.onModuleInit()).not.toThrow();
    await expect(service.nodeUuid()).resolves.toBeNull();
  });

  it('does not cache a transient failure for the life of the process', async () => {
    resolveDeviceId.mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await service.nodeUuid()).toBeNull();

    resolveDeviceId.mockResolvedValue('chassis-serial-1');
    expect(await service.nodeUuid()).not.toBeNull();
  });

  it('peekNodeUuid does no I/O and answers null until the probe has finished', async () => {
    let release: (value: string) => void = () => undefined;
    resolveDeviceId.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const pending = service.nodeUuid();
    // `getOwnCapabilities` answers every peer's 30s probe through this accessor; it must never be
    // the thing that waits on a hardware probe.
    expect(service.peekNodeUuid()).toBeNull();

    release('chassis-serial-1');
    const resolved = await pending;
    expect(service.peekNodeUuid()).toBe(resolved);
    expect(resolved).toMatch(UUID_V8);
  });

  it('reports the failure through identitySummary rather than swallowing it', async () => {
    resolveDeviceId.mockRejectedValue(new Error('dmidecode: permission denied'));
    await service.nodeUuid();

    const summary = service.identitySummary();
    expect(summary.nodeUuid).toBeNull();
    expect(summary.identityError).toContain('permission denied');
    // Signing keys are a separate feature's; this service deliberately holds no key material.
    expect(summary.publicKeyFingerprint).toBeNull();
  });

  it('clears a previous error once identity recovers', async () => {
    resolveDeviceId.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await service.nodeUuid();
    expect(service.identitySummary().identityError).not.toBeNull();

    resolveDeviceId.mockResolvedValue('chassis-serial-1');
    await service.nodeUuid();
    expect(service.identitySummary().identityError).toBeNull();
    expect(service.identitySummary().nodeUuid).not.toBeNull();
  });
});
