import { describe, expect, it, vi } from 'vitest';

// Real child processes: the property under test is what the OS does with an argument vector.
vi.unmock('node:fs');
vi.unmock('fs');

const { spawnAsync, spawnLines } = await import('../exec-helpers');

describe('spawnAsync', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("hello")']);

    expect(result).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });
  });

  it('reports a non-zero exit code alongside stderr', async () => {
    const result = await spawnAsync(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('boom');
  });

  it('hands every argument over verbatim, with no shell to re-parse it', async () => {
    const hostile = ['a`id`', '$(echo pwned)', 'a;echo pwned', "o'brien", '*', 'two  spaces', ''];

    const result = await spawnAsync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile]);

    expect(JSON.parse(result.stdout)).toEqual(hostile);
  });

  it('puts together a multi-byte character that arrives in two pieces', async () => {
    const result = await spawnAsync(process.execPath, [
      '-e',
      'const b = Buffer.from("caf\\u00e9"); process.stdout.write(b.subarray(0, 4)); setTimeout(() => process.stdout.write(b.subarray(4)), 50)',
    ]);

    expect(result.stdout).toBe('caf\u00e9');
  });

  it('resolves, rather than rejects, when the program does not exist', async () => {
    const result = await spawnAsync('definitely-not-a-real-binary-ci-hub', []);

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ENOENT/);
  });

  it('gives up on a program that floods output instead of buffering it without bound', async () => {
    const result = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("x".repeat(40 * 1024 * 1024))']);

    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/size limit/);
  });
});

describe('spawnLines', () => {
  const run = async (script: string, onLine?: (line: string) => void) => {
    const lines: string[] = [];
    const result = await spawnLines(process.execPath, ['-e', script], (line) => {
      lines.push(line);
      onLine?.(line);
    });

    return { lines, result };
  };

  it('hands over each line without its newline, and the last one even with no trailing newline', async () => {
    const { lines, result } = await run('process.stdout.write("one\\ntwo\\nthree")');

    expect(lines).toEqual(['one', 'two', 'three']);
    expect(result).toEqual({ exitCode: 0, stderr: '' });
  });

  it('reports a non-zero exit code and keeps stderr', async () => {
    const { result } = await run('process.stderr.write("boom"); process.exit(3)');

    expect(result).toEqual({ exitCode: 3, stderr: 'boom' });
  });

  it('puts together a multi-byte character that arrives in two pieces', async () => {
    const { lines } = await run(
      'const b = Buffer.from("caf\u00e9\\n"); process.stdout.write(b.subarray(0, 4)); setTimeout(() => process.stdout.write(b.subarray(4)), 50)',
    );

    expect(lines).toEqual(['caf\u00e9']);
  });

  it('is not limited by how much output there is in total, only by how long one line is', async () => {
    const { lines, result } = await run('for (let i = 0; i < 600000; i++) process.stdout.write("x".repeat(80) + "\\n")');

    // 600,000 lines of 81 bytes is ~48 MB, past the 32 MB cap spawnAsync applies.
    expect(lines).toHaveLength(600_000);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('stops the process and reports the error when the callback throws', async () => {
    const started = Date.now();
    const { lines, result } = await run('setInterval(() => process.stdout.write("tick\\n"), 5)', () => {
      throw new Error('enough');
    });

    expect(lines).toEqual(['tick']);
    expect(result.exitCode).toBeNull();
    expect(result.error?.message).toBe('enough');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('gives up on a line that never ends instead of buffering it', async () => {
    const { result } = await run('process.stdout.write("x".repeat(10 * 1024 * 1024))');

    expect(result.exitCode).toBeNull();
    expect(result.error?.message).toMatch(/longer than the size limit/);
  });

  it('resolves, rather than rejects, when the program does not exist', async () => {
    const result = await spawnLines('definitely-not-a-real-binary-ci-hub', [], () => undefined);

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
