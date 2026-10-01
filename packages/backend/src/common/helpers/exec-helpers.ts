import { exec, spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { promisify } from 'node:util';

type ExecAsyncParams = [command: string];

type ExecResult = { stdout: string; stderr: string };

export const execAsync = async (...args: ExecAsyncParams): Promise<ExecResult> => {
  try {
    const { stdout, stderr } = await promisify(exec)(...args);

    return { stdout, stderr };
  } catch (error) {
    if (error instanceof Error) {
      return { stderr: error.message, stdout: '' };
    }

    return { stderr: String(error), stdout: '' };
  }
};

/** A spawned command's outcome. `exitCode` is `null` when the process never ran to completion (not found, killed, output cap hit). */
export type SpawnResult = ExecResult & { exitCode: number | null };

/** Cap on captured output per stream. Listing an untrusted archive can emit a line per entry, so it must not be unbounded. */
const SPAWN_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Run a program with an argument vector and NO shell, so no argument is ever re-parsed.
 *
 * Unlike {@link execAsync} this reports the exit code, because "tar printed something
 * to stderr" and "tar failed" are different facts: callers that act on the result
 * (extracting an archive, then replacing live files) must be able to tell them apart.
 * It never rejects; a spawn failure resolves with `exitCode: null` and the error message
 * as `stderr`.
 */
export const spawnAsync = (command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<SpawnResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (truncated) return;

      if (stdout.length + stderr.length + chunk.length > SPAWN_OUTPUT_LIMIT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }

      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    child.on('error', (error) => settle({ stdout: '', stderr: error.message, exitCode: null }));

    child.on('close', (code) => {
      if (truncated) {
        settle({ stdout: '', stderr: 'Command output exceeded the size limit', exitCode: null });
        return;
      }

      settle({ stdout, stderr, exitCode: code });
    });
  });
