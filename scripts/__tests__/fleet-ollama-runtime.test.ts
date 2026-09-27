/**
 * Ollama's runtime drop-in: rendered whole from five flags, separate from the bind, restart only on
 * a byte change.
 *
 * The measured facts these cases encode (2026-09-20): no node set `OLLAMA_NUM_PARALLEL`, so the
 * fleet ceiling was the sum of single streams; a restart unloads every resident model (60-108 s to
 * reload), so a fleet command that restarts on every run is a fleet command nobody re-runs; and the
 * bind step moves aside any drop-in that sets `OLLAMA_HOST`, so the runtime file must never. And
 * (2026-09-21) a 24h keep-alive with no resident-model cap filled 122/123 GB on core-7 and had the
 * kernel OOM-kill llama-server on core-17, so `OLLAMA_MAX_LOADED_MODELS` is the fifth key.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyHubContextCapOutput,
  HUB_OLLAMA_SLOTS_SETTING,
  classifyRuntimeApplyOutput,
  describeHubContextCapPlan,
  describeRuntimeEnvironment,
  describeRuntimeTransition,
  HUB_CONTEXT_CAP_MARKERS,
  hubContextCapShell,
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
    expect(envLines(ollamaRuntimeDropinContent({ maxLoaded: 2 }))).toEqual(['Environment="OLLAMA_MAX_LOADED_MODELS=2"']);
    expect(envLines(ollamaRuntimeDropinContent({ parallel: 4, keepAlive: '24h', contextLength: 16384, igpu: true, maxLoaded: 2 }))).toEqual([
      'Environment="OLLAMA_NUM_PARALLEL=4"',
      'Environment="OLLAMA_KEEP_ALIVE=24h"',
      'Environment="OLLAMA_CONTEXT_LENGTH=16384"',
      'Environment="OLLAMA_IGPU_ENABLE=1"',
      'Environment="OLLAMA_MAX_LOADED_MODELS=2"',
    ]);
  });

  it('leaves an unset key out entirely rather than writing an empty value', () => {
    // `--ollama-parallel unset` must not become `OLLAMA_NUM_PARALLEL=` — an empty assignment is a
    // value, and Ollama would refuse to start on it.
    const content = ollamaRuntimeDropinContent({ parallel: undefined, keepAlive: '24h' });
    expect(content).not.toContain('OLLAMA_NUM_PARALLEL');
    expect(envLines(content)).toEqual(['Environment="OLLAMA_KEEP_ALIVE=24h"']);
    // A run without --ollama-max-loaded renders no cap: the key falls back to Ollama's default, which
    // is why the docs say to pass it on every run that manages it.
    expect(ollamaRuntimeDropinContent({ parallel: 4, keepAlive: '24h' })).not.toContain('OLLAMA_MAX_LOADED_MODELS');
    expect(ollamaRuntimeDropinContent({ maxLoaded: undefined, keepAlive: '24h' })).not.toContain('OLLAMA_MAX_LOADED_MODELS');
    // Every key left out is still a valid, empty [Service] section.
    expect(envLines(ollamaRuntimeDropinContent({}))).toEqual([]);
    expect(ollamaRuntimeDropinContent({})).toContain('[Service]');
  });

  it('keeps the header byte-identical to the file the four-flag CLI wrote, so adding the fifth key restarts nothing by itself', () => {
    // The plan and the apply shell both compare the whole file. A reworded header would make every
    // node's on-disk file "changed" on the next run of the same flags, and restart every Ollama on
    // the fleet for a comment.
    const header = ollamaRuntimeDropinContent({})
      .split('\n')
      .filter((l) => l.startsWith('#'));
    expect(header).toEqual([
      '# Managed by cihub fleet — Ollama runtime settings on this node. The bind lives in its own file.',
      '# Rendered whole from the --ollama-parallel / --ollama-keep-alive / --ollama-context / --ollama-igpu',
      "# flags of 'cihub fleet backends --execute'; a key not listed here is not managed by cihub.",
    ]);
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
    expect(parseOllamaRuntimeValue('--ollama-max-loaded', '2')).toBe(2);
    expect(parseOllamaRuntimeValue('--ollama-max-loaded', '1')).toBe(1);
    expect(parseOllamaRuntimeValue('--ollama-max-loaded', '16')).toBe(16);
    // One call per flag: the overloads take a literal flag name each, not a union.
    expect(parseOllamaRuntimeValue('--ollama-parallel', 'unset')).toBeUndefined();
    expect(parseOllamaRuntimeValue('--ollama-context', 'unset')).toBeUndefined();
    expect(parseOllamaRuntimeValue('--ollama-keep-alive', 'unset')).toBeUndefined();
    expect(parseOllamaRuntimeValue('--ollama-igpu', 'unset')).toBeUndefined();
    expect(parseOllamaRuntimeValue('--ollama-max-loaded', 'unset')).toBeUndefined();
  });

  it('refuses nonsense before any machine is dialled', () => {
    expect(() => parseOllamaRuntimeValue('--ollama-parallel', '0')).toThrow(OllamaRuntimeFlagError);
    expect(() => parseOllamaRuntimeValue('--ollama-parallel', 'four')).toThrow(/between 1 and 64/);
    expect(() => parseOllamaRuntimeValue('--ollama-context', '100')).toThrow(/between 512 and/);
    expect(() => parseOllamaRuntimeValue('--ollama-keep-alive', 'forever')).toThrow(/duration such as 24h/);
    expect(() => parseOllamaRuntimeValue('--ollama-igpu', 'yes')).toThrow(/on, off or 'unset'/);
    // 0 is not "no cap" to Ollama — it means 3 × GPU count, the default that filled core-7. The way
    // to hand the key back is `unset`, so 0 is refused rather than written.
    expect(() => parseOllamaRuntimeValue('--ollama-max-loaded', '0')).toThrow(/--ollama-max-loaded must be an integer between 1 and 16/);
    expect(() => parseOllamaRuntimeValue('--ollama-max-loaded', '17')).toThrow(/between 1 and 16/);
    expect(() => parseOllamaRuntimeValue('--ollama-max-loaded', 'two')).toThrow(OllamaRuntimeFlagError);
    expect(() => parseOllamaRuntimeValue('--ollama-max-loaded', '1.5')).toThrow(OllamaRuntimeFlagError);
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

  it('adds the resident-model cap to a file the four-flag CLI wrote, then leaves it alone on the next run', () => {
    // The batch tier as the fleet runs it: 2 slots × 32k with a 24h keep-alive, written before the
    // cap existed. Adding --ollama-max-loaded 2 is one more key — a write and a restart.
    const tier = { parallel: 2, keepAlive: '24h', contextLength: 32768 };
    const before: DropinFile = { name: RUNTIME_DROPIN, content: ollamaRuntimeDropinContent(tier).trimEnd() };
    const add = planOllamaRuntime([before], 'OLLAMA_NUM_PARALLEL=2 OLLAMA_KEEP_ALIVE=24h OLLAMA_CONTEXT_LENGTH=32768', { ...tier, maxLoaded: 2 });
    expect(add.file.action).toBe('write');
    expect(add.restart).toBe(true);
    expect(add.noop).toBe(false);
    expect(add.current.OLLAMA_MAX_LOADED_MODELS).toBeUndefined();
    expect(add.target.OLLAMA_MAX_LOADED_MODELS).toBe('2');
    expect(add.summary[0]).toContain('OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_MAX_LOADED_MODELS=2, then daemon-reload and restart ollama');

    // The same five flags again, with the daemon running them: nothing to write, nothing to restart.
    const after: DropinFile = { name: RUNTIME_DROPIN, content: ollamaRuntimeDropinContent({ ...tier, maxLoaded: 2 }).trimEnd() };
    const again = planOllamaRuntime([after], 'OLLAMA_NUM_PARALLEL=2 OLLAMA_KEEP_ALIVE=24h OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_MAX_LOADED_MODELS=2', {
      ...tier,
      maxLoaded: 2,
    });
    expect(again.file.action).toBe('unchanged');
    expect(again.restart).toBe(false);
    expect(again.noop).toBe(true);
    expect(again.summary[0]).toContain('OLLAMA_MAX_LOADED_MODELS; ollama not restarted');

    // File in place but the daemon still runs uncapped (a run cut off before daemon-reload): not a no-op.
    const stale = planOllamaRuntime([after], 'OLLAMA_NUM_PARALLEL=2 OLLAMA_KEEP_ALIVE=24h OLLAMA_CONTEXT_LENGTH=32768', { ...tier, maxLoaded: 2 });
    expect(stale.noop).toBe(false);
    expect(stale.unresolved).toEqual(['OLLAMA_MAX_LOADED_MODELS']);

    // The flag dropped from the command line: the key leaves the file, and Ollama's default is back.
    const dropped = planOllamaRuntime([after], undefined, tier);
    expect(dropped.file.action).toBe('write');
    expect(dropped.file.content).not.toContain('OLLAMA_MAX_LOADED_MODELS');
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

describe('describeRuntimeEnvironment', () => {
  it('lists every managed key, set or not, so an inventory line is comparable across nodes', () => {
    // The transition line prints only what a run manages, so a read-only run said nothing at all —
    // which is how OLLAMA_CONTEXT_LENGTH came to run 8192 … 65536 across this fleet unnoticed. The
    // input is the MERGED environment from `systemctl show`, never a drop-in file's own contents.
    expect(describeRuntimeEnvironment({ OLLAMA_CONTEXT_LENGTH: '65536' })).toBe(
      'OLLAMA_NUM_PARALLEL=<unset> OLLAMA_KEEP_ALIVE=<unset> OLLAMA_CONTEXT_LENGTH=65536 OLLAMA_IGPU_ENABLE=<unset> OLLAMA_MAX_LOADED_MODELS=<unset>',
    );
    // Fixed key order, so two nodes' lines line up column for column.
    expect(describeRuntimeEnvironment({ OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_NUM_PARALLEL: '4' })).toBe(
      'OLLAMA_NUM_PARALLEL=4 OLLAMA_KEEP_ALIVE=<unset> OLLAMA_CONTEXT_LENGTH=<unset> OLLAMA_IGPU_ENABLE=<unset> OLLAMA_MAX_LOADED_MODELS=2',
    );
    // A node that sets nothing is still five words, never an empty line.
    expect(describeRuntimeEnvironment({}).split(' ')).toHaveLength(5);
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

  it('adds the resident-model cap to a file written before it existed with one restart, and the next run restarts nothing', () => {
    const box = sandbox();
    // The batch tier as it was on 2026-09-21: keep-alive without a cap, three 27-30B models resident.
    const tier = { parallel: 2, keepAlive: '24h', contextLength: 32768 };
    run(ollamaRuntimeApplyShell(tier), box);
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(1);

    const capped = { ...tier, maxLoaded: 2 };
    const add = run(ollamaRuntimeApplyShell(capped), box);
    expect(add.status, add.stderr).toBe(0);
    const outcome = classifyRuntimeApplyOutput(add.stdout, add.stderr, capped);
    expect(outcome.outcome).toBe('applied');
    expect(outcome.transition).toContain('OLLAMA_MAX_LOADED_MODELS <unset> → 2');
    expect(readFileSync(path.join(box.dropins, RUNTIME_DROPIN), 'utf-8')).toContain('Environment="OLLAMA_MAX_LOADED_MODELS=2"');
    expect((box.calls().match(/systemctl restart ollama\n/g) ?? []).length).toBe(2);

    const again = run(ollamaRuntimeApplyShell(capped), box);
    expect(again.status, again.stderr).toBe(0);
    const second = classifyRuntimeApplyOutput(again.stdout, again.stderr, capped);
    expect(second.outcome).toBe('unchanged');
    expect(second.why).toContain('OLLAMA_MAX_LOADED_MODELS=2; ollama not restarted');
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
  it('are the four the audit asked for plus the resident-model cap, and nothing about the bind', () => {
    expect([...OLLAMA_RUNTIME_KEYS]).toEqual([
      'OLLAMA_NUM_PARALLEL',
      'OLLAMA_KEEP_ALIVE',
      'OLLAMA_CONTEXT_LENGTH',
      'OLLAMA_IGPU_ENABLE',
      'OLLAMA_MAX_LOADED_MODELS',
    ]);
  });
});

// ─── The Hub's half of --ollama-context ────────────────────────────────────────────────────────────

describe('hubContextCapShell', () => {
  const set = hubContextCapShell(16384, '/srv/hub');
  const clear = hubContextCapShell(null, '/srv/hub');

  it('reads the key inside the ci-hub container first, then the host data dir it was given', () => {
    for (const script of [set, clear]) {
      expect(script.indexOf('docker exec ci-hub')).toBeLessThan(script.indexOf("'/srv/hub/state/settings.json'"));
      expect(script).toContain('-H "Authorization: Bearer $cihub_cap_key"');
    }
  });

  it('never echoes the key, and unsets it before the script ends', () => {
    for (const script of [set, clear]) {
      expect(script).not.toMatch(/echo[^\n]*\$cihub_cap_key/);
      expect(script).toContain('unset cihub_cap_key');
      // The response body is parsed, never dumped: a Hub error page cannot carry anything back either.
      expect(script).not.toMatch(/cat\s+"\$cihub_cap_body"/);
      for (const line of script.split('\n').filter((l) => l.trim().startsWith('echo '))) expect(line).not.toMatch(/\$cihub_cap_(key|body)/);
    }
  });

  it('sets through /api/user-settings with the one key, and clears through /api/inference/preferences with the current backend', () => {
    // `/api/user-settings` cannot remove a key, so the clear goes through the preferences route,
    // which requires `backend` — read from the same GET that says what the cap is now.
    expect(set).toContain(`-X PATCH -d '{"inferenceMaxNumCtx":16384}' "$cihub_cap_url/user-settings"`);
    expect(set).not.toContain('"maxNumCtx":null');
    expect(clear).toContain('"preferredBackend"');
    expect(clear).toContain('{\\"backend\\":\\"$cihub_cap_backend\\",\\"maxNumCtx\\":null}');
    expect(clear).toContain('"$cihub_cap_url/inference/preferences"');
    expect(clear).not.toContain('user-settings');
    // A stored preference the script does not recognise — or none — is sent as Ollama, which is
    // what an absent preference already resolves to on the Hub.
    expect(clear).toContain('*) cihub_cap_backend=ollama ;;');
  });

  it('reads the cap before writing, and skips the write when it already reads as requested', () => {
    expect(set.indexOf('"$cihub_cap_url/inference/preferences"')).toBeLessThan(set.indexOf('-X PATCH'));
    expect(set).toContain('if [ "$cihub_cap_now" = 16384 ] || [ "$cihub_cap_now" = absent ]; then');
    expect(clear).toContain('if [ "$cihub_cap_now" = none ] || [ "$cihub_cap_now" = absent ]; then');
    expect(set).toContain(`${HUB_CONTEXT_CAP_MARKERS.write} skipped`);
  });

  it('exits 0 whatever it found, so the caller judges the markers rather than the exit status', () => {
    expect(set.trimEnd().endsWith('true')).toBe(true);
    expect(set).not.toContain('|| echo 000');
    expect(set).toContain('[ -n "$cihub_cap_code" ] || cihub_cap_code=000');
  });

  it('names the route in the dry-run line', () => {
    expect(describeHubContextCapPlan(16384)).toContain('inferenceMaxNumCtx=16384');
    expect(describeHubContextCapPlan(16384)).toContain('PATCH /api/user-settings');
    expect(describeHubContextCapPlan(null)).toContain('clear the context cap');
    expect(describeHubContextCapPlan(null)).toContain('PATCH /api/inference/preferences');
  });
});

describe('hubContextCapShell for the slot count (--ollama-parallel)', () => {
  const set = hubContextCapShell(4, '/srv/hub', HUB_OLLAMA_SLOTS_SETTING);
  const clear = hubContextCapShell(null, '/srv/hub', HUB_OLLAMA_SLOTS_SETTING);

  it('is the cap script with the two keys swapped: reads ollamaSlots, sets inferenceOllamaSlots, clears ollamaSlots', () => {
    expect(set).toContain(`grep -q '"ollamaSlots"'`);
    expect(set).toContain(`-X PATCH -d '{"inferenceOllamaSlots":4}' "$cihub_cap_url/user-settings"`);
    expect(set).toContain('if [ "$cihub_cap_now" = 4 ] || [ "$cihub_cap_now" = absent ]; then');
    expect(clear).toContain('{\\"backend\\":\\"$cihub_cap_backend\\",\\"ollamaSlots\\":null}');
    for (const script of [set, clear]) {
      expect(script).not.toContain('maxNumCtx');
      expect(script).not.toContain('inferenceMaxNumCtx');
      expect(script).not.toMatch(/echo[^\n]*\$cihub_cap_key/);
      expect(script).toContain('unset cihub_cap_key');
    }
  });

  it('names the setting and the route in the dry-run line', () => {
    expect(describeHubContextCapPlan(4, HUB_OLLAMA_SLOTS_SETTING)).toContain('inferenceOllamaSlots=4');
    expect(describeHubContextCapPlan(4, HUB_OLLAMA_SLOTS_SETTING)).toContain('PATCH /api/user-settings');
    expect(describeHubContextCapPlan(null, HUB_OLLAMA_SLOTS_SETTING)).toContain('clear the slot count');
    expect(describeHubContextCapPlan(null, HUB_OLLAMA_SLOTS_SETTING)).toContain('ollamaSlots=null');
  });
});

describe('classifyHubContextCapOutput', () => {
  const m = HUB_CONTEXT_CAP_MARKERS;
  const out = (...lines: string[]) => lines.join('\n');
  const okRun = (now: string, write: string, after?: string) =>
    out(
      `${m.key} present`,
      `${m.get} 200`,
      `${m.now} ${now}`,
      `${m.write} ${write}`,
      ...(after === undefined ? [] : [`${m.after} ${after}`]),
      m.complete,
    );

  it('reports applied only for a cap that read back as requested, with was → is and the route', () => {
    const applied = classifyHubContextCapOutput(okRun('none', '200', '16384'), '', 16384);
    expect(applied).toMatchObject({ outcome: 'applied', before: null, after: 16384, httpStatus: 200 });
    expect(applied.why).toBe('context cap none → 16384 (PATCH /api/user-settings 200)');
    const cleared = classifyHubContextCapOutput(okRun('65536', '200', 'none'), '', null);
    expect(cleared).toMatchObject({ outcome: 'applied', before: 65536, after: null });
    expect(cleared.why).toBe('context cap 65536 → none (PATCH /api/inference/preferences 200)');
  });

  it('is unchanged — nothing written, no app swept — when the cap already reads as requested', () => {
    expect(classifyHubContextCapOutput(okRun('16384', 'skipped'), '', 16384)).toMatchObject({
      outcome: 'unchanged',
      why: 'context cap already 16384',
    });
    expect(classifyHubContextCapOutput(okRun('none', 'skipped'), '', null)).toMatchObject({
      outcome: 'unchanged',
      why: 'no context cap set; nothing to clear',
    });
  });

  it('fails a non-2xx write with the code, and hints at the bounds on a 400', () => {
    const bad = classifyHubContextCapOutput(okRun('none', '400'), '', 1024);
    expect(bad.outcome).toBe('failed');
    expect(bad.why).toContain('PATCH /api/user-settings answered HTTP 400');
    expect(bad.why).toContain('2048 to 1048576');
    expect(classifyHubContextCapOutput(okRun('65536', '500'), '', null).why).toBe('PATCH /api/inference/preferences answered HTTP 500');
  });

  it('does not trust a 200 the read-back contradicts — an older user-settings schema strips the key and answers 200', () => {
    const stripped = classifyHubContextCapOutput(okRun('none', '200', 'none'), '', 16384);
    expect(stripped.outcome).toBe('failed');
    expect(stripped.why).toContain('reads back none, not 16384');
    const unread = classifyHubContextCapOutput(okRun('none', '200'), '', 16384);
    expect(unread.outcome).toBe('failed');
    expect(unread.why).toContain('read-back');
  });

  it('reports the slot count in its own words, with its own bounds and key', () => {
    const s = HUB_OLLAMA_SLOTS_SETTING;
    expect(classifyHubContextCapOutput(okRun('none', '200', '4'), '', 4, s).why).toBe('slot count none → 4 (PATCH /api/user-settings 200)');
    expect(classifyHubContextCapOutput(okRun('4', 'skipped'), '', 4, s).why).toBe('slot count already 4');
    expect(classifyHubContextCapOutput(okRun('none', 'skipped'), '', null, s).why).toBe('no slot count set; nothing to clear');
    expect(classifyHubContextCapOutput(okRun('none', '400'), '', 4, s).why).toContain('1 to 64');
    expect(classifyHubContextCapOutput(okRun('absent', 'skipped'), '', 4, s).why).toContain(
      'predates the slot count (GET /api/inference/preferences has no ollamaSlots)',
    );
    expect(classifyHubContextCapOutput(okRun('none', '200', '2'), '', 4, s).why).toContain('reads back 2, not 4');
  });

  it('names a Hub whose build predates the cap, and treats clearing one as nothing to do', () => {
    const tooOld = classifyHubContextCapOutput(okRun('absent', 'skipped'), '', 16384);
    expect(tooOld.outcome).toBe('failed');
    expect(tooOld.why).toContain('predates the context cap');
    expect(tooOld.why).toContain('cihub fleet update --hub');
    expect(classifyHubContextCapOutput(okRun('absent', 'skipped'), '', null)).toMatchObject({ outcome: 'unchanged' });
  });

  it('tells no key, no Hub, a rejected key and an unclaimed Hub apart — they need different fixes', () => {
    expect(classifyHubContextCapOutput(out(`${m.key} missing`, m.complete), '', 16384).why).toContain('no device key');
    expect(classifyHubContextCapOutput(out(`${m.key} present`, `${m.get} 000`, m.complete), '', 16384).why).toContain('127.0.0.1:5002');
    expect(classifyHubContextCapOutput(out(`${m.key} present`, `${m.get} 401`, m.complete), '', 16384).why).toContain('HTTP 401');
    expect(classifyHubContextCapOutput(out(`${m.key} present`, `${m.get} 409`, m.complete), '', 16384).why).toContain('cihub claim');
    // A run cut off before its marker is a failure with that reason, never a silent success.
    expect(classifyHubContextCapOutput(out(`${m.key} present`, `${m.get} 200`), '', 16384).why).toContain('no completion marker');
  });
});

describe.skipIf(!bash)('hubContextCapShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stub Hub: `curl` answers the two routes the script drives from a JSON file, and records every
   * call. `docker` reports no container, so the key comes from the host data dir.
   */
  function sandbox(preferences: Record<string, unknown>) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-cap-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const data = path.join(root, 'data', 'state');
    mkdirSync(bin);
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ciHubApiKey: 'k-secret-123' }));
    const state = path.join(root, 'hub.json');
    const log = path.join(root, 'calls.log');
    writeFileSync(state, JSON.stringify(preferences));
    const stub = (name: string, body: string) => {
      const p = path.join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    stub('docker', 'exit 1');
    // The same in-place-refusing `sed` as the hubLlamacppUrlShell sandbox, so the fake `curl` below
    // cannot slip back to `sed -i` and stay green on Linux CI, whose GNU sed runs the bare form.
    stub(
      'sed',
      [
        'for a in "$@"; do case "$a" in -i*|--in-place*|-[Enrsuz]*i*) echo "sed: in-place edit refused by the test sandbox: $a" >&2; exit 1;; esac; done',
        'for s in /usr/bin/sed /bin/sed; do [ -x "$s" ] && exec "$s" "$@"; done',
        'exit 127',
      ].join('\n'),
    );
    stub(
      'curl',
      [
        'out=""; method=GET; data=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in',
        '  -o) out="$2"; shift 2;; -X) method="$2"; shift 2;; -d) data="$2"; shift 2;;',
        '  -w|--max-time|-H) shift 2;; -s) shift;; *) url="$1"; shift;;',
        'esac; done',
        `echo "$method $url $data" >> '${log}'`,
        // `sed > tmp && mv`, never `sed -i`: BSD sed (macOS) reads the next argument as a mandatory
        // backup suffix, so a bare `sed -i 's/…/…/' file` there takes the script as the suffix and the
        // file name as the script, exits non-zero, and leaves the state file untouched — this whole
        // case then reports `failed` on a developer's Mac while passing on Linux CI.
        'case "$method $url" in',
        `  "GET "*inference/preferences) cat '${state}' > "$out"; printf 200;;`,
        // The Hub's user-settings route writes the key and answers with no body.
        `  "PATCH "*user-settings) n=$(echo "$data" | sed -n 's/.*"inferenceMaxNumCtx":\\([0-9]*\\).*/\\1/p'); sed "s/\\"maxNumCtx\\":[^,}]*/\\"maxNumCtx\\":$n/" '${state}' > '${state}.tmp' && mv '${state}.tmp' '${state}'; : > "$out"; printf 200;;`,
        `  "PATCH "*inference/preferences) sed 's/"maxNumCtx":[^,}]*/"maxNumCtx":null/' '${state}' > '${state}.tmp' && mv '${state}.tmp' '${state}'; cat '${state}' > "$out"; printf 200;;`,
        '  *) printf 404;;',
        'esac',
      ].join('\n'),
    );
    const run = (cap: number | null) =>
      spawnSync(bash as string, ['-c', hubContextCapShell(cap, path.join(root, 'data'))], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: '/tmp' },
        encoding: 'utf-8',
      });
    return {
      run,
      calls: () => readFileSync(log, 'utf-8').trim().split('\n'),
      state: () => JSON.parse(readFileSync(state, 'utf-8')) as Record<string, unknown>,
    };
  }

  it('sets, then skips the write on a second run; clears, then skips again — and never prints the key', () => {
    const box = sandbox({ preferredBackend: 'ollama', preferredModel: null, maxNumCtx: null });

    const first = box.run(16384);
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('k-secret');
    expect(classifyHubContextCapOutput(first.stdout, first.stderr, 16384)).toMatchObject({ outcome: 'applied', before: null, after: 16384 });
    expect(box.state().maxNumCtx).toBe(16384);
    expect(box.calls().filter((c) => c.startsWith('PATCH'))).toEqual(['PATCH http://127.0.0.1:5002/api/user-settings {"inferenceMaxNumCtx":16384}']);

    const again = box.run(16384);
    expect(classifyHubContextCapOutput(again.stdout, again.stderr, 16384)).toMatchObject({ outcome: 'unchanged' });
    expect(box.calls().filter((c) => c.startsWith('PATCH'))).toHaveLength(1);

    const cleared = box.run(null);
    expect(classifyHubContextCapOutput(cleared.stdout, cleared.stderr, null)).toMatchObject({ outcome: 'applied', before: 16384, after: null });
    expect(box.calls().filter((c) => c.startsWith('PATCH'))[1]).toBe(
      'PATCH http://127.0.0.1:5002/api/inference/preferences {"backend":"ollama","maxNumCtx":null}',
    );

    const clearedAgain = box.run(null);
    expect(classifyHubContextCapOutput(clearedAgain.stdout, clearedAgain.stderr, null)).toMatchObject({ outcome: 'unchanged' });
    expect(box.calls().filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
  });

  it('sends the stored backend back on a clear, and Ollama when none is stored', () => {
    const vllm = sandbox({ preferredBackend: 'vllm', maxNumCtx: 32768 });
    vllm.run(null);
    expect(vllm.calls().filter((c) => c.startsWith('PATCH'))[0]).toContain('{"backend":"vllm","maxNumCtx":null}');
    const none = sandbox({ preferredBackend: null, maxNumCtx: 32768 });
    none.run(null);
    expect(none.calls().filter((c) => c.startsWith('PATCH'))[0]).toContain('{"backend":"ollama","maxNumCtx":null}');
  });

  it('fails a Hub whose preferences carry no maxNumCtx before writing anything', () => {
    const old = sandbox({ preferredBackend: 'ollama', preferredModel: null });
    const result = old.run(16384);
    expect(classifyHubContextCapOutput(result.stdout, result.stderr, 16384).why).toContain('predates the context cap');
    expect(old.calls().filter((c) => c.startsWith('PATCH'))).toHaveLength(0);
  });
});
