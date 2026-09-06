import { ConfigurationService } from '@/core/config/configuration.service';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { FsMock } from '@/tests/__mocks__/fs';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';
import {
  KVM_MISSING_CODE,
  KVM_MISSING_USER_MESSAGE,
  ROCM_KFD_MISSING_CODE,
  ROCM_KFD_MISSING_SETTINGS_PATH,
  ROCM_KFD_MISSING_USER_MESSAGE,
} from '../app-lifecycle-errors';
import { assertHostDevicesAvailable } from '../host-device-preflight';

// The real probe reads a host JSON cache and /dev nodes; only its boolean verdict matters here.
vi.mock('@/modules/inference/host-rocm-availability', () => ({
  isRocmKfdPassthroughAvailable: vi.fn(),
}));

const APP_URN = 'test-app:test-store' as AppUrn;

/** Every urn the preflight handed to AppFilesManager, in call order. */
const requestedUrns: AppUrn[] = [];

type Architecture = 'amd64' | 'arm64';

type ModuleRefOptions = {
  composeJson?: unknown;
  userCompose?: string | null;
  architecture?: Architecture;
};

/**
 * The preflight resolves its collaborators through Nest's ModuleRef rather than constructor
 * injection, so the seam under test is `moduleRef.get` — not a Nest testing module.
 */
function createModuleRef(options: ModuleRefOptions = {}): ModuleRef {
  const config = {
    get: (key: string) => (key === 'architecture' ? (options.architecture ?? 'amd64') : undefined),
  };

  // Compose files belong to exactly one app, so asking about the wrong urn has to come up empty
  // instead of yielding the manifest under test — otherwise a preflight that ignores the urn it
  // was given still reaches the right verdict and nothing notices.
  const contentFor = (urn: AppUrn, content: unknown): unknown => {
    requestedUrns.push(urn);
    return urn === APP_URN ? content : null;
  };

  const appFilesManager = {
    getDockerComposeJson: async (urn: AppUrn) => ({
      path: '/apps/test-app/docker-compose.json',
      content: contentFor(urn, options.composeJson ?? null),
    }),
    getUserComposeFile: async (urn: AppUrn) => ({
      path: '/user-config/test-store/test-app/docker-compose.yml',
      content: contentFor(urn, options.userCompose ?? null),
    }),
  };

  return {
    // The real ModuleRef reaches providers from other modules only with { strict: false }; a fake
    // that ignored the options bag would let a dropped flag ship as a runtime resolution failure.
    get: (token: unknown, getOptions?: { strict?: boolean }) => {
      if (getOptions?.strict !== false) {
        throw new Error('ModuleRef.get without { strict: false } cannot resolve providers from other modules');
      }
      if (token === ConfigurationService) return config;
      if (token === AppFilesManager) return appFilesManager;
      throw new Error(`Unexpected provider requested from ModuleRef: ${String(token)}`);
    },
  } as unknown as ModuleRef;
}

/** Minimal schemaVersion 2 manifest that survives the real `parseComposeJson` validation. */
function composeManifest(devices?: string[]): unknown {
  return {
    schemaVersion: 2,
    services: [
      {
        name: 'main',
        image: 'example/app:1.0.0',
        isMain: true,
        ...(devices ? { devices } : {}),
      },
    ],
  };
}

/** memfs honours mode bits, so `mode` decides which access probes the node answers. */
function markKvmPresent(mode?: number): void {
  (fs as unknown as FsMock).__applyMockFiles({ '/dev/kvm': '' });
  if (mode !== undefined) fs.chmodSync('/dev/kvm', mode);
}

