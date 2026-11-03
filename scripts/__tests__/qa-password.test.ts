import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts is copied as a single file to fleet nodes, so exercise the exact inline generator
// without importing qa-stream.ts (which starts its worker when loaded).
const qaStreamSource = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <qa-password-generator>([\s\S]*?)\/\/ <\/qa-password-generator>/.exec(qaStreamSource);
if (!block) throw new Error('the <qa-password-generator> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { makeQaPassword } = new Function('randomBytes', 'randomInt', `${js}\nreturn { makeQaPassword };`)(randomBytes, randomInt) as {
  makeQaPassword: (spec?: { min?: number; max?: number }) => string;
};

describe('makeQaPassword', () => {
  it('meets common password complexity rules without shell-sensitive punctuation', () => {
    const password = makeQaPassword();

    expect(password).toHaveLength(32);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('respects declared minimum and maximum lengths', () => {
    expect(makeQaPassword({ min: 8, max: 16 })).toHaveLength(16);
    expect(makeQaPassword({ min: 40, max: 64 })).toHaveLength(40);
    expect(makeQaPassword({ min: 8, max: 12 })).toHaveLength(12);
    expect(makeQaPassword({ min: 129 })).toHaveLength(129);
  });

  it('keeps all three character classes random even at the minimum supported length', () => {
    const password = makeQaPassword({ min: 3, max: 3 });

    expect(password).toHaveLength(3);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
  });

  it('rejects impossible field bounds instead of silently violating the manifest', () => {
    expect(() => makeQaPassword({ min: 20, max: 12 })).toThrow(RangeError);
    expect(() => makeQaPassword({ max: 2 })).toThrow(RangeError);
  });

  it('uses fresh random material for each generated value', () => {
    expect(makeQaPassword()).not.toBe(makeQaPassword());
  });

  it('wires password form fields and password-named variables to the generator', () => {
    expect(qaStreamSource).toContain("if (spec?.type === 'password' || /PASSWORD/.test(name)) v = makeQaPassword(spec);");
  });
});
