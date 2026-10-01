import { exec, spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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

    // Decoded by the stream, so a multi-byte character that arrives in two chunks is not cut in half.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const capture = (stream: 'stdout' | 'stderr') => (chunk: string) => {
      if (truncated) return;

      if (stdout.length + stderr.length + chunk.length > SPAWN_OUTPUT_LIMIT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }

      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
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

/** How a {@link spawnLines} run ended. `error` is set when `onLine` threw or a line was too long, and the process was killed. */
export type SpawnLinesResult = { exitCode: number | null; stderr: string; error?: Error };

/** A single output line longer than this ends the run: no legitimate listing has one, and it would be buffered whole. */
const SPAWN_LINE_LIMIT_BYTES = 64 * 1024;

/** Stderr kept from a {@link spawnLines} run: enough to say what went wrong. */
const SPAWN_LINES_STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * Run a program with an argument vector and NO shell, handing each line of its stdout to `onLine` as it
 * arrives instead of collecting the output.
 *
 * ⚠ FOR OUTPUT THAT GROWS WITH WHAT IS BEING INSPECTED. An archive listing is one line per entry, so
 * {@link spawnAsync}'s output cap turned a backup of a few hundred thousand files into "invalid
 * archive". Here only the line in progress is held; what the caller keeps is its own business, and it
 * can stop the run by throwing, which kills the process.
 *
 * Multi-byte characters split across chunks are reassembled. Like {@link spawnAsync} it never rejects.
 */
export const spawnLines = (
  command: string,
  args: string[],
  onLine: (line: string) => void,
  options: SpawnOptionsWithoutStdio = {},
): Promise<SpawnLinesResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');

    let pending = '';
    let stderr = '';
    let failure: Error | undefined;
    let settled = false;

    const settle = (result: SpawnLinesResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill('SIGKILL');
    };

    const emit = (line: string) => {
      try {
        onLine(line);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const feed = (text: string) => {
      if (failure) return;

      pending += text;
      let start = 0;
      let newline = pending.indexOf('\n', start);

      while (newline !== -1 && !failure) {
        emit(pending.slice(start, newline));
        start = newline + 1;
        newline = pending.indexOf('\n', start);
      }

      pending = pending.slice(start);

      if (pending.length > SPAWN_LINE_LIMIT_BYTES) {
        fail(new Error('Command output has a line longer than the size limit'));
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => feed(decoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < SPAWN_LINES_STDERR_LIMIT_BYTES) stderr += chunk.toString();
    });

    child.on('error', (error) => settle({ exitCode: null, stderr: error.message }));

    child.on('close', (code) => {
      if (!failure) {
        feed(decoder.end());

        if (pending && !failure) {
          emit(pending);
        }
      }

      settle(failure ? { exitCode: null, stderr: stderr || failure.message, error: failure } : { exitCode: code, stderr });
    });
  });
