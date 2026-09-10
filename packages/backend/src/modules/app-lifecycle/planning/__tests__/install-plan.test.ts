import { describe, it, expect } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { FormField } from '@ci-hub/common/schemas';
import type { AppFilesManager } from '../../../apps/app-files-manager';
import type { DockerService } from '../../../docker/docker.service';
import type { EnvUtils } from '../../../env/env.utils';
import type { PortManagerService } from '../../../network/port-manager.service';
import { toCheckResult, planImages, planPorts, planFormFields } from '../install-plan';
import type { PortRequestInput } from '../port-requests';

describe('toCheckResult', () => {
  it('reports ok when the assertion resolves', async () => {
    await expect(toCheckResult(async () => undefined)).resolves.toEqual({ ok: true });
  });

  it('captures a thrown Error message as the reason', async () => {
    await expect(
      toCheckResult(async () => {
        throw new Error('device not available');
      }),
    ).resolves.toEqual({ ok: false, reason: 'device not available' });
  });

  it('stringifies a non-Error throw', async () => {
    await expect(
      toCheckResult(() => {
        throw 'boom';
      }),
    ).resolves.toEqual({ ok: false, reason: 'boom' });
  });

  it('treats an optional-service call that resolves to undefined as ok (unavailable service, not a failure)', async () => {
    const maybeAssert: (() => Promise<void>) | undefined = undefined;
    await expect(toCheckResult(() => maybeAssert?.())).resolves.toEqual({ ok: true });
  });
});

describe('planImages', () => {
  it('reports cache status per image without pulling', async () => {
    const dockerService = mock<DockerService>() as MockProxy<DockerService>;
    dockerService.imageExistsLocally.mockImplementation(async (image) => image === 'ghcr.io/ci/cached:latest');

    const result = await planImages(dockerService, ['ghcr.io/ci/cached:latest', 'ghcr.io/ci/missing:latest']);

    expect(result).toEqual([
      { image: 'ghcr.io/ci/cached:latest', cachedLocally: true },
      { image: 'ghcr.io/ci/missing:latest', cachedLocally: false },
    ]);
    expect(dockerService.imageExistsLocally).toHaveBeenCalledTimes(2);
  });

  it('returns an empty plan for no images', async () => {
    const dockerService = mock<DockerService>() as MockProxy<DockerService>;
    await expect(planImages(dockerService, [])).resolves.toEqual([]);
  });
});

describe('planPorts', () => {
  it('reports availability per request without allocating', async () => {
    const portManager = mock<PortManagerService>() as MockProxy<PortManagerService>;
    portManager.isPortAvailable.mockImplementation(async (port) => port === 8080);

    const requests: PortRequestInput[] = [
      { containerPort: 80, label: 'main', preferredHostPort: 8080 },
      { containerPort: 53, label: 'app-53', preferredHostPort: 5353, protocol: 'udp' },
    ];

    const result = await planPorts(portManager, requests);

    expect(result).toEqual([
      { label: 'main', containerPort: 80, protocol: 'tcp', preferredHostPort: 8080, available: true },
      { label: 'app-53', containerPort: 53, protocol: 'udp', preferredHostPort: 5353, available: false },
    ]);
    expect(portManager.allocatePorts).not.toHaveBeenCalled();
  });

  it('falls back to the container port when no preference is given', async () => {
    const portManager = mock<PortManagerService>() as MockProxy<PortManagerService>;
    portManager.isPortAvailable.mockResolvedValue(true);

    const result = await planPorts(portManager, [{ containerPort: 8080, label: 'main' }]);

    expect(result).toEqual([{ label: 'main', containerPort: 8080, protocol: 'tcp', preferredHostPort: 8080, available: true }]);
    expect(portManager.isPortAvailable).toHaveBeenCalledWith(8080, 'tcp');
  });
});

describe('planFormFields', () => {
  const fields: FormField[] = [
    { env_variable: 'ADMIN_EMAIL', label: 'Admin email', type: 'text' } as FormField,
    { env_variable: 'DEBUG', label: 'Debug mode', type: 'text', default: 'false' } as FormField,
  ];

  it('returns nothing when the app declares no form fields', async () => {
    const appFilesManager = mock<AppFilesManager>() as MockProxy<AppFilesManager>;
    const envUtils = mock<EnvUtils>() as MockProxy<EnvUtils>;
    await expect(planFormFields(appFilesManager, envUtils, 'app:store' as any, [], {})).resolves.toEqual([]);
    expect(appFilesManager.getAppEnv).not.toHaveBeenCalled();
  });

  it('marks every field added on a fresh install (no persisted app.env)', async () => {
    const appFilesManager = mock<AppFilesManager>() as MockProxy<AppFilesManager>;
    const envUtils = mock<EnvUtils>() as MockProxy<EnvUtils>;
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: '' });
    envUtils.envStringToMap.mockReturnValue(new Map());

    const result = await planFormFields(appFilesManager, envUtils, 'app:store' as any, fields, { ADMIN_EMAIL: 'ops@example.com' });

    expect(result).toEqual([
      { key: 'ADMIN_EMAIL', label: 'Admin email', currentValue: undefined, proposedValue: 'ops@example.com', status: 'added' },
      { key: 'DEBUG', label: 'Debug mode', currentValue: undefined, proposedValue: 'false', status: 'added' },
    ]);
  });

  it('distinguishes unchanged from changed against the currently persisted app.env', async () => {
    const appFilesManager = mock<AppFilesManager>() as MockProxy<AppFilesManager>;
    const envUtils = mock<EnvUtils>() as MockProxy<EnvUtils>;
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: 'ADMIN_EMAIL=ops@example.com\nDEBUG=false' });
    envUtils.envStringToMap.mockReturnValue(
      new Map([
        ['ADMIN_EMAIL', 'ops@example.com'],
        ['DEBUG', 'false'],
      ]),
    );

    const result = await planFormFields(appFilesManager, envUtils, 'app:store' as any, fields, { ADMIN_EMAIL: 'new-owner@example.com' });

    expect(result).toEqual([
      { key: 'ADMIN_EMAIL', label: 'Admin email', currentValue: 'ops@example.com', proposedValue: 'new-owner@example.com', status: 'changed' },
      { key: 'DEBUG', label: 'Debug mode', currentValue: 'false', proposedValue: 'false', status: 'unchanged' },
    ]);
  });
});
