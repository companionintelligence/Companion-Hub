import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts runs its worker immediately when loaded, so extract the pure classifier instead of
// importing the runner. This keeps the test fast and prevents a unit test from touching Docker.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <compose-transient>([\s\S]*?)\/\/ <\/compose-transient>/.exec(source);
if (!block) throw new Error('the <compose-transient> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { isRetryableComposeFailure } = new Function(`${js}\nreturn { isRetryableComposeFailure };`)() as {
  isRetryableComposeFailure: (text: string) => boolean;
};

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
    expect(isRetryableComposeFailure('failed to bind host port 1234: address already in use')).toBe(false);
    expect(isRetryableComposeFailure('failed to authorize: 429 Too Many Requests')).toBe(false);
    expect(isRetryableComposeFailure('manifest unknown: image not found')).toBe(false);
    expect(isRetryableComposeFailure('invalid compose file: service has no image')).toBe(false);
  });
});

describe('qa-stream retry wiring', () => {
  it('records the first compose attempt and uses the narrow classifier', () => {
    expect(source).toContain("result.failKind === 'compose' && isRetryableComposeFailure(String(result.notes ?? ''))");
    expect(source).toContain('firstAttemptFailKind');
    expect(source).toContain('composeFailureSnapshot');
  });
});
