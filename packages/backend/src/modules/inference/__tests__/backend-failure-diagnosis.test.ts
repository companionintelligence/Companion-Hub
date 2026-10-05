import { describe, expect, it } from 'vitest';
import { diagnoseBackendFailure, type DiagnosisInput } from '../supervision/backend-failure-diagnosis';
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
    exitCode: 1,
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
    logTail: null,
    zombieProcessCount: null,
    healthError: null,
    ...overrides,
  };
}

describe('diagnoseBackendFailure', () => {
  it('names a startup dependency failure from the log tail', () => {
    // The fleet's vLLM restart loop was a FlashInfer JIT compile against an incompatible gcc.
    const diagnoses = diagnoseBackendFailure(
      input({
        backend: 'vllm',
        container: container({ name: 'ci-hub-vllm', image: 'vllm/vllm-openai:latest', exitCode: 1 }),
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
    expect(diagnoseBackendFailure(input({ container: null }))).toEqual([]);
  });
});
