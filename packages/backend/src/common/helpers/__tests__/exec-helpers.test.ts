import { describe, expect, it, vi } from 'vitest';

// Real child processes: the property under test is what the OS does with an argument vector.
vi.unmock('node:fs');
vi.unmock('fs');

const { spawnAsync } = await import('../exec-helpers');

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
