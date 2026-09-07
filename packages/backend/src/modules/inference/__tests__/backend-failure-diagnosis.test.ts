import { describe, expect, it } from 'vitest';
import {
  assertLuceboxImageSupportsArch,
  LUCEBOX_ROCM_IMAGE,
  LUCEBOX_ROCM_LEGACY_IMAGE,
  luceboxRocmLegacyImageMessage,
} from '../backends/lucebox.backend';
import { diagnoseBackendFailure, looksLikeSegfault, type DiagnosisInput } from '../supervision/backend-failure-diagnosis';
import type { SupervisionContainerState } from '../supervision/supervision.types';

function container(overrides: Partial<SupervisionContainerState> = {}): SupervisionContainerState {
  return {
    id: 'abc123',
    name: 'ci-hub-inference-lucebox',
    image: LUCEBOX_ROCM_LEGACY_IMAGE,
    state: 'exited',
    status: 'exited',
    running: false,
    restartCount: 12,
    restartPolicy: 'unless-stopped',
    exitCode: 139,
    oomKilled: false,
    startedAt: null,
    finishedAt: null,
    healthStatus: null,
    ports: [{ hostPort: 8000, containerPort: 8080 }],
    labels: {},
    inHubComposeProject: false,
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    backend: 'lucebox',
    container: container(),
    gpuVendor: 'amd',
    segfaultObservations: 2,
    logTail: null,
    zombieProcessCount: null,
    healthError: null,
    ...overrides,
  };
}

describe('lucebox ROCm legacy image diagnosis', () => {
  it('fires on image + AMD vendor + repeated SIGSEGV, with no architecture string involved', () => {
    // Deliberately NOT matched on a `gfx*` architecture: nothing in this repo produces one at
    // runtime. `HardwareProfile.gpu` has no arch field and `LuceboxComposeOptions.gpuArch` is an
    // input nothing ever fills, so an arch-based rule would never fire on the fleet it targets.
    const diagnoses = diagnoseBackendFailure(input());

    expect(diagnoses.map((diagnosis) => diagnosis.code)).toContain('lucebox_rocm_legacy_image');
  });

  it('reuses the guard’s own message verbatim, so the two cannot drift', () => {
    const diagnosis = diagnoseBackendFailure(input()).find((entry) => entry.code === 'lucebox_rocm_legacy_image');

    // The guard needs a concrete LLVM target (its predicate is /^gfx115\d$/); the diagnosis has
    // only the family, because nothing in this repo produces a gfx string at runtime. Both go
    // through the same builder, which is what stops the two wordings drifting apart.
    const guardMessage = (() => {
      try {
        assertLuceboxImageSupportsArch(LUCEBOX_ROCM_LEGACY_IMAGE, 'gfx1151');
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    })();

    expect(guardMessage).toBe(luceboxRocmLegacyImageMessage('gfx1151'));
    expect(diagnosis?.remediation).toContain(luceboxRocmLegacyImageMessage('gfx115x'));
    expect(diagnosis?.remediation).toContain(LUCEBOX_ROCM_IMAGE);
  });

  it('says the container has to be recreated, not restarted', () => {
    // Starting the existing container reuses the image it was created with, so "restart it" would
    // be advice that cannot work. The Hub does not restart anything either way.
    const diagnosis = diagnoseBackendFailure(input()).find((entry) => entry.code === 'lucebox_rocm_legacy_image');
    expect(diagnosis?.remediation).toContain('docker rm -f ci-hub-inference-lucebox');
  });

  it('does not fire on a single segfault', () => {
    const diagnoses = diagnoseBackendFailure(input({ segfaultObservations: 1 }));
    expect(diagnoses.map((entry) => entry.code)).not.toContain('lucebox_rocm_legacy_image');
  });

  it('does not fire on the supported ROCm 7.2 tag', () => {
    const diagnoses = diagnoseBackendFailure(input({ container: container({ image: LUCEBOX_ROCM_IMAGE }) }));
    expect(diagnoses.map((entry) => entry.code)).not.toContain('lucebox_rocm_legacy_image');
  });

  it('does not fire on a non-AMD GPU', () => {
    const diagnoses = diagnoseBackendFailure(input({ gpuVendor: 'nvidia' }));
    expect(diagnoses.map((entry) => entry.code)).not.toContain('lucebox_rocm_legacy_image');
  });

  it('still matches when the image carries a digest suffix', () => {
    const diagnoses = diagnoseBackendFailure(input({ container: container({ image: `${LUCEBOX_ROCM_LEGACY_IMAGE}@sha256:deadbeef` }) }));
    expect(diagnoses.map((entry) => entry.code)).toContain('lucebox_rocm_legacy_image');
  });
});

describe('looksLikeSegfault', () => {
  it('recognises the 128+SIGSEGV exit code', () => {
    expect(looksLikeSegfault(container({ exitCode: 139 }), null)).toBe(true);
  });

  it('recognises a segfault in the log tail for a container whose exit was missed', () => {
    // A container the daemon has already restarted is `running` again by poll time, so the exit
    // code is gone. The log tail is the only surviving evidence.
    expect(looksLikeSegfault(container({ running: true, exitCode: null }), 'ggml-hip: Segmentation fault (core dumped)')).toBe(true);
  });

  it('does not treat an ordinary non-zero exit as a segfault', () => {
    expect(looksLikeSegfault(container({ exitCode: 1 }), 'exiting: bad config')).toBe(false);
  });
});

describe('other diagnoses', () => {
  it('names a startup dependency failure from the log tail', () => {
    // The fleet's vLLM restart loop was a FlashInfer JIT compile against an incompatible gcc.
    const diagnoses = diagnoseBackendFailure(
      input({
        backend: 'vllm',
        container: container({ name: 'ci-hub-vllm', image: 'vllm/vllm-openai:latest', exitCode: 1 }),
        gpuVendor: 'nvidia',
        segfaultObservations: 0,
        logTail: 'RuntimeError: Failed to build flashinfer: error: command ‘/usr/bin/gcc’ failed with exit code 1',
      }),
    );

    const diagnosis = diagnoses.find((entry) => entry.code === 'startup_dependency_failure');
    expect(diagnosis).toBeDefined();
    expect(diagnosis?.summary).toContain('deterministic');
  });

  it('reports accumulated zombie children without claiming the Hub will clear them', () => {
    const diagnoses = diagnoseBackendFailure(
      input({
        backend: 'lemonade',
        container: container({ name: 'ci-hub-lemonade', image: 'lemonade:latest', running: true, exitCode: null }),
        segfaultObservations: 0,
        zombieProcessCount: 11,
      }),
    );

    const diagnosis = diagnoses.find((entry) => entry.code === 'zombie_child_processes');
    expect(diagnosis).toBeDefined();
    // Their parent is the in-container supervisor, not init, so a "parent is PID 1" test finds none.
    expect(diagnosis?.summary).toContain('not init');
    expect(diagnosis?.remediation).toContain('the Hub will not restart it');
  });

  it('reports Lucebox running without weights, and says restarting never helps', () => {
    const diagnoses = diagnoseBackendFailure(
      input({
        container: null,
        segfaultObservations: 0,
        healthError: 'Lucebox answered /health but reports no loaded model — the server is running without weights.',
      }),
    );

    const diagnosis = diagnoses.find((entry) => entry.code === 'no_weights');
    expect(diagnosis?.remediation).toContain('Restarting never helps here');
  });

  it('says nothing about a healthy backend', () => {
    expect(diagnoseBackendFailure(input({ container: null, segfaultObservations: 0 }))).toEqual([]);
  });
});
