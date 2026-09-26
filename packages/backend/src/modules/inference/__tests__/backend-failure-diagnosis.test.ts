import { describe, expect, it } from 'vitest';
import { diagnoseBackendFailure, looksLikeSegfault, type DiagnosisInput } from '../supervision/backend-failure-diagnosis';
import type { SupervisionContainerState } from '../supervision/supervision.types';

function container(overrides: Partial<SupervisionContainerState> = {}): SupervisionContainerState {
  return {
    id: 'abc123',
    name: 'ci-hub-ollama',
    image: 'ollama/ollama:latest',
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
    backend: 'ollama',
    container: container(),
    gpuVendor: 'amd',
    segfaultObservations: 2,
    logTail: null,
    zombieProcessCount: null,
    healthError: null,
    ...overrides,
  };
}

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

  it('says nothing about a healthy backend', () => {
    expect(diagnoseBackendFailure(input({ container: null, segfaultObservations: 0 }))).toEqual([]);
  });
});
