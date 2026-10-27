import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts is copied to fleet nodes and runs its CLI body on import, so keep the diagnostic
// formatter as a self-contained source block and exercise that exact implementation here.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <screenshot-diagnostics>([\s\S]*?)\/\/ <\/screenshot-diagnostics>/.exec(source);
if (!block) throw new Error('the <screenshot-diagnostics> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { screenshotDiagnostic, screenshotFailureKind } = new Function(`${js}\nreturn { screenshotDiagnostic, screenshotFailureKind };`)() as {
  screenshotDiagnostic: (input: {
    blank: boolean;
    timedOut: boolean;
    status: number | null;
    signal: string | null;
    stderr: string;
    elapsedMs: number;
  }) => string;
  screenshotFailureKind: (input: { attempted: boolean; hasScreenshot: boolean; backendHealthy: boolean | null }) => 'screenshot' | 'backend' | null;
};

const input = (overrides: Partial<Parameters<typeof screenshotDiagnostic>[0]> = {}) => ({
  blank: false,
  timedOut: false,
  status: null,
  signal: null,
  stderr: '',
  elapsedMs: 0,
  ...overrides,
});

describe('qa-stream screenshot diagnostics', () => {
  it('reports a browser timeout separately from an external signal', () => {
    expect(screenshotDiagnostic(input({ timedOut: true, signal: 'SIGKILL', elapsedMs: 55_250 }))).toBe(
      'screenshot timed out after 55s (browser process killed)',
    );
    expect(screenshotDiagnostic(input({ signal: 'SIGKILL' }))).toBe('screenshot failed: exit=null signal=SIGKILL');
  });

  it('keeps the blank-page classification stable', () => {
    expect(screenshotDiagnostic(input({ blank: true, timedOut: true }))).toBe('screenshot blank (page load timed out before paint)');
  });

  it('keeps the tail of Chromium diagnostics without leaking an unbounded log', () => {
    const note = screenshotDiagnostic(input({ status: 1, stderr: `${'noise '.repeat(100)} renderer failed` }));
    expect(note).toMatch(/^screenshot failed: exit=1 \| /);
    expect(note).toContain('renderer failed');
    expect(note.length).toBeLessThan(220);
  });

  it('classifies an attempted screenshot failure and keeps backend degradation distinct', () => {
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: false, backendHealthy: null })).toBe('screenshot');
    expect(screenshotFailureKind({ attempted: false, hasScreenshot: false, backendHealthy: null })).toBeNull();
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: false, backendHealthy: false })).toBe('backend');
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: true, backendHealthy: false })).toBe('backend');
  });
});

describe('qa-stream screenshot browser flags', () => {
  it('disables background Chromium services that caused fleet page-load hangs', () => {
    for (const flag of [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
    ]) {
      expect(source).toContain(`'${flag}'`);
    }
  });
});