describe('assertHostDevicesAvailable', () => {
  beforeEach(() => {
    // Call history is asserted below, and the config carries no `clearMocks` default.
    vi.clearAllMocks();
    requestedUrns.length = 0;
    // Default host: ROCm passthrough ready, /dev/kvm absent (memfs starts without it).
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(true);
  });

  describe('/dev/kfd in the base manifest', () => {
    it('rejects with the ROCm guidance error when kfd passthrough is unavailable', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kfd', '/dev/dri']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({
        name: 'AppLifecycleError',
        message: ROCM_KFD_MISSING_USER_MESSAGE,
        errorCode: ROCM_KFD_MISSING_CODE,
        settingsPath: ROCM_KFD_MISSING_SETTINGS_PATH,
      });
    });

    it('resolves when kfd passthrough is available', async () => {
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kfd', '/dev/dri']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });

    it('detects kfd declared as a host:container mapping, not just a bare path', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kfd:/dev/kfd:rwm']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('detects kfd when the mapping is padded with whitespace', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // Hand-edited manifests and YAML flow sequences both leave padding around the host side.
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kfd : /dev/kfd']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('ignores a container path that only ends in /dev/kfd', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // Host side is /dev/null; a substring match on the whole entry would wrongly demand ROCm.
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/null:/dev/kfd']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });
  });

  describe('/dev/kvm in the base manifest', () => {
    it('rejects with the KVM guidance error when /dev/kvm is absent from the host', async () => {
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kvm']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({
        name: 'AppLifecycleError',
        message: KVM_MISSING_USER_MESSAGE,
        errorCode: KVM_MISSING_CODE,
      });
    });

    // The device node existing is not enough: on a host where the process is outside the kvm
    // group, /dev/kvm is there but unreadable, and Docker still fails to attach it. 0o222 also
    // separates a read probe from a write probe — F_OK or W_OK would wrongly call it available.
    it.each([
      ['readable by nobody', 0o000],
      ['write-only', 0o222],
    ])('rejects when /dev/kvm exists but is %s', async (_shape, mode) => {
      markKvmPresent(mode);
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kvm']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: KVM_MISSING_CODE });
    });

    it('resolves once /dev/kvm exists on the host', async () => {
      markKvmPresent();
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kvm']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });
  });

  describe('user compose override', () => {
    it('honours a kfd device declared only in the user override', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // Compose appends list fields across -f files, so the override adds kfd to a base without it.
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'services:\n  main:\n    devices:\n      - /dev/kfd\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('honours a kvm device declared only in the user override', async () => {
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'services:\n  main:\n    devices:\n      - "/dev/kvm:/dev/kvm"\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: KVM_MISSING_CODE });
    });

    it('still reads the override for kvm when the base manifest already requires kfd', async () => {
      // ROCm is available, so only the override's /dev/kvm can fail this install. Short-circuiting
      // the override read once one device is known would let the missing kvm reach Docker.
      const moduleRef = createModuleRef({
        composeJson: composeManifest(['/dev/kfd']),
        userCompose: 'services:\n  main:\n    devices:\n      - /dev/kvm\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: KVM_MISSING_CODE });
    });

    it('resolves when the override declares kvm and the host provides it', async () => {
      markKvmPresent();
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'services:\n  main:\n    devices:\n      - /dev/kvm\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });

    it('skips a null service block without losing a sibling service that declares kfd', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // `main:` with no body parses to null. Reading devices straight off it throws, and the
      // catch-all around the parse would swallow that as "no devices needed", hiding gpu entirely.
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'version: "3"\nservices:\n  main:\n  gpu:\n    devices:\n      - /dev/kfd\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('skips a non-string device entry without losing the kfd entry beside it', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // Raw YAML is unvalidated, so a bare number lands here as a number; splitting it throws and
      // the catch-all would again turn that crash into a false all-clear.
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'services:\n  main:\n    devices:\n      - 8080\n      - /dev/kfd\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('ignores devices declared outside the services block', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // A YAML anchor no service merges in contributes nothing to the effective compose, so only
      // `services` may be scanned — walking the whole document would demand ROCm here.
      const moduleRef = createModuleRef({
        composeJson: composeManifest(),
        userCompose: 'version: "3"\nx-gpu: &gpu\n  devices:\n    - /dev/kfd\nservices:\n  main:\n    image: example/app:1.0.0\n',
      });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });

    it('swallows a malformed override instead of blocking an otherwise-valid install', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      // Tab indentation is a hard YAML parse error. The text still mentions /dev/kfd, so a
      // substring-based implementation would reject here rather than skipping the bad file.
      const malformed = 'services:\n\tmain:\n\t\tdevices: [/dev/kfd, /dev/kvm\n';
      expect(() => yaml.parse(malformed)).toThrow();

      const moduleRef = createModuleRef({ composeJson: composeManifest(), userCompose: malformed });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });
  });

  describe('architecture overrides', () => {
    const manifestWithArm64Kfd = {
      schemaVersion: 2,
      services: [{ name: 'main', image: 'example/app:1.0.0', isMain: true }],
      overrides: [{ architecture: 'arm64', services: [{ name: 'main', devices: ['/dev/kfd'] }] }],
    };

    it('scans devices contributed by the matching architecture override', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: manifestWithArm64Kfd, architecture: 'arm64' });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
    });

    it('leaves the base service untouched when the override targets another architecture', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: manifestWithArm64Kfd, architecture: 'amd64' });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });

    it('lets an override replace the base devices list rather than appending to it', async () => {
      const moduleRef = createModuleRef({
        composeJson: {
          schemaVersion: 2,
          services: [{ name: 'main', image: 'example/app:1.0.0', isMain: true, devices: ['/dev/kvm'] }],
          overrides: [{ architecture: 'amd64', services: [{ name: 'main', devices: ['/dev/dri'] }] }],
        },
        architecture: 'amd64',
      });

      // /dev/kvm is absent from the host, so a merge that kept it would reject.
      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });
  });

  describe('manifests without special devices', () => {
    it('resolves and never consults the ROCm probe', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/dri', '/dev/snd']) });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
      expect(isRocmKfdPassthroughAvailable).not.toHaveBeenCalled();
    });

    it('resolves when the app has no installed compose manifest at all', async () => {
      vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
      const moduleRef = createModuleRef({ composeJson: null, userCompose: null });

      await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    });
  });

  it('reads both compose files of the app it was handed', async () => {
    const moduleRef = createModuleRef({ composeJson: composeManifest() });

    await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).resolves.toBeUndefined();
    expect(requestedUrns).toEqual([APP_URN, APP_URN]);
  });

  it('reports the missing ROCm device first when both kfd and kvm are unavailable', async () => {
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(false);
    const moduleRef = createModuleRef({ composeJson: composeManifest(['/dev/kvm', '/dev/kfd']) });

    await expect(assertHostDevicesAvailable(moduleRef, APP_URN)).rejects.toMatchObject({ errorCode: ROCM_KFD_MISSING_CODE });
  });
});
