import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// qa-stream.ts starts Docker work when imported, so keep this contract test source-level. The
// fleet runner copies this file to remote nodes and relies on these exact control-plane hooks.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');

describe('qa-stream graceful stop contract', () => {
  it('writes a per-run PID marker and removes only its own marker on exit', () => {
    expect(source).toContain("const QA_RUN_PID_FILE = process.env.QA_RUN_PID_FILE?.trim() ?? '';");
    expect(source).toContain("const RUN_PID_PATH = QA_RUN_PID_FILE.startsWith('~/') ? join(home, QA_RUN_PID_FILE.slice(2)) : QA_RUN_PID_FILE;");
    expect(source).toContain('writeFileSync(RUN_PID_PATH, `${process.pid}\\n`);');
    expect(source).toContain("readFileSync(RUN_PID_PATH, 'utf8').trim() === String(process.pid)");
    expect(source).toContain('unlinkSync(RUN_PID_PATH)');
  });

  it('turns SIGTERM/SIGINT into a drain request instead of killing Docker teardown', () => {
    expect(source).toContain("process.once('SIGTERM', requestGracefulStop);");
    expect(source).toContain("process.once('SIGINT', requestGracefulStop);");
    expect(source).toContain('if (stopRequested) return null;');
    expect(source).toContain('stopped: stopRequested');
  });
});
