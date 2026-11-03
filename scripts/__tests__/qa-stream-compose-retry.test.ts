import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts runs its worker immediately when loaded, so extract the pure retry and command-runner
// helpers instead of importing the runner. This keeps the test fast and prevents Docker access.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <compose-transient>([\s\S]*?)\/\/ <\/compose-transient>/.exec(source);
if (!block) throw new Error('the <compose-transient> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const {
  isRetryableComposeFailure,
  isDockerStartTimeout,
  isRetryableTimeout,
  isRetryableHostPortBindRace,
  commandWasInterrupted,
  classifyComposeStartFailure,
  cleanupVerificationPassed,
  verifyQaResourceCleanup,
  makeExecAsync,
  isRetryableTransient,
  attemptOnceWithRetry,
} = new Function(
  `${js}\nreturn { isRetryableComposeFailure, isDockerStartTimeout, isRetryableTimeout, isRetryableHostPortBindRace, commandWasInterrupted, classifyComposeStartFailure, cleanupVerificationPassed, verifyQaResourceCleanup, makeExecAsync, isRetryableTransient, attemptOnceWithRetry };`,
)() as {
  isRetryableComposeFailure: (text: string) => boolean;
  isDockerStartTimeout: (text: string) => boolean;
  isRetryableTimeout: (text: string) => boolean;
  isRetryableHostPortBindRace: (text: string, interrupted?: boolean) => boolean;
  commandWasInterrupted: (error: unknown, timedOut: boolean) => boolean;
  classifyComposeStartFailure: (
    err: string,
    out: string,
    timedOut: boolean,
    interrupted?: boolean,
  ) => {
    startTimedOut: boolean;
    retryableBindRace: boolean;
  };
  cleanupVerificationPassed: (result: { ok: boolean; out: string }) => boolean;
  verifyQaResourceCleanup: (
    run: (command: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>,
    project: string,
    containerName: string,
  ) => Promise<boolean>;
  makeExecAsync: (spawnImpl: never) => (
    cmd: string,
    timeoutMs?: number,
  ) => Promise<{
    ok: boolean;
    out: string;
    err: string;
    ms: number;
    timedOut: boolean;
    interrupted: boolean;
  }>;
  isRetryableTransient: (result: Record<string, unknown>) => boolean;
  attemptOnceWithRetry: (
    attempt: () => Promise<Record<string, unknown>>,
    onRetry?: (first: Record<string, unknown>) => void,
  ) => Promise<Record<string, unknown>>;
};

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: string) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

