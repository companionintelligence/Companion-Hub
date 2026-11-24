import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts starts its worker when loaded, so keep the capacity policy pure and test it without
// touching Docker or the host filesystem.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <capacity-guard>([\s\S]*?)\/\/ <\/capacity-guard>/.exec(source);
if (!block) throw new Error('the <capacity-guard> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { capacityDecision } = new Function(`${js}\nreturn { capacityDecision };`)() as {
  capacityDecision: (input: { availableBytes: number; totalBytes: number; minFreeMb: number; minFreePercent: number }) => {
    ok: boolean;
    availableMb: number;
    totalMb: number;
    freePercent: number | null;
    thresholdMb: number;
  };
};

describe('capacityDecision', () => {
  it('blocks a full filesystem before the next app is dispatched', () => {
    expect(
      capacityDecision({
        availableBytes: 0,
        totalBytes: 1_000 * 1024 * 1024,
        minFreeMb: 4096,
        minFreePercent: 5,
      }),
    ).toMatchObject({ ok: false, availableMb: 0, thresholdMb: 4096 });
  });

  it('uses the larger of the absolute and percentage reserve', () => {
    expect(
      capacityDecision({
        availableBytes: 70 * 1024 * 1024 * 1024,
        totalBytes: 2 * 1024 * 1024 * 1024 * 1024,
        minFreeMb: 4096,
        minFreePercent: 5,
      }),
    ).toMatchObject({ ok: false, availableMb: 70 * 1024, thresholdMb: 104858 });
  });

  it('allows a healthy node with headroom above both reserves', () => {
    expect(
      capacityDecision({
        availableBytes: 400 * 1024 * 1024 * 1024,
        totalBytes: 1 * 1024 * 1024 * 1024 * 1024,
        minFreeMb: 4096,
        minFreePercent: 5,
      }).ok,
    ).toBe(true);
  });
});

describe('qa-stream capacity wiring', () => {
  it('emits a node condition and uses a distinct exit code instead of an app error', () => {
    expect(source).toContain("event: 'node_capacity'");
    expect(source).toContain("capacityEvent(capacity, 'capacity guard stopped dispatch', appId)");
    expect(source).toContain("capacityEvent(initialCapacity, 'capacity guard stopped before results reset')");
    expect(source).toContain('process.exitCode = 75');
    expect(source).toContain('process.exit(capacityBlocked ? 75 : 0)');
  });
});
