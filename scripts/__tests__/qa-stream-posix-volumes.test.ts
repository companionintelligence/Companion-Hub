import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts starts its worker when loaded, so evaluate only the pure volume-selection helpers.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <single-service-managed-volumes>([\s\S]*?)\/\/ <\/single-service-managed-volumes>/.exec(source);
if (!block) throw new Error('the <single-service-managed-volumes> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { resolveSingleServiceManagedVolume } = new Function('createHash', `${js}\nreturn { resolveSingleServiceManagedVolume };`)(createHash) as {
  resolveSingleServiceManagedVolume: (
    volume: { volumeName?: string; requiresPosixPermissions?: boolean },
    containerName: string,
    hostPath: string,
    seeded: boolean,
    fallback: boolean,
    managedVolumes: Map<string, string>,
  ) => string | null;
};

describe('single-service managed volumes', () => {
  it('uses a run-scoped Docker volume for unseeded POSIX-sensitive data when fallback is enabled', () => {
    const volume = resolveSingleServiceManagedVolume(
      { requiresPosixPermissions: true },
      'qa-stream-123-azuracast',
      '${APP_DATA_DIR}/data/db',
      false,
      true,
      new Map(),
    );

    expect(volume).toMatch(/^qa-qa-stream-123-azuracast-[a-f0-9]{16}$/);
  });

  it('keeps Linux bind mounts and seeded data on the existing scratch path', () => {
    const input = { requiresPosixPermissions: true };
    expect(resolveSingleServiceManagedVolume(input, 'qa-stream-123-app', '${APP_DATA_DIR}/data', false, false, new Map())).toBeNull();
    expect(resolveSingleServiceManagedVolume(input, 'qa-stream-123-app', '${APP_DATA_DIR}/data', true, true, new Map())).toBeNull();
  });

  it('scopes explicit volume names to the QA container run', () => {
    const first = resolveSingleServiceManagedVolume({ volumeName: 'app-data' }, 'qa-stream-123-app', '', false, false, new Map());
    const nextRun = resolveSingleServiceManagedVolume({ volumeName: 'app-data' }, 'qa-stream-456-app', '', false, false, new Map());

    expect(first).toMatch(/^qa-qa-stream-123-app-[a-f0-9]{16}$/);
    expect(nextRun).not.toBe(first);
  });

  it('reuses a managed volume for repeated declarations of the same source path', () => {
    const volumes = new Map<string, string>();
    const one = resolveSingleServiceManagedVolume(
      { requiresPosixPermissions: true },
      'qa-stream-123-app',
      '${APP_DATA_DIR}/data',
      false,
      true,
      volumes,
    );
    const two = resolveSingleServiceManagedVolume(
      { requiresPosixPermissions: true },
      'qa-stream-123-app',
      '${APP_DATA_DIR}/data',
      false,
      true,
      volumes,
    );

    expect(two).toBe(one);
    expect(volumes).toHaveLength(1);
  });
});

describe('single-service volume cleanup wiring', () => {
  it('mounts managed volumes and removes them with the QA container', () => {
    expect(source).toContain('--mount ${shQuote(`type=volume,source=${managedVolume},target=${v.containerPath}${readonly}`)}');
    expect(source).toContain("docker volume rm -f ${managedVolumes.map(shq).join(' ')}");
    expect(source).toContain('verifyQaResourceCleanup(execAsync, project, o.containerName, managedVolumes)');
  });
});