describe('isRetryableComposeFailure', () => {
  it('recognizes a dependency healthcheck race and the wording from a real cap run', () => {
    expect(
      isRetryableComposeFailure('dependency cap-mysql failed to start: dependency failed to start: container qa-cap-cap-mysql-1 is unhealthy'),
    ).toBe(true);
    expect(isRetryableComposeFailure('context deadline exceeded while waiting for a dependency')).toBe(true);
  });

  it('recognizes healthcheck convergence without retrying arbitrary compose errors', () => {
    expect(isRetryableComposeFailure('health check is starting for service database')).toBe(true);
    expect(isRetryableComposeFailure('healthcheck reports unhealthy')).toBe(true);
    expect(isRetryableComposeFailure('Status: Up 1 second (health: starting)')).toBe(true);
    expect(isRetryableComposeFailure('database health: unhealthy')).toBe(true);
    expect(isRetryableComposeFailure('read tcp [2600::1]:33608->[2600::2]:443: network is unreachable')).toBe(true);
    expect(isRetryableComposeFailure('read tcp 192.0.2.10:55358->198.51.100.69:443: connection timed out')).toBe(true);
    expect(isRetryableComposeFailure('failed to copy layer: connection reset by peer')).toBe(true);
    expect(isRetryableComposeFailure('failed to bind host port 1234: address already in use')).toBe(false);
    expect(isRetryableComposeFailure('failed to authorize: 429 Too Many Requests')).toBe(false);
    expect(isRetryableComposeFailure('manifest unknown: image not found')).toBe(false);
    expect(isRetryableComposeFailure('invalid compose file: service has no image')).toBe(false);
  });

  it('recognizes a Docker start timeout whose daemon outcome may be ambiguous', () => {
    expect(isDockerStartTimeout('spawnSync /bin/sh ETIMEDOUT')).toBe(true);
    expect(isDockerStartTimeout('docker run timed out while waiting for the daemon')).toBe(true);
    expect(isDockerStartTimeout('container exited with code 1')).toBe(false);
  });

  it('does not retry a timed-out Docker start under a container name the daemon may already own', () => {
    expect(isRetryableTimeout('container start timed out: spawnSync /bin/sh ETIMEDOUT')).toBe(false);
    expect(isRetryableTimeout('readiness timed out waiting for the app to answer')).toBe(true);
    expect(isRetryableTimeout('readiness timed out after ETIMEDOUT from the app')).toBe(true);
  });

  it('does not take the host-port retry path when a Docker start also timed out', () => {
    expect(isRetryableHostPortBindRace('failed to bind host port: address already in use')).toBe(true);
    expect(isRetryableHostPortBindRace('failed to bind host port: address already in use; docker run timed out')).toBe(false);
    expect(isRetryableHostPortBindRace('failed to bind host port: address already in use', true)).toBe(false);
  });

  it('marks timeout, signal termination, and output overflow as interrupted commands', () => {
    expect(commandWasInterrupted(new Error('timed out'), true)).toBe(true);
    expect(commandWasInterrupted({ signal: 'SIGKILL' }, false)).toBe(true);
    expect(commandWasInterrupted({ status: 137 }, false)).toBe(true);
    expect(commandWasInterrupted({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, false)).toBe(true);
    expect(commandWasInterrupted({ code: 'ETIMEDOUT' }, false)).toBe(false);
    expect(commandWasInterrupted({ status: 1 }, false)).toBe(false);
  });

  it('treats the command runner deadline as authoritative while preserving network timeout retries', () => {
    expect(classifyComposeStartFailure('', 'dependency connection timed out: ETIMEDOUT', false)).toEqual({
      startTimedOut: false,
      retryableBindRace: false,
    });
    expect(isRetryableComposeFailure('dependency db failed to start: connection timed out: ETIMEDOUT')).toBe(true);
    expect(classifyComposeStartFailure('failed to bind host port: address already in use', '', true)).toEqual({
      startTimedOut: true,
      retryableBindRace: false,
    });
    expect(classifyComposeStartFailure('failed to bind host port: address already in use', 'dependency ETIMEDOUT', false)).toEqual({
      startTimedOut: false,
      retryableBindRace: true,
    });
    expect(classifyComposeStartFailure('failed to bind host port: address already in use', '', false)).toEqual({
      startTimedOut: false,
      retryableBindRace: true,
    });
  });

  it('records the actual command-runner deadline even when Node reports a null error code', async () => {
    let killedWith: string | null = null;
    const fakeSpawn = () => {
      const child = fakeChildProcess();
      child.kill = (signal: string) => {
        killedWith = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    };
    const result = await makeExecAsync(fakeSpawn as never)('docker compose up', 5);
    expect(killedWith).toBe('SIGKILL');
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(classifyComposeStartFailure('', result.err, result.timedOut).startTimedOut).toBe(true);
  });

  it('does not label a normally completed network timeout message as a process timeout', async () => {
    const fakeSpawn = () => {
      const child = fakeChildProcess();
      child.stderr.write('dependency connection timed out: ETIMEDOUT');
      setImmediate(() => child.emit('close', 1, null));
      return child;
    };
    const result = await makeExecAsync(fakeSpawn as never)('docker compose up', 100);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(classifyComposeStartFailure(result.err, result.out, result.timedOut).startTimedOut).toBe(false);
  });

  it.each([
    [null, 'SIGKILL'],
    [137, null],
  ] as const)('suppresses retryable Compose diagnostics after external termination (code=%s, signal=%s)', async (code, signal) => {
    const fakeSpawn = () => {
      const child = fakeChildProcess();
      child.stderr.write('dependency db failed to start: connection timed out: ETIMEDOUT');
      setImmediate(() => child.emit('close', code, signal));
      return child;
    };
    const result = await makeExecAsync(fakeSpawn as never)('docker compose up', 100);
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(isRetryableHostPortBindRace('failed to bind host port: address already in use', result.interrupted)).toBe(false);
    let attempts = 0;
    await attemptOnceWithRetry(async () => {
      attempts += 1;
      return {
        score: 'error',
        failKind: 'compose',
        notes: result.err,
        cleanupConfirmed: true,
        interrupted: result.interrupted,
      };
    });
    expect(attempts).toBe(1);
  });

  it('caps output and suppresses an ambiguous Compose retry even when output contains a bind race', async () => {
    let killed = false;
    const fakeSpawn = () => {
      const child = fakeChildProcess();
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      };
      child.stderr.write('failed to bind host port: address already in use');
      setImmediate(() => child.stdout.write('x'.repeat(16 * 1024 * 1024 + 1)));
      return child;
    };
    const result = await makeExecAsync(fakeSpawn as never)('noisy command', 1_000);
    expect(killed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.err).toContain('Command output exceeded 16 MiB');
    expect(result.err).toContain('failed to bind host port: address already in use');
    expect(classifyComposeStartFailure(result.err, result.out, result.timedOut, result.interrupted).retryableBindRace).toBe(false);
    expect(
      isRetryableTransient({
        failKind: 'compose',
        notes: result.err,
        cleanupConfirmed: true,
        interrupted: result.interrupted,
      }),
    ).toBe(false);
    let attempts = 0;
    const retried = await attemptOnceWithRetry(async () => {
      attempts += 1;
      return {
        score: 'error',
        failKind: 'compose',
        notes: result.err,
        cleanupConfirmed: true,
        retrySuppressed: result.interrupted,
      };
    });
    expect(attempts).toBe(1);
    expect(retried.notes).toContain('retry suppressed because the command was interrupted');
  });

  it.skipIf(process.platform === 'win32')(
    'bounds a shell whose background child keeps inherited output pipes open',
    async () => {
      const startedAt = Date.now();
      const result = await makeExecAsync(spawn as never)('sleep 5 & echo $!', 100);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      const pid = Number(result.out);
      expect(Number.isInteger(pid)).toBe(true);
      const deadline = Date.now() + 1_000;
      let state = '';
      do {
        state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        if (!state || state.startsWith('Z')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      expect(!state || state.startsWith('Z')).toBe(true);
    },
    3_000,
  );

  it('retries readiness and compose failures only after cleanup is confirmed', () => {
    expect(isRetryableTransient({ failKind: 'timeout', notes: 'container start timed out: ETIMEDOUT', cleanupConfirmed: true })).toBe(false);
    expect(isRetryableTransient({ failKind: 'timeout', notes: 'not ready within 30s', cleanupConfirmed: true })).toBe(true);
    expect(isRetryableTransient({ failKind: 'timeout', notes: 'not ready within 30s', cleanupConfirmed: false })).toBe(false);
    expect(isRetryableTransient({ failKind: 'compose', notes: 'dependency db failed to start', cleanupConfirmed: false })).toBe(false);
    expect(isRetryableTransient({ failKind: 'pull', notes: 'registry timeout' })).toBe(true);
  });

  it('requires successful empty Docker output to confirm cleanup', () => {
    expect(cleanupVerificationPassed({ ok: true, out: '' })).toBe(true);
    expect(cleanupVerificationPassed({ ok: true, out: 'remaining-container-id' })).toBe(false);
    expect(cleanupVerificationPassed({ ok: true, out: 'remaining-network-id' })).toBe(false);
    expect(cleanupVerificationPassed({ ok: true, out: 'remaining-volume-name' })).toBe(false);
    expect(cleanupVerificationPassed({ ok: false, out: '' })).toBe(false);
  });

  it('checks project containers, networks, volumes, and the run-scoped container before retrying', async () => {
    const commands: string[] = [];
    const cleared = await verifyQaResourceCleanup(
      async (command) => {
        commands.push(command);
        return { ok: true, out: '' };
      },
      'qa-run-app',
      'qa-stream-run-app',
    );
    expect(cleared).toBe(true);
    expect(commands).toHaveLength(4);
    expect(commands[0]).toContain('docker ps -aq');
    expect(commands[0]).toContain('com.docker.compose.project=qa-run-app');
    expect(commands[1]).toContain('docker network ls');
    expect(commands[2]).toContain('docker volume ls');
    expect(commands[3]).toContain('name=^/qa-stream-run-app$');
  });

  it('rejects failed Docker queries or any leftover resource from every cleanup check', async () => {
    for (let index = 0; index < 4; index += 1) {
      for (const remaining of [
        { ok: false, out: '' },
        { ok: true, out: 'resource-id' },
      ]) {
        let call = 0;
        const cleared = await verifyQaResourceCleanup(
          async () => {
            const current = call;
            call += 1;
            return current === index ? remaining : { ok: true, out: '' };
          },
          'qa-run-app',
          'qa-stream-run-app',
        );
        expect(cleared).toBe(false);
        expect(call).toBe(index + 1);
      }
    }
  });

  it('runs exactly one attempt for an ambiguous Docker start timeout', async () => {
    let calls = 0;
    const result = await attemptOnceWithRetry(async () => {
      calls += 1;
      return { score: 'timeout', failKind: 'timeout', notes: 'container start timed out: ETIMEDOUT', cleanupConfirmed: true };
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBeUndefined();
  });

  it('retries readiness only after cleanup confirmation and retains the first attempt', async () => {
    let calls = 0;
    let retryNotified = false;
    const result = await attemptOnceWithRetry(
      async () => {
        calls += 1;
        return calls === 1
          ? { score: 'timeout', failKind: 'timeout', notes: 'not ready within 30s', cleanupConfirmed: true }
          : { score: 'pass', notes: 'ready' };
      },
      () => {
        retryNotified = true;
      },
    );
    expect(calls).toBe(2);
    expect(retryNotified).toBe(true);
    expect(result.retried).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.firstAttemptScore).toBe('timeout');
    expect(result.firstAttemptNotes).toBe('not ready within 30s');
  });

  it('preserves readiness failure and suppresses retry when cleanup is unconfirmed', async () => {
    let calls = 0;
    const result = await attemptOnceWithRetry(async () => {
      calls += 1;
      return { score: 'timeout', failKind: 'timeout', notes: 'not ready within 30s', cleanupConfirmed: false };
    });
    expect(calls).toBe(1);
    expect(result.score).toBe('timeout');
    expect(result.attempts).toBe(1);
    expect(result.notes).toContain('not ready within 30s');
    expect(result.notes).toContain('retry suppressed because Docker cleanup could not be confirmed');
  });
});

describe('qa-stream retry wiring', () => {
  it('records the first compose attempt and uses the narrow classifier', () => {
    expect(source).toContain('if (isRetryableTransient(result))');
    expect(source).toContain("result.failKind === 'compose' && isRetryableComposeFailure(notes) && result.cleanupConfirmed === true");
    expect(source).toContain("result.failKind === 'timeout' && isRetryableTimeout(notes) && result.cleanupConfirmed === true");
    expect(source).toContain('&& up.retryableBindRace');
    expect(source).toContain('!isRetryableHostPortBindRace(run.err, run.interrupted)');
    expect(source).toContain('verify: verifyCleanup');
    expect(source).toMatch(/verifyQaResourceCleanup\(execAsync, project, o\.containerName, managedVolumes\)/);
    expect(source).toContain('docker network ls');
    expect(source).toContain('docker volume ls');
    expect(source).toContain('firstAttemptFailKind');
    expect(source).toContain('composeFailureSnapshot');
    expect(source).toContain('out: up.out');
    expect(source).toContain('commandOutput(up.err, up.out)');
  });
});
