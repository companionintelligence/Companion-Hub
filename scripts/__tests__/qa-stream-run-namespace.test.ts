import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// qa-stream.ts starts Docker work when imported, so keep this contract test source-level. The
// fleet runner supplies the run marker to every remote worker and relies on these names being
// unique to that run.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');

describe('qa-stream run-scoped Docker resource names', () => {
  it('derives a sanitized namespace from the fleet run token', () => {
    expect(source).toContain("process.env.QA_RUN_TOKEN?.trim() || QA_RUN_PID_FILE.match(/fleet-qa-run-(\\d+)/)?.[1] || ''");
    expect(source).toContain(".replace(/[^A-Za-z0-9_.-]/g, '')");
    expect(source).toContain('function qaContainerName(appId: string)');
    expect(source).toContain('function qaProjectName(appId: string)');
  });

  it('uses the namespace for both single-container and compose cleanup paths', () => {
    expect(source).toContain('const containerName = qaContainerName(appId);');
    expect(source).toContain('const project = qaProjectName(appId);');
    expect(source).toContain('o.composeProject || qaProjectName(o.appId)');
  });
});
