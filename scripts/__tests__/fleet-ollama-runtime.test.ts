/**
 * Ollama's runtime drop-in: rendered whole from four flags, separate from the bind, restart only on
 * a byte change.
 *
 * The measured facts these cases encode (2026-09-20): no node set `OLLAMA_NUM_PARALLEL`, so the
 * fleet ceiling was the sum of single streams; a restart unloads every resident model (60-108 s to
 * reload), so a fleet command that restarts on every run is a fleet command nobody re-runs; and the
 * bind step moves aside any drop-in that sets `OLLAMA_HOST`, so the runtime file must never.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRuntimeApplyOutput,
  describeRuntimeTransition,
  OLLAMA_RUNTIME_KEYS,
  OllamaRuntimeFlagError,
  ollamaRuntimeApplyShell,
  ollamaRuntimeDropinContent,
  parseOllamaRuntimeValue,
  planOllamaRuntime,
  RUNTIME_DROPIN,
} from '../lib/fleet-ollama-runtime.js';
import { CANONICAL_BIND_DROPIN, type DropinFile, KNOWN_LEGACY_BIND_DROPINS, systemdNameCompare } from '../lib/fleet-ollama-bind.js';

const envLines = (content: string) => content.split('\n').filter((l) => l.startsWith('Environment='));

describe('the runtime drop-in', () => {
  it('renders each flag alone, and every flag together, in a fixed order', () => {
    expect(envLines(ollamaRuntimeDropinContent({ parallel: 4 }))).toEqual(['Environment="OLLAMA_NUM_PARALLEL=4"']);
    expect(envLines(ollamaRuntimeDropinContent({ keepAlive: '24h' }))).toEqual(['Environment="OLLAMA_KEEP_ALIVE=24h"']);
    expect(envLines(ollamaRuntimeDropinContent({ contextLength: 16384 }))).toEqual(['Environment="OLLAMA_CONTEXT_LENGTH=16384"']);
    expect(envLines(ollamaRuntimeDropinContent({ igpu: true }))).toEqual(['Environment="OLLAMA_IGPU_ENABLE=1"']);
    // `off` is a real setting — an explicit 0 on a node where something else turned it on.
    expect(envLines(ollamaRuntimeDropinContent({ igpu: false }))).toEqual(['Environment="OLLAMA_IGPU_ENABLE=0"']);
    expect(envLines(ollamaRuntimeDropinContent({ parallel: 4, keepAlive: '24h', contextLength: 16384, igpu: true }))).toEqual([
      'Environment="OLLAMA_NUM_PARALLEL=4"',
      'Environment="OLLAMA_KEEP_ALIVE=24h"',
      'Environment="OLLAMA_CONTEXT_LENGTH=16384"',
      'Environment="OLLAMA_IGPU_ENABLE=1"',
    ]);
  });

  it('leaves an unset key out entirely rather than writing an empty value', () => {
    // `--ollama-parallel unset` must not become `OLLAMA_NUM_PARALLEL=` — an empty assignment is a
    // value, and Ollama would refuse to start on it.
    const content = ollamaRuntimeDropinContent({ parallel: undefined, keepAlive: '24h' });
    expect(content).not.toContain('OLLAMA_NUM_PARALLEL');
    expect(envLines(content)).toEqual(['Environment="OLLAMA_KEEP_ALIVE=24h"']);
    // Every key left out is still a valid, empty [Service] section.
    expect(envLines(ollamaRuntimeDropinContent({}))).toEqual([]);
    expect(ollamaRuntimeDropinContent({})).toContain('[Service]');
  });

  it('never mentions the bind, so the bind step never moves it aside', () => {
    // The bind shell renames any *.conf whose Environment= lines set OLLAMA_HOST and nothing the
    // canonical file lacks. A runtime file that mentioned it would be renamed out from under Ollama.
    for (const settings of [{}, { parallel: 4 }, { parallel: 4, keepAlive: '24h', contextLength: 8192, igpu: false }]) {
      expect(ollamaRuntimeDropinContent(settings)).not.toContain('OLLAMA_HOST');
      expect(ollamaRuntimeApplyShell(settings)).not.toMatch(/Environment=.*OLLAMA_HOST/);
    }
    expect(RUNTIME_DROPIN).not.toBe(CANONICAL_BIND_DROPIN);
  });

  it('sorts after every legacy name seen on the fleet, like the bind file', () => {
    for (const legacy of KNOWN_LEGACY_BIND_DROPINS) {
      expect(systemdNameCompare(RUNTIME_DROPIN, legacy), `${RUNTIME_DROPIN} must sort after ${legacy}`).toBe(1);
    }
    expect(systemdNameCompare(RUNTIME_DROPIN, 'zzzz-anything.conf')).toBe(1);
  });
});

describe('parseOllamaRuntimeValue', () => {
  it('accepts each flag’s real values and `unset` for all of them', () => {
    expect(parseOllamaRuntimeValue('--ollama-parallel', '4')).toBe(4);
    expect(parseOllamaRuntimeValue('--ollama-context', '16384')).toBe(16384);
    expect(parseOllamaRuntimeValue('--ollama-keep-alive', '24h')).toBe('24h');
    expect(parseOllamaRuntimeValue('--ollama-keep-alive', '1h30m')).toBe('1h30m');
    expect(parseOllamaRuntimeValue('--ollama-keep-alive', '-1')).toBe('-1');
    expect(parseOllamaRuntimeValue('--ollama-igpu', 'on')).toBe(true);
    expect(parseOllamaRuntimeValue('--ollama-igpu', 'off')).toBe(false);
    for (const flag of ['--ollama-parallel', '--ollama-context', '--ollama-keep-alive', '--ollama-igpu'] as const) {
      expect(parseOllamaRuntimeValue(flag, 'unset')).toBeUndefined();
    }
  });

  it('refuses nonsense before any machine is dialled', () => {
    expect(() => parseOllamaRuntimeValue('--ollama-parallel', '0')).toThrow(OllamaRuntimeFlagError);
    expect(() => parseOllamaRuntimeValue('--ollama-parallel', 'four')).toThrow(/between 1 and 64/);
    expect(() => parseOllamaRuntimeValue('--ollama-context', '100')).toThrow(/between 512 and/);
    expect(() => parseOllamaRuntimeValue('--ollama-keep-alive', 'forever')).toThrow(/duration such as 24h/);
    expect(() => parseOllamaRuntimeValue('--ollama-igpu', 'yes')).toThrow(/on, off or 'unset'/);
  });
});

const file = (name: string, ...lines: string[]): DropinFile => ({ name, content: ['[Service]', ...lines].join('\n') });

describe('planOllamaRuntime', () => {
  it('writes and restarts when the file is absent, and reads the current values from systemctl show', () => {
    const plan = planOllamaRuntime([file('override.conf', 'Environment="OLLAMA_HOST=0.0.0.0"')], 'OLLAMA_HOST=0.0.0.0 OLLAMA_KEEP_ALIVE=5m', {
      parallel: 4,
      keepAlive: '24h',
    });
    expect(plan.file.action).toBe('write');
    expect(plan.restart).toBe(true);
    expect(plan.noop).toBe(false);
    expect(plan.current).toEqual({ OLLAMA_KEEP_ALIVE: '5m' });
    expect(plan.target).toEqual({ OLLAMA_NUM_PARALLEL: '4', OLLAMA_KEEP_ALIVE: '24h' });
    expect(plan.summary[0]).toContain(`write ${RUNTIME_DROPIN} with OLLAMA_NUM_PARALLEL=4 OLLAMA_KEEP_ALIVE=24h`);
  });

  it('is a no-op — no write, no restart — when the file already carries these exact settings', () => {
    // The probe's cat+echo framing drops the trailing newline; the comparison must not care.
    const onDisk: DropinFile = { name: RUNTIME_DROPIN, content: ollamaRuntimeDropinContent({ parallel: 4 }).trimEnd() };
    const plan = planOllamaRuntime([onDisk], 'OLLAMA_NUM_PARALLEL=4', { parallel: 4 });
    expect(plan.file.action).toBe('unchanged');
    expect(plan.restart).toBe(false);
    expect(plan.noop).toBe(true);
    expect(plan.summary[0]).toContain('ollama not restarted');
  });

  it('is not a no-op when the file matches but the daemon runs something else', () => {
    // The reviewer's shape: the file is on disk and byte-identical, and `systemctl show` has no
    // OLLAMA_NUM_PARALLEL at all — a run cut off before daemon-reload. Skipping the apply because the
    // bytes match would report a node that serves one sequence as adopted.
    const onDisk: DropinFile = { name: RUNTIME_DROPIN, content: ollamaRuntimeDropinContent({ parallel: 4 }).trimEnd() };
    const plan = planOllamaRuntime([onDisk], 'OLLAMA_HOST=0.0.0.0:11434', { parallel: 4 });
    expect(plan.file.action).toBe('unchanged');
    expect(plan.noop).toBe(false);
    expect(plan.unresolved).toEqual(['OLLAMA_NUM_PARALLEL']);
    expect(plan.summary[0]).toBe(
      `re-read ${RUNTIME_DROPIN} (already carries OLLAMA_NUM_PARALLEL) — systemd resolves OLLAMA_NUM_PARALLEL=<unset>: restart ollama if it never loaded the file, otherwise fail naming what overrides it`,
    );
    // A later drop-in that wins with a different value: same verdict, and the file is named too.
    const outranked = planOllamaRuntime([onDisk, file('zzzzzz-manual.conf', 'Environment="OLLAMA_NUM_PARALLEL=1"')], 'OLLAMA_NUM_PARALLEL=1', {
      parallel: 4,
    });
    expect(outranked.noop).toBe(false);
    expect(outranked.unresolved).toEqual(['OLLAMA_NUM_PARALLEL']);
    expect(outranked.outranked).toEqual([{ key: 'OLLAMA_NUM_PARALLEL', by: 'zzzzzz-manual.conf' }]);
    // A later drop-in that happens to set the same value: the daemon runs what was asked, so nothing to run — still named.
    const agrees = planOllamaRuntime([onDisk, file('zzzzzz-manual.conf', 'Environment="OLLAMA_NUM_PARALLEL=4"')], 'OLLAMA_NUM_PARALLEL=4', {
      parallel: 4,
    });
    expect(agrees.noop).toBe(true);
    expect(agrees.outranked).toHaveLength(1);
  });

  it('rewrites when a flag changed, even by one key', () => {
    const onDisk: DropinFile = { name: RUNTIME_DROPIN, content: ollamaRuntimeDropinContent({ parallel: 4 }) };
    expect(planOllamaRuntime([onDisk], undefined, { parallel: 4, keepAlive: '24h' }).restart).toBe(true);
    expect(planOllamaRuntime([onDisk], undefined, { parallel: 2 }).restart).toBe(true);
    // Every key left out: the file becomes header-only, and that is a change worth a restart.
    expect(planOllamaRuntime([onDisk], undefined, {}).restart).toBe(true);
  });

  it('names a later drop-in that would outrank a managed key, and ignores one that sorts before', () => {
    const files = [
      file('zz-ci-ollama-context.conf', 'Environment="OLLAMA_CONTEXT_LENGTH=32768"'),
      file('zzzzzz-manual.conf', 'Environment="OLLAMA_NUM_PARALLEL=1"'),
    ];
    const plan = planOllamaRuntime(files, undefined, { parallel: 4, contextLength: 16384 });
    expect(plan.outranked).toEqual([{ key: 'OLLAMA_NUM_PARALLEL', by: 'zzzzzz-manual.conf' }]);
    expect(plan.summary.some((l) => l.startsWith('CANNOT WIN OLLAMA_NUM_PARALLEL: zzzzzz-manual.conf'))).toBe(true);
  });
});

describe('describeRuntimeTransition', () => {
  it('shows was → is per managed key, and only the managed keys unless another one moved', () => {
    expect(describeRuntimeTransition({}, { OLLAMA_NUM_PARALLEL: '4' }, { parallel: 4 })).toBe('OLLAMA_NUM_PARALLEL <unset> → 4');
    expect(
      describeRuntimeTransition(
        { OLLAMA_NUM_PARALLEL: '4', OLLAMA_KEEP_ALIVE: '5m' },
        { OLLAMA_NUM_PARALLEL: '4', OLLAMA_KEEP_ALIVE: '5m' },
        { parallel: 4 },
      ),
    ).toBe('OLLAMA_NUM_PARALLEL 4');
    // A key this run stopped managing, whose value went away with the rewrite, is worth a cell.
    expect(describeRuntimeTransition({ OLLAMA_KEEP_ALIVE: '24h' }, {}, { parallel: 4 })).toBe(
      'OLLAMA_NUM_PARALLEL <unset>, OLLAMA_KEEP_ALIVE 24h → <unset>',
    );
  });
});

describe('classifyRuntimeApplyOutput', () => {
  const before = 'ollama-runtime-before: OLLAMA_HOST=0.0.0.0:11434 PATH=/usr/bin';
  it('keys the outcome on markers, and verifies every managed key against what systemd resolved', () => {
    const ok = classifyRuntimeApplyOutput(
      [
        before,
        'ollama-runtime-written: zzzzz-cihub-runtime.conf now carries OLLAMA_NUM_PARALLEL=4; ollama restarted',
        'ollama-runtime-after: OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=4',
        'ollama-runtime-complete',
      ].join('\n'),
      '',
      { parallel: 4 },
    );
    expect(ok.outcome).toBe('applied');
    expect(ok.transition).toBe('OLLAMA_NUM_PARALLEL <unset> → 4');

    const same = classifyRuntimeApplyOutput(
      [
        'ollama-runtime-before: OLLAMA_NUM_PARALLEL=4',
        'ollama-runtime-unchanged: zzzzz-cihub-runtime.conf already carries OLLAMA_NUM_PARALLEL=4; ollama not restarted',
        'ollama-runtime-after: OLLAMA_NUM_PARALLEL=4',
        'ollama-runtime-complete',
      ].join('\n'),
      '',
      { parallel: 4 },
    );
    expect(same.outcome).toBe('unchanged');
    expect(same.transition).toBe('OLLAMA_NUM_PARALLEL 4');

    // The file was written and the daemon restarted, and a later drop-in still won. That is the
    // state this check exists to catch — "the drop-in is there" while Ollama serves one sequence.
    const lost = classifyRuntimeApplyOutput(
      [before, 'ollama-runtime-written: …', 'ollama-runtime-after: OLLAMA_NUM_PARALLEL=1', 'ollama-runtime-complete'].join('\n'),
      '',
      { parallel: 4 },
    );
    expect(lost.outcome).toBe('mismatch');
    expect(lost.why).toContain('requested OLLAMA_NUM_PARALLEL=4 but systemd resolved OLLAMA_NUM_PARALLEL=1');

    expect(
      classifyRuntimeApplyOutput("ollama-bind-refused: ollama-local.service under ci's systemd --user (pid 2417) already owns :11434", '', {
        parallel: 4,
      }).outcome,
    ).toBe('refused');
    expect(classifyRuntimeApplyOutput('installing…', '', { parallel: 4 }).outcome).toBe('incomplete');
  });

  it('does not hold an unset key to any value', () => {
    // `--ollama-context unset` leaves the key to another drop-in; whatever that resolves to is fine.
    const out = [
      'ollama-runtime-before: OLLAMA_CONTEXT_LENGTH=32768',
      'ollama-runtime-written: …',
      'ollama-runtime-after: OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_NUM_PARALLEL=4',
      'ollama-runtime-complete',
    ].join('\n');
    expect(classifyRuntimeApplyOutput(out, '', { parallel: 4 }).outcome).toBe('applied');
  });
});

/**
 * The real apply shell in a sandbox: a temp drop-in directory and a stub `systemctl` that logs its
 * calls and answers `show` from a file the test controls. This is where "unchanged file → no
 * restart" is proven rather than asserted about a string.
 */
