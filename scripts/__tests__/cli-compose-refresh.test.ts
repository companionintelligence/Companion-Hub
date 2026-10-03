import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupStamp, lineChanges, parseComposeRefreshArgs } from '../lib/cli-compose-refresh';
import { renderHelp, stripAnsi } from '../lib/cli-ui';

describe('parseComposeRefreshArgs', () => {
  it('is a dry run that recreates by default', () => {
    expect(parseComposeRefreshArgs([])).toEqual({ execute: false, recreate: true });
  });

  it('applies on --execute and can skip the recreate', () => {
    expect(parseComposeRefreshArgs(['--execute', '--no-recreate'])).toEqual({ execute: true, recreate: false });
  });

  it('refuses an option it does not know rather than ignoring it', () => {
    expect(() => parseComposeRefreshArgs(['--force'])).toThrow('--force');
  });
});

describe('lineChanges', () => {
  it('reports the init line the 2026-10-03 fix added, and nothing else', () => {
    const current = ['  ci-hub:', '    platform: x', '    image: y'].join('\n');
    const next = ['  ci-hub:', '    platform: x', '    init: true', '    image: y'].join('\n');
    expect(lineChanges(current, next)).toEqual({ added: ['    init: true'], removed: [] });
  });

  it('counts a repeated line as many times as it differs', () => {
    expect(lineChanges('a\nb', 'a\nb\nb')).toEqual({ added: ['b'], removed: [] });
  });

  it('reads a pure reordering as no change', () => {
    expect(lineChanges('a\nb\nc', 'c\na\nb')).toEqual({ added: [], removed: [] });
  });

  it('ignores blank lines', () => {
    expect(lineChanges('a', 'a\n\n')).toEqual({ added: [], removed: [] });
  });
});

describe('backupStamp', () => {
  it('sorts by time and pads every field', () => {
    expect(backupStamp(new Date(2026, 9, 3, 9, 5, 7))).toBe('20261003-090507');
  });
});

describe('discoverability', () => {
  it('is in --help, and docs/CLI.md has its section and its implementation-map row', () => {
    const doc = readFileSync(join(__dirname, '../../docs/CLI.md'), 'utf8');
    expect(stripAnsi(renderHelp())).toContain('compose refresh');
    expect(doc).toContain('### `cihub compose refresh`');
    expect(doc).toContain('| `cli-compose-refresh.ts` | `compose refresh` |');
  });
});