const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
describe.skipIf(!bash)('ollamaRuntimeApplyShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sandbox() {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-runtime-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const dropins = path.join(root, 'ollama.service.d');
    mkdirSync(bin);
    mkdirSync(dropins);
    const log = path.join(root, 'calls.log');
    const shown = path.join(root, 'environment');
    writeFileSync(shown, 'OLLAMA_HOST=0.0.0.0:11434 PATH=/usr/bin');
    const stub = (name: string, body: string) => {
      const p = path.join(bin, name);
      writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(p, 0o755);
    };
    // `show` answers whatever the test last wrote to the environment file; `daemon-reload` "merges"
    // the drop-in by appending its Environment= lines, which is what a real reload would resolve.
    // `NeedDaemonReload` is `yes` while the test's flag file exists, and a reload clears it.
    const needReload = path.join(root, 'need-daemon-reload');
    stub(
      'systemctl',
      [
        'case "$*" in',
        `  *"-p Environment"*) echo "Environment=$(cat "${shown}")" ;;`,
        `  *"-p NeedDaemonReload"*) [ -f "${needReload}" ] && echo yes || echo no ;;`,
        `  daemon-reload) rm -f "${needReload}"; for f in "${dropins}"/*.conf; do [ -f "$f" ] || continue; sed -n 's/^Environment="\\(.*\\)"$/\\1/p' "$f"; done | tr '\\n' ' ' | sed "s#^#$(cat "${shown}") #" > "${shown}.new"; mv "${shown}.new" "${shown}" ;;`,
        'esac',
      ].join('\n'),
    );
    stub('ss', 'echo "LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*"');
    stub('loginctl', ':');
    return { root, bin, dropins, log, shown, needReload, calls: () => readFileSync(log, 'utf-8') };
  }

  function run(script: string, box: { bin: string; dropins: string }) {
    return spawnSync(bash as string, ['-e', '-c', script], {
      env: { PATH: `${box.bin}:/usr/bin:/bin`, CIHUB_BIND_DIR: box.dropins, HOME: '/tmp' },
      encoding: 'utf-8',
    });
  }

  it('writes the file, reloads and restarts once; the second run touches nothing and restarts nothing', () => {
    const box = sandbox();
    const first = run(ollamaRuntimeApplyShell({ parallel: 4, keepAlive: '24h' }), box);
    expect(first.status, first.stderr).toBe(0);
    const outcome = classifyRuntimeApplyOutput(first.stdout, first.stderr, { parallel: 4, keepAlive: '24h' });
    expect(outcome.outcome).toBe('applied');
    expect(outcome.transition).toBe('OLLAMA_NUM_PARALLEL <unset> → 4, OLLAMA_KEEP_ALIVE <unset> → 24h');
    const written = path.join(box.dropins, RUNTIME_DROPIN);
    expect(readFileSync(written, 'utf-8')).toBe(ollamaRuntimeDropinContent({ parallel: 4, keepAlive: '24h' }));
    expect(statSync(written).mode & 0o777).toBe(0o644);
    expect(box.calls()).toMatch(/systemctl daemon-reload\n[\s\S]*systemctl restart ollama\n/);
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(1);

    const again = run(ollamaRuntimeApplyShell({ parallel: 4, keepAlive: '24h' }), box);
    expect(again.status, again.stderr).toBe(0);
    const second = classifyRuntimeApplyOutput(again.stdout, again.stderr, { parallel: 4, keepAlive: '24h' });
    expect(second.outcome).toBe('unchanged');
    expect(second.why).toContain('ollama not restarted');
    // Still exactly one restart and one reload across both runs.
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(1);
    expect((box.calls().match(/systemctl daemon-reload\n/g) ?? []).length).toBe(1);
  });

  it('a changed flag rewrites and restarts; a key dropped from the flags leaves the file', () => {
    const box = sandbox();
    run(ollamaRuntimeApplyShell({ parallel: 4, keepAlive: '24h' }), box);
    // Reset what "systemd" would show so the merge reflects only the new file.
    writeFileSync(box.shown, 'OLLAMA_HOST=0.0.0.0:11434');
    const res = run(ollamaRuntimeApplyShell({ parallel: 2 }), box);
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyRuntimeApplyOutput(res.stdout, res.stderr, { parallel: 2 });
    expect(outcome.outcome).toBe('applied');
    expect(readFileSync(path.join(box.dropins, RUNTIME_DROPIN), 'utf-8')).not.toContain('OLLAMA_KEEP_ALIVE');
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(2);
  });

  it('reloads and restarts an unchanged file systemd never loaded, and fails one a later drop-in overrides', () => {
    const box = sandbox();
    // A run cut off between `install` and `daemon-reload`: the file is there, the daemon runs the old
    // environment, and systemd says so.
    writeFileSync(path.join(box.dropins, RUNTIME_DROPIN), ollamaRuntimeDropinContent({ parallel: 4 }));
    writeFileSync(box.needReload, '');
    const cut = run(ollamaRuntimeApplyShell({ parallel: 4 }), box);
    expect(cut.status, cut.stderr).toBe(0);
    const recovered = classifyRuntimeApplyOutput(cut.stdout, cut.stderr, { parallel: 4 });
    expect(recovered.outcome).toBe('applied');
    expect(recovered.why).toContain('systemd had not loaded it; ollama restarted');
    expect(recovered.transition).toBe('OLLAMA_NUM_PARALLEL <unset> → 4');
    expect(box.calls()).toMatch(/systemctl daemon-reload\n[\s\S]*systemctl restart ollama\n/);
    expect(existsSync(box.needReload)).toBe(false);

    // A reload pending for some other reason while every managed key is already in effect: not
    // worth unloading the models over.
    writeFileSync(box.needReload, '');
    const pending = run(ollamaRuntimeApplyShell({ parallel: 4 }), box);
    expect(pending.status, pending.stderr).toBe(0);
    expect(classifyRuntimeApplyOutput(pending.stdout, pending.stderr, { parallel: 4 }).outcome).toBe('unchanged');
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(1);
    rmSync(box.needReload);

    // Same file, loaded, and now something after it resolves the key to 1: no restart helps, so the
    // node fails with the reason rather than reading as adopted because the bytes matched.
    writeFileSync(box.shown, 'OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=1');
    const lost = run(ollamaRuntimeApplyShell({ parallel: 4 }), box);
    expect(lost.status, lost.stderr).toBe(0);
    const outcome = classifyRuntimeApplyOutput(lost.stdout, lost.stderr, { parallel: 4 });
    expect(outcome.outcome).toBe('mismatch');
    expect(outcome.why).toContain('requested OLLAMA_NUM_PARALLEL=4 but systemd resolved OLLAMA_NUM_PARALLEL=1');
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(1);
  });

  it('refuses, touching nothing, when a user-scope unit owns the port', () => {
    const box = sandbox();
    // beta-1: the pid on :11434 lives under user@1000.service. Same guard as the bind step.
    const p = path.join(box.bin, 'ss');
    writeFileSync(p, '#!/bin/sh\necho \'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=2417,fd=3))\'\n');
    chmodSync(p, 0o755);
    const fakeProc = path.join(box.root, 'proc');
    mkdirSync(path.join(fakeProc, '2417'), { recursive: true });
    writeFileSync(path.join(fakeProc, '2417', 'cgroup'), '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service\n');
    // The guard reads /proc/<pid>/cgroup by absolute path; point `tail` at the sandbox copy.
    writeFileSync(
      path.join(box.bin, 'tail'),
      `#!/bin/sh\ncase "$2" in /proc/*) exec /usr/bin/tail "$1" "${fakeProc}\${2#/proc}" ;; *) exec /usr/bin/tail "$@" ;; esac\n`,
    );
    chmodSync(path.join(box.bin, 'tail'), 0o755);
    writeFileSync(path.join(box.bin, 'stat'), '#!/bin/sh\necho ci\n');
    chmodSync(path.join(box.bin, 'stat'), 0o755);

    const res = run(ollamaRuntimeApplyShell({ parallel: 4 }), box);
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyRuntimeApplyOutput(res.stdout, res.stderr, { parallel: 4 });
    expect(outcome.outcome).toBe('refused');
    expect(outcome.why).toContain("ollama-local.service under ci's systemd --user");
    expect(existsSync(path.join(box.dropins, RUNTIME_DROPIN))).toBe(false);
    expect(existsSync(box.log) ? box.calls() : '').not.toContain('systemctl');
  });
});

describe('OLLAMA_RUNTIME_KEYS', () => {
  it('are the four the audit asked for, and nothing about the bind', () => {
    expect([...OLLAMA_RUNTIME_KEYS]).toEqual(['OLLAMA_NUM_PARALLEL', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_IGPU_ENABLE']);
  });
});
