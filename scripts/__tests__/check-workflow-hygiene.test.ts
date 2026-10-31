import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOW_LIST_PATH,
  applyAllowList,
  type Finding,
  formatFinding,
  isReportOnly,
  main,
  parseAllowList,
  REPORT_ONLY_RULES,
  scanPrivateKeys,
  scanRepo,
  scanSecretMaps,
  scanWorkflow,
} from '../check-workflow-hygiene';

/**
 * Every workflow in this repository runs only when dispatched, so the guard is only worth anything if
 * `pnpm test` runs it. The last describe block runs it on the real tree; the others pin each rule, in the
 * spellings a workflow can use, and the places where it must stay quiet.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'workflow-hygiene');
const WORKFLOW = '.github/workflows/test.yml';
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function scan(source: string): Finding[] {
  return scanWorkflow(WORKFLOW, source);
}

/** `rule@line` for each finding, so a case reads as one short list. */
function where(found: Finding[]): string[] {
  return found.map((f) => `${f.rule}@${f.line}`);
}

function indent(text: string, spaces: number): string {
  return text
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n');
}

function yml(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

/** A workflow that passes every rule up to the point where `jobs:` begins. */
const BASE = yml('name: Test', 'on:', '  workflow_dispatch:', 'permissions:', '  contents: read', 'jobs:');

/** One job whose steps are `steps`, written at the indent of a list under `steps:`. */
function withSteps(steps: string): string {
  return `${BASE}${yml('  noop:', '    runs-on: ubuntu-latest', '    steps:')}${indent(steps, 6)}\n`;
}

/** One job that calls a reusable workflow, with the extra lines `call` written at the job's key indent. */
function withCall(call: string): string {
  return `${BASE}${yml('  call:', '    uses: ./.github/workflows/callee.yml')}${indent(call, 4)}\n`;
}

/** A private-key header, joined at run time so that this file does not contain one. */
function pemHeader(kind: string): string {
  return `${'-'.repeat(5)}BEGIN ${kind}${'-'.repeat(5)}`;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Git environment of a scratch repository: nothing from a hook, and no user configuration. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG')) delete env[name];
  return env;
}

/** Creates a git repository holding `files`. Names in `untracked` are written but not added. */
function makeRepo(files: Record<string, string | Buffer>, untracked: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-hygiene-'));
  scratch.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: cleanGitEnv() });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), body);
  }
  const tracked = Object.keys(files).filter((name) => !untracked.includes(name));
  if (tracked.length > 0) execFileSync('git', ['add', '--', ...tracked], { cwd: root, env: cleanGitEnv() });
  return root;
}

function run(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out, err };
}

describe('each bad fixture yields exactly its finding', () => {
  it.each([
    ['pull-request-target.yml', 'dangerous-trigger@3'],
    ['secrets-inherit.yml', 'secrets-inherit@9'],
    ['tag-pinned.yml', 'unpinned-uses@10'],
    ['branch-pinned.yml', 'unpinned-uses@10'],
    ['missing-permissions.yml', 'missing-permissions@5'],
  ])('%s', (name, expected) => {
    expect(where(scan(fixture(name)))).toEqual([expected]);
  });

  it('a private-key block yields exactly one private-key finding, on its own line', () => {
    const source = `name: Test\n# a note\nenv:\n  KEY: |\n    ${pemHeader('RSA PRIVATE KEY')}\n    not-a-real-key\n`;
    expect(where(scanPrivateKeys('x.txt', source))).toEqual(['private-key@5']);
  });

  it('the clean fixture, with a commit pin, a docker digest, a local action and an explicit map, yields nothing', () => {
    expect(scan(fixture('clean.yml'))).toEqual([]);
  });
});

describe('comments', () => {
  it('a workflow whose only mentions are in comments yields nothing', () => {
    expect(scan(fixture('comment-only.yml'))).toEqual([]);
  });

  it('inside the ci-local:gated block only dangerous-trigger reads: a restored pull_request_target is refused, a secrets line is not', () => {
    expect(where(scan(fixture('gated-block.yml')))).toEqual(['dangerous-trigger@4']);
  });

  it('a gated block that never closes is read to the end of the file, so a trigger in it is still refused', () => {
    const source = yml(
      '# >>> ci-local:gated original triggers below',
      '# on:',
      '#   workflow_run:',
      'name: Test',
      '# a later comment',
      'on:',
      '  workflow_dispatch:',
    );
    expect(where(scan(`${source}permissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n`))).toEqual(['dangerous-trigger@3']);
  });

  it('a plain comment after a closed gated block is not read as gated', () => {
    const source = `${fixture('gated-block.yml').replace('pull_request_target', 'push')}# workflow_run is mentioned here in prose\n`;
    expect(scan(source)).toEqual([]);
  });

  it('the gated markers inside a script are script text, so a later plain comment is not read as gated', () => {
    const source = `${BASE}${yml('  noop:', '    runs-on: x', '    steps:', '      - run: |', '          # >>> ci-local:gated', '          true')}# workflow_run is mentioned here in prose\n`;
    expect(scan(source)).toEqual([]);
  });

  it('a trailing comment after a value is not read', () => {
    expect(scan(withSteps('- uses: ./.github/actions/x # example-org/action@v1, secrets: inherit, pull_request_target'))).toEqual([]);
  });
});

describe('block scalars are script text, not structure', () => {
  it('trigger names, uses lines and a hand-over inside run scripts yield nothing', () => {
    expect(scan(fixture('block-scalars.yml'))).toEqual([]);
  });

  it('a bare list scalar and an input under with are script text too', () => {
    const steps = yml(
      '- |',
      '  uses: example-org/example-action@v1',
      '- uses: ./.github/actions/x',
      '  with:',
      '    script: |',
      '      secrets: inherit',
      '      uses: example-org/example-action@v1',
    );
    expect(scan(withSteps(steps))).toEqual([]);
  });

  it('the first line after a block scalar is read again, whether it is a list entry or a key of the same step', () => {
    const steps = yml('- run: |', '    echo hi', '- uses: example-org/example-action@v1');
    expect(where(scan(withSteps(steps)))).toEqual(['unpinned-uses@12']);
    const sameStep = yml('- name: x', '  run: |', '    echo hi', '  uses: example-org/example-action@v1');
    expect(where(scan(withSteps(sameStep)))).toEqual(['unpinned-uses@13']);
  });
});

describe('dangerous-trigger', () => {
  const doc = (on: string) => `${on}\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n`;

  it.each([
    ['a scalar', 'on: pull_request_target'],
    ['a flow list', 'on: [push, pull_request_target]'],
    ['a flow mapping with a quoted key', "on: { push: {}, 'pull_request_target': {} }"],
    ['a block mapping', 'on:\n  pull_request_target:\n    types: [opened]'],
    ['a list at the key indent', 'on:\n- pull_request_target'],
    ['an indented list', 'on:\n  - push\n  - pull_request_target'],
    ['a quoted on key and value', '"on": "pull_request_target"'],
    ['other letter case', "'on':\n  Pull_Request_Target:"],
    ['workflow_run as a scalar', 'on: workflow_run'],
    ['workflow_run as a mapping', 'on:\n  workflow_run:\n    workflows: [Build]'],
    ['a block scalar', 'on: >-\n  pull_request_target'],
    ['an escape sequence', 'on: "pull_request_\\x74arget"'],
    ['a folded double-quoted scalar', 'on: "pull_request_\\\n  target"'],
    ['an alias for the triggers', 'on: *triggers'],
    ['an alias in a list', 'on:\n  - *event'],
    ['a merge key', 'on:\n  <<: *base'],
    ['an alias at the start of a flow list', 'on: [*events, push]'],
  ])('is refused as %s', (_name, on) => {
    const found = scan(doc(on));
    expect(found.map((f) => f.rule)).toEqual(['dangerous-trigger']);
  });

  it('reads past a # inside quotes, and counts each refused name', () => {
    expect(scan(doc('on: ["#", workflow_run]')).map((f) => f.rule)).toEqual(['dangerous-trigger']);
    expect(scan(doc("on: ['# x', pull_request_target]")).map((f) => f.rule)).toEqual(['dangerous-trigger']);
    expect(scan(doc('on: ["a #", workflow_run]')).map((f) => f.rule)).toEqual(['dangerous-trigger']);
    expect(scan(doc("on: ['a #', pull_request_target]")).map((f) => f.rule)).toEqual(['dangerous-trigger']);
    expect(scan(doc('on: [pull_request_target, workflow_run]')).map((f) => f.rule)).toEqual(['dangerous-trigger', 'dangerous-trigger']);
  });

  it('reads the on key of a file that starts with a byte-order mark', () => {
    expect(where(scan('\uFEFFon: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n'))).toEqual(['dangerous-trigger@1']);
  });

  it.each([
    ['dispatch, call and pull_request', 'on:\n  workflow_dispatch:\n  workflow_call:\n  pull_request:'],
    ['a longer event name', 'on:\n  workflow_runner:'],
    ['a longer name that ends with one', 'on:\n  x_workflow_run:'],
    ['a hyphenated name that ends with one', 'on:\n  pre-pull_request_target:'],
    ['globs, quoted or inside a word', 'on:\n  push:\n    paths: [\'**/*.md\', "a *notes", src/*.ts]'],
    ['a trailing comment', 'on: workflow_dispatch # pull_request_target'],
  ])('is not raised for %s', (_name, on) => {
    expect(scan(doc(on))).toEqual([]);
  });

  it('is read in the triggers wherever the on key sits in the file', () => {
    const source = yml(
      'permissions:',
      '  contents: read',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      '      - run: true',
      'on:',
      '  pull_request_target:',
    );
    expect(where(scan(source))).toEqual(['dangerous-trigger@9']);
  });

  it('is not raised by a job step or an expression that names the event', () => {
    const steps = yml("- if: github.event_name == 'pull_request_target'", '  run: echo workflow_run');
    expect(scan(withSteps(steps))).toEqual([]);
  });

  it('is not read in a composite action', () => {
    expect(scanWorkflow('.github/actions/x/action.yml', 'on: pull_request_target\n')).toEqual([]);
  });
});

describe('secrets-inherit', () => {
  it.each([
    ['plain', 'secrets: inherit'],
    ['with extra spaces', 'secrets:    inherit'],
    ['double-quoted', 'secrets: "inherit"'],
    ['single-quoted', "secrets: 'inherit'"],
    ['with a quoted key', '"secrets": inherit'],
    ['after an anchor', 'secrets: &all inherit'],
    ['after a tag', 'secrets: !!str inherit'],
    ['as a folded scalar', 'secrets: >-\n  inherit'],
    ['on the next line', 'secrets:\n  inherit'],
    ['as an alias', 'secrets: *everything'],
    ['with a trailing comment', 'secrets: inherit # all of them'],
  ])('is refused when written %s', (_name, call) => {
    expect(where(scan(withCall(call)))).toEqual(['secrets-inherit@9']);
  });

  it.each([
    ['a block map', 'secrets:\n  TOKEN: ${{ secrets.TOKEN }}'],
    ['a map after an anchor', 'secrets: &list\n  TOKEN: ${{ secrets.TOKEN }}'],
    ['a flow map', 'secrets: { TOKEN: "${{ secrets.TOKEN }}" }'],
    ['no secrets', 'with:\n  version: 1'],
    ['an empty value', 'secrets:'],
  ])('is not raised for %s', (_name, call) => {
    expect(scan(withCall(call))).toEqual([]);
  });

  it('is not raised for an empty value that is followed by something other than a key', () => {
    expect(scan(`${withCall('secrets:')}---\n`)).toEqual([]);
  });

  it('is not raised for an input called secrets inside a step', () => {
    const steps = yml('- uses: ./.github/actions/x', '  with:', '    secrets: |', '      token=abc', '    secrets-extra: inherit');
    expect(scan(withSteps(steps))).toEqual([]);
  });

  it('is raised for a job that is not a block mapping, because its secrets cannot be seen', () => {
    const source = `${BASE}  call: { uses: ./.github/workflows/callee.yml, secrets: inherit }\n`;
    expect(where(scan(source))).toEqual(['secrets-inherit@7']);
  });

  it('is raised once for each job that hands everything over', () => {
    const source = `${BASE}${yml('  one:', '    uses: ./.github/workflows/a.yml', '    secrets: inherit', '  two:', '    uses: ./.github/workflows/b.yml', '    secrets: inherit')}`;
    expect(where(scan(source))).toEqual(['secrets-inherit@9', 'secrets-inherit@12']);
  });
});

describe('unpinned-uses', () => {
  it.each([
    ['a local action', '- uses: ./.github/actions/x'],
    ['a quoted local action', '- uses: "./.github/actions/x"'],
    ['a commit pin with a release comment', `- uses: example-org/example-action@${SHA} # v4.4.0`],
    ['a quoted commit pin', `- uses: "example-org/example-action@${SHA}" # v4.4.0`],
    ['a commit pin in a subdirectory', `- uses: example-org/example-action/sub/path@${SHA} # v1`],
    ['a docker digest', `- uses: docker://registry.example.test/org/app@sha256:${DIGEST}`],
    ['a step key without a dash', `- name: x\n  uses: example-org/example-action@${SHA} # v1`],
    ['a command that mentions uses', '- run: echo "uses: example-org/example-action@v1"'],
    ['a commented reference', '# - uses: example-org/example-action@v1'],
  ])('passes %s', (_name, steps) => {
    expect(scan(withSteps(steps))).toEqual([]);
  });

  it.each([
    ['a tag', '- uses: example-org/example-action@v1'],
    ['a branch', '- uses: example-org/example-action@main'],
    ['a tag with a release comment', '- uses: example-org/example-action@v1 # v1.2.3'],
    ['a quoted tag', '- uses: "example-org/example-action@v1"'],
    ['a step key without a dash', '- name: x\n  uses: example-org/example-action@v1'],
    ['a reusable workflow pinned by a tag', '- uses: example-org/example-action/.github/workflows/x.yml@v1'],
    ['a commit with no comment', `- uses: example-org/example-action@${SHA}`],
    ['a commit with an empty comment', `- uses: example-org/example-action@${SHA} #`],
    ['a comment glued to the commit', `- uses: example-org/example-action@${SHA}#v1`],
    ['39 hex characters', `- uses: example-org/example-action@${'a'.repeat(39)} # v1`],
    ['41 hex characters', `- uses: example-org/example-action@${'a'.repeat(41)} # v1`],
    ['upper-case hex characters', `- uses: example-org/example-action@${'A'.repeat(40)} # v1`],
    ['a docker tag', '- uses: docker://registry.example.test/org/app:3'],
    ['a docker digest of 63 characters', `- uses: docker://registry.example.test/org/app@sha256:${'b'.repeat(63)}`],
    ['a flow-style step', '- { uses: example-org/example-action@v1 }'],
    ['a flow-style step with other keys', '- {name: x, uses: "example-org/example-action@v1"}'],
    ['an empty value', '- uses:'],
    ['a value on the next line', '- uses: >-\n    example-org/example-action@v1'],
    ['an expression', '- uses: ${{ matrix.action }}'],
  ])('refuses %s', (_name, steps) => {
    const found = scan(withSteps(steps));
    expect(found.map((f) => f.rule)).toEqual(['unpinned-uses']);
  });

  it('says why a value that is not a plain reference cannot be checked', () => {
    for (const steps of ['- uses:', '- uses: >-\n    example-org/example-action@v1', '- uses: ${{ matrix.action }}']) {
      expect(scan(withSteps(steps)).map((f) => f.message)).toEqual([
        'the `uses` value is not a plain reference on this line, so it cannot be checked',
      ]);
    }
  });

  it('is report-only, so it does not fail the run', () => {
    expect([...REPORT_ONLY_RULES]).toEqual(['unpinned-uses']);
    const [found] = scan(withSteps('- uses: example-org/example-action@v1'));
    expect(found && isReportOnly(found)).toBe(true);
    const [other] = scan(fixture('pull-request-target.yml'));
    expect(other && isReportOnly(other)).toBe(false);
  });

  it('checks the references of a composite action, and nothing else about it', () => {
    const action = yml(
      'name: Example',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: example-org/example-action@v1',
      '      secrets: inherit',
    );
    expect(where(scanWorkflow('.github/actions/x/action.yml', action))).toEqual(['unpinned-uses@5']);
  });
});

describe('missing-permissions', () => {
  const noTop = yml('name: Test', 'on:', '  workflow_dispatch:', 'jobs:');

  it.each([
    ['read-all', 'permissions: read-all'],
    ['an empty map', 'permissions: {}'],
    ['a block', 'permissions:\n  contents: read'],
    ['a quoted key', '"permissions":\n  contents: read'],
  ])('a top-level %s covers every job', (_name, top) => {
    expect(scan(`${top}\n${noTop}  a:\n    runs-on: x\n`)).toEqual([]);
  });

  it('a top-level block that comes after the jobs counts too', () => {
    expect(scan(`${noTop}  a:\n    runs-on: x\npermissions:\n  contents: read\n`)).toEqual([]);
  });

  it('without a top-level block, every job needs its own', () => {
    const jobs = yml(
      '  a:',
      '    permissions:',
      '      contents: read',
      '  b:',
      '    permissions: {}',
      '  c:',
      '    "permissions": read-all',
      '  d:',
      '    permissions: { contents: read }',
    );
    expect(scan(`${noTop}${jobs}`)).toEqual([]);
  });

  it('reports each job without a block, not only the first, and names it', () => {
    const jobs = yml('  a:', '    permissions: {}', '  b:', '    runs-on: x', '  c:', '    runs-on: x');
    const found = scan(`${noTop}${jobs}`);
    expect(where(found)).toEqual(['missing-permissions@7', 'missing-permissions@9']);
    expect(found.map((f) => f.job)).toEqual(['b', 'c']);
  });

  it('a permissions key deeper in a job does not count for the job', () => {
    const jobs = yml(
      '  a:',
      '    runs-on: x',
      '    steps:',
      '      - uses: ./.github/actions/x',
      '        with:',
      '          permissions: write-all',
    );
    expect(where(scan(`${noTop}${jobs}`))).toEqual(['missing-permissions@5']);
  });

  it('permissions text inside a script does not count', () => {
    const jobs = yml('  a:', '    runs-on: x', '    steps:', '      - run: |', '          permissions:', '            contents: write');
    expect(where(scan(`${noTop}${jobs}`))).toEqual(['missing-permissions@5']);
  });

  it('a job written in flow style cannot be read, so it is reported', () => {
    const found = scan(`${noTop}  a: { runs-on: x, permissions: {} }\n`);
    expect(found.map((f) => `${f.rule}:${f.job}`)).toEqual(['missing-permissions:a', 'secrets-inherit:a']);
  });

  it('a job built with a merge key cannot be read, so it is reported', () => {
    const jobs = yml('  a:', '    <<: *base', '    runs-on: x');
    expect(where(scan(`${yml('on:', '  workflow_dispatch:', 'permissions: {}', 'jobs:')}${jobs}`))).toEqual(['secrets-inherit@5']);
    expect(where(scan(`${yml('on:', '  workflow_dispatch:', 'jobs:')}${jobs}`))).toEqual(['missing-permissions@4', 'secrets-inherit@4']);
  });

  it('a jobs key written in flow style cannot be read, so it is reported', () => {
    const found = scan(yml('on:', '  workflow_dispatch:', 'jobs: { a: { runs-on: x } }'));
    expect(found.map((f) => f.rule)).toEqual(['missing-permissions', 'secrets-inherit']);
  });

  it('a workflow with no jobs and no permissions is reported for the whole file, with or without an empty jobs key', () => {
    expect(where(scan(yml('name: Test', 'on:', '  workflow_dispatch:')))).toEqual(['missing-permissions@0']);
    expect(where(scan(yml('name: Test', 'on:', '  workflow_dispatch:', 'jobs:')))).toEqual(['missing-permissions@0']);
  });

  it('an anchor on a job does not hide its keys', () => {
    const jobs = yml('  a: &base', '    permissions: {}', '    runs-on: x');
    expect(scan(`${noTop}${jobs}`)).toEqual([]);
  });

  it('is not asked of a composite action', () => {
    expect(scanWorkflow('.github/actions/x/action.yml', yml('name: Example', 'runs:', '  using: composite'))).toEqual([]);
  });
});

describe('order', () => {
  it('lists the findings of one file by line, not by the order in which the rules found them', () => {
    const source = yml(
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      '      - uses: example-org/example-action@v1',
    );
    expect(where(scan(source))).toEqual(['dangerous-trigger@2', 'missing-permissions@4', 'unpinned-uses@7']);
  });
});

describe('private-key', () => {
  it.each([
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
  ])('refuses a %s header', (kind) => {
    expect(where(scanPrivateKeys('x.txt', `before\n${pemHeader(kind)}\nafter`))).toEqual(['private-key@2']);
  });

  it.each(['PUBLIC KEY', 'CERTIFICATE', 'RSA PUBLIC KEY', 'PGP PUBLIC KEY BLOCK', 'CERTIFICATE REQUEST'])('passes a %s header', (kind) => {
    expect(scanPrivateKeys('x.txt', `${pemHeader(kind)}\n`)).toEqual([]);
  });

  it('refuses a header in the middle of a line, after an extra dash, and with Windows line endings', () => {
    expect(where(scanPrivateKeys('x.txt', `key = "${pemHeader('RSA PRIVATE KEY')}"`))).toEqual(['private-key@1']);
    expect(where(scanPrivateKeys('x.txt', `-${pemHeader('EC PRIVATE KEY')}`))).toEqual(['private-key@1']);
    expect(where(scanPrivateKeys('x.txt', `a\r\n${pemHeader('EC PRIVATE KEY')}\r\n`))).toEqual(['private-key@2']);
  });

  it('does not match a header that is cut short or a word near it', () => {
    expect(scanPrivateKeys('x.txt', `${'-'.repeat(4)}BEGIN RSA PRIVATE KEY${'-'.repeat(5)}\nBEGIN PRIVATE KEY\nPRIVATE KEY\n`)).toEqual([]);
  });
});

describe('secret-map', () => {
  const CALLEE = '.github/workflows/callee.yml';
  const CALLER = '.github/workflows/caller.yml';

  const calleeText = (declared: string[], body: string) =>
    yml(
      'name: Callee',
      'on:',
      '  workflow_call:',
      ...(declared.length ? ['    secrets:', ...declared.flatMap((n) => [`      ${n}:`, '        required: false'])] : []),
      'permissions: {}',
      'jobs:',
      '  work:',
      '    runs-on: x',
      '    steps:',
      indent(body, 6),
    );
  const callerText = (passed: string[], uses = './.github/workflows/callee.yml') =>
    yml(
      'name: Caller',
      'on:',
      '  workflow_dispatch:',
      'permissions: {}',
      'jobs:',
      '  call:',
      `    uses: ${uses}`,
      ...(passed.length ? ['    secrets:', ...passed.map((n) => `      ${n}: \${{ secrets.${n} }}`)] : []),
    );
  const check = (caller: string, callee: string) =>
    scanSecretMaps(
      new Map([
        [CALLER, caller],
        [CALLEE, callee],
      ]),
    ).map((f) => f.message.replace(/^job call: /, ''));

  const reads = (...names: string[]) => `- run: echo ${names.map((n) => `\${{ secrets.${n} }}`).join(' ')}`;

  it('passes when the call passes exactly what the callee reads and declares', () => {
    expect(check(callerText(['A', 'B']), calleeText(['A', 'B'], reads('A', 'B')))).toEqual([]);
  });

  it('passes when the callee reads nothing and the call passes nothing', () => {
    expect(check(callerText([]), calleeText([], '- run: true'))).toEqual([]);
  });

  it('may declare a secret that nothing passes or reads', () => {
    expect(check(callerText(['A']), calleeText(['A', 'SPARE'], reads('A')))).toEqual([]);
  });

  it('reports a name the callee reads but the call does not pass', () => {
    expect(check(callerText(['A']), calleeText(['A', 'B'], reads('A', 'B')))).toEqual([
      '.github/workflows/callee.yml reads B but the call does not pass it',
    ]);
  });

  it('reports a name the call passes but the callee never reads', () => {
    expect(check(callerText(['A', 'B']), calleeText(['A', 'B'], reads('A')))).toEqual(['passes B, which .github/workflows/callee.yml never reads']);
  });

  it('reports a name the call passes but the callee does not declare', () => {
    expect(check(callerText(['A']), calleeText([], reads('A')))).toEqual([
      'passes A, which .github/workflows/callee.yml does not declare under on.workflow_call.secrets',
    ]);
  });

  it('reports every kind of mismatch for one name', () => {
    expect(check(callerText(['A']), calleeText([], '- run: true'))).toEqual([
      'passes A, which .github/workflows/callee.yml does not declare under on.workflow_call.secrets',
      'passes A, which .github/workflows/callee.yml never reads',
    ]);
  });

  it('ignores the repository token, a step called secrets, a comment, and reads the index form and script text', () => {
    const body = yml(
      '- run: echo ${{ secrets.GITHUB_TOKEN }} ${{ steps.secrets.outputs.found }} # ${{ secrets.COMMENTED }}',
      '- run: |',
      '    echo ${{ secrets["INDEXED"] }}',
    );
    expect(check(callerText(['INDEXED']), calleeText(['INDEXED'], body))).toEqual([]);
  });

  it('leaves a hand-over of everything to the secrets-inherit rule', () => {
    const caller = yml(
      'name: Caller',
      'on:',
      '  workflow_dispatch:',
      'permissions: {}',
      'jobs:',
      '  call:',
      '    uses: ./.github/workflows/callee.yml',
      '    secrets: inherit',
    );
    expect(check(caller, calleeText(['A'], reads('A')))).toEqual([]);
  });

  it('reports a map written in flow style, which it cannot read, and a callee that is not in the tree', () => {
    const flow = yml(
      'name: Caller',
      'on:',
      '  workflow_dispatch:',
      'permissions: {}',
      'jobs:',
      '  call:',
      '    uses: ./.github/workflows/callee.yml',
      '    secrets: { A: x }',
    );
    expect(check(flow, calleeText(['A'], reads('A')))).toEqual(['the secrets map is written in flow style and cannot be read; write it as a block']);
    expect(check(callerText([], './.github/workflows/gone.yml'), calleeText([], '- run: true'))).toEqual([
      'calls .github/workflows/gone.yml, which is not in the tree',
    ]);
  });

  it('follows a quoted path and ignores calls to other repositories', () => {
    expect(check(callerText(['A'], '"./.github/workflows/callee.yml"'), calleeText(['A'], reads('A')))).toEqual([]);
    expect(check(callerText(['A'], 'example-org/example-repo/.github/workflows/x.yml@v1'), calleeText([], '- run: true'))).toEqual([]);
  });

  it('carries the file, the line of the secrets key and the job', () => {
    const [found] = scanSecretMaps(
      new Map([
        [CALLER, callerText(['A'])],
        [CALLEE, calleeText(['A'], '- run: true')],
      ]),
    );
    expect(found).toMatchObject({ rule: 'secret-map', file: CALLER, line: 8, job: 'call' });
  });
});

describe('the allow-list', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ file: WORKFLOW, job: 'a', reason: 'a reason long enough', ...extra });
  const parse = (data: unknown) => parseAllowList(JSON.stringify(data));
  const empty = { secretsInherit: [], pem: [], missingPermissions: [] };

  it('an absent file is an empty list and not a problem', () => {
    expect(parseAllowList(null)).toEqual({ list: empty, problems: [] });
  });

  it('reads the three keys', () => {
    const { list, problems } = parse({ secretsInherit: [entry()], pem: [entry({ job: undefined })], missingPermissions: [entry({ job: 'b' })] });
    expect(problems).toEqual([]);
    expect(list.secretsInherit).toEqual([entry()]);
    expect(list.pem).toEqual([{ file: WORKFLOW, reason: 'a reason long enough' }]);
    expect(list.missingPermissions).toEqual([entry({ job: 'b' })]);
  });

  it.each([
    ['text that is not JSON', 'not json', 'is not valid JSON'],
    ['a list at the top', '[]', 'must be a JSON object'],
    ['null at the top', 'null', 'must be a JSON object'],
    ['an unknown key', JSON.stringify({ secretInherit: [] }), 'has an unknown key secretInherit'],
    ['a key that is not a list', JSON.stringify({ pem: {} }), 'pem must be an array'],
    ['an entry that is not an object', JSON.stringify({ pem: ['x'] }), 'pem holds an entry that is not an object'],
    ['an entry without a file', JSON.stringify({ pem: [{ reason: 'long enough reason' }] }), 'pem holds an entry without a file'],
    ['an entry with an empty file', JSON.stringify({ pem: [entry({ file: '' })] }), 'pem holds an entry without a file'],
    ['an empty job', JSON.stringify({ pem: [entry({ job: '' })] }), `pem entry for ${WORKFLOW} has a job that is not a name`],
    ['a job that is not a name', JSON.stringify({ pem: [entry({ job: 3 })] }), `pem entry for ${WORKFLOW} has a job that is not a name`],
    [
      'a reason that is too short',
      JSON.stringify({ pem: [entry({ reason: 'short' })] }),
      `pem entry for ${WORKFLOW} (job a) needs a reason of at least 8 characters`,
    ],
    [
      'a reason that is missing',
      JSON.stringify({ pem: [entry({ reason: undefined })] }),
      `pem entry for ${WORKFLOW} (job a) needs a reason of at least 8 characters`,
    ],
    [
      'a reason that is not text',
      JSON.stringify({ pem: [entry({ reason: 12345678 })] }),
      `pem entry for ${WORKFLOW} (job a) needs a reason of at least 8 characters`,
    ],
    ['a field it does not know', JSON.stringify({ pem: [entry({ count: 2 })] }), `pem entry for ${WORKFLOW} (job a) has the unknown field count`],
    ['the same entry twice', JSON.stringify({ pem: [entry(), entry()] }), `pem entry for ${WORKFLOW} (job a) is listed twice`],
  ])('reports %s', (_name, source, problem) => {
    expect(parseAllowList(source).problems).toEqual([problem]);
  });

  it('wants a reason of 8 characters: 7 is refused and 8 is kept', () => {
    expect(parse({ pem: [entry({ reason: 'x'.repeat(7) })] }).problems).toHaveLength(1);
    expect(parse({ pem: [entry({ reason: 'x'.repeat(8) })] }).problems).toEqual([]);
    expect(parse({ pem: [entry({ reason: `${' '.repeat(5)}abc` })] }).problems).toHaveLength(1);
  });

  it('keeps no entry that has a problem', () => {
    expect(parse({ pem: [entry({ reason: 'short' })] }).list.pem).toEqual([]);
  });

  const found = (rule: Finding['rule'], job?: string, file = WORKFLOW): Finding => ({ rule, file, line: 3, message: 'm', ...(job ? { job } : {}) });

  it('an entry covers the findings of its rule, file and job, and nothing else', () => {
    const { list } = parse({ missingPermissions: [entry({ job: 'a' })] });
    const result = applyAllowList(
      [
        found('missing-permissions', 'a'),
        found('missing-permissions', 'b'),
        found('missing-permissions', 'a', 'other.yml'),
        found('secrets-inherit', 'a'),
      ],
      list,
    );
    expect(result.allowed.map((f) => f.job)).toEqual(['a']);
    expect(result.kept.map((f) => `${f.rule}:${f.job}:${f.file}`)).toEqual([
      `missing-permissions:b:${WORKFLOW}`,
      'missing-permissions:a:other.yml',
      `secrets-inherit:a:${WORKFLOW}`,
    ]);
    expect(result.stale).toEqual([]);
  });

  it('an entry without a job covers the whole file', () => {
    const { list } = parse({ missingPermissions: [entry({ job: undefined })] });
    const result = applyAllowList([found('missing-permissions', 'a'), found('missing-permissions', 'b'), found('missing-permissions')], list);
    expect(result.kept).toEqual([]);
    expect(result.allowed).toHaveLength(3);
  });

  it('an entry that matches nothing is itself a finding, so the list can only shrink', () => {
    const { list } = parse({ missingPermissions: [entry({ job: 'gone' })], pem: [entry({ job: undefined })] });
    const { stale } = applyAllowList([found('missing-permissions', 'a')], list);
    expect(stale.map((f) => [f.rule, f.file, f.message])).toEqual([
      ['allow-list', ALLOW_LIST_PATH, `pem entry for ${WORKFLOW} matches nothing any more; remove it`],
      ['allow-list', ALLOW_LIST_PATH, `missingPermissions entry for ${WORKFLOW} (job gone) matches nothing any more; remove it`],
    ]);
  });

  it('a rule without a key cannot be allowed', () => {
    const { list } = parse({
      secretsInherit: [entry({ job: undefined })],
      pem: [entry({ job: undefined })],
      missingPermissions: [entry({ job: undefined })],
    });
    const result = applyAllowList([found('dangerous-trigger'), found('unpinned-uses'), found('secret-map')], list);
    expect(result.kept).toHaveLength(3);
    expect(result.stale).toHaveLength(3);
  });

  it('a pem entry covers a private-key finding in its file', () => {
    const { list } = parse({ pem: [entry({ file: 'docs/key.txt', job: undefined })] });
    const result = applyAllowList([found('private-key', undefined, 'docs/key.txt'), found('private-key', undefined, 'docs/other.txt')], list);
    expect(result.allowed.map((f) => f.file)).toEqual(['docs/key.txt']);
    expect(result.kept.map((f) => f.file)).toEqual(['docs/other.txt']);
  });
});

describe('scanRepo on a scratch repository', () => {
  const bad = fixture('tag-pinned.yml');

  it('reads tracked workflows with either extension and composite actions, and nothing untracked', () => {
    const root = makeRepo(
      {
        '.github/workflows/a.yml': bad,
        '.github/workflows/b.yaml': bad,
        '.github/workflows/untracked.yml': bad,
        '.github/actions/x/action.yml': yml('name: x', 'runs:', '  steps:', '    - uses: example-org/example-action@v1'),
        '.github/workflows/notes.txt': 'not a workflow',
      },
      ['.github/workflows/untracked.yml'],
    );
    const result = scanRepo(root);
    expect(result.workflowFiles).toEqual(['.github/actions/x/action.yml', '.github/workflows/a.yml', '.github/workflows/b.yaml']);
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual([
      '.github/actions/x/action.yml:4',
      '.github/workflows/a.yml:10',
      '.github/workflows/b.yaml:10',
    ]);
  });

  it('sorts findings by file, whatever the order the files were added in', () => {
    const files: Record<string, string> = {};
    for (const name of ['z.yml', 'm.yml', 'a.yml'])
      files[`.github/workflows/${name}`] = yml('on:', '  pull_request_target:', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x');
    expect(scanRepo(makeRepo(files)).findings.map((f) => f.file)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/m.yml',
      '.github/workflows/z.yml',
    ]);
  });

  it('reads a tracked file for a private key unless it is a link, binary, over 1 MB, or untracked', () => {
    const key = `${pemHeader('RSA PRIVATE KEY')}\nbody\n`;
    const outside = mkdtempSync(path.join(tmpdir(), 'workflow-hygiene-outside-'));
    scratch.push(outside);
    writeFileSync(path.join(outside, 'secret.txt'), key);
    const root = makeRepo(
      {
        'docs/plain.txt': `intro\n${key}`,
        'docs/binary.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]),
        'docs/big.txt': `${key}${'x'.repeat(1024 * 1024)}`,
        'docs/untracked.txt': key,
        'docs/ordinary.md': 'nothing here',
      },
      ['docs/untracked.txt'],
    );
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'docs/link.txt'));
    execFileSync('git', ['add', '--', 'docs/link.txt'], { cwd: root, env: cleanGitEnv() });
    const result = scanRepo(root);
    expect(result.findings.map((f) => `${f.rule}:${f.file}:${f.line}`)).toEqual(['private-key:docs/plain.txt:2']);
    expect(result.textFiles).toBe(2);
  });

  it('applies the allow-list from the tree, and reports an entry that matches nothing', () => {
    const files = {
      '.github/workflows/a.yml': yml('on:', '  workflow_dispatch:', 'jobs:', '  a:', '    runs-on: x'),
      'docs/key.txt': pemHeader('EC PRIVATE KEY'),
      [ALLOW_LIST_PATH]: JSON.stringify({
        missingPermissions: [{ file: '.github/workflows/a.yml', job: 'a', reason: 'a reason long enough' }],
        pem: [
          { file: 'docs/key.txt', reason: 'a reason long enough' },
          { file: 'docs/gone.txt', reason: 'a reason long enough' },
        ],
      }),
    };
    const result = scanRepo(makeRepo(files));
    expect(result.allowed.map((f) => f.rule)).toEqual(['missing-permissions', 'private-key']);
    expect(result.findings.map((f) => [f.rule, f.message])).toEqual([
      ['allow-list', 'pem entry for docs/gone.txt matches nothing any more; remove it'],
    ]);
  });

  it('lists the allowed findings of one file by line, not by the order in which the rules found them', () => {
    const workflow = `${yml('on:', '  workflow_dispatch:', 'jobs:', '  a:', '    runs-on: x')}# ${pemHeader('EC PRIVATE KEY')}\n`;
    const allow = JSON.stringify({
      missingPermissions: [{ file: '.github/workflows/a.yml', job: 'a', reason: 'a reason long enough' }],
      pem: [{ file: '.github/workflows/a.yml', reason: 'a reason long enough' }],
    });
    const result = scanRepo(makeRepo({ '.github/workflows/a.yml': workflow, [ALLOW_LIST_PATH]: allow }));
    expect(result.findings).toEqual([]);
    expect(result.allowed.map((f) => `${f.rule}@${f.line}`)).toEqual(['missing-permissions@4', 'private-key@6']);
  });

  it('reports a malformed allow-list as a finding', () => {
    const result = scanRepo(makeRepo({ [ALLOW_LIST_PATH]: '{ not json' }));
    expect(result.findings.map((f) => [f.rule, f.file, f.line, f.message])).toEqual([['allow-list', ALLOW_LIST_PATH, 0, 'is not valid JSON']]);
  });

  it('reads a workflow even when it holds a NUL byte or is over 1 MB, because a workflow is never skipped as binary', () => {
    const trigger = yml('on:', '  pull_request_target:', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x');
    const root = makeRepo({
      '.github/workflows/nul.yml': Buffer.from(`${trigger}\0`),
      '.github/workflows/big.yml': `${trigger}# ${'x'.repeat(1024 * 1024)}\n`,
    });
    expect(scanRepo(root).findings.map((f) => `${f.file}:${f.rule}`)).toEqual([
      '.github/workflows/big.yml:dangerous-trigger',
      '.github/workflows/nul.yml:dangerous-trigger',
    ]);
  });

  it('skips a tracked workflow that was deleted from the working tree, instead of failing', () => {
    const root = makeRepo({ '.github/workflows/a.yml': bad, '.github/workflows/b.yml': bad });
    rmSync(path.join(root, '.github/workflows/b.yml'));
    expect(scanRepo(root).workflowFiles).toEqual(['.github/workflows/a.yml']);
  });

  it('lists the files of the repository it is given even when git is told to look elsewhere', () => {
    const other = makeRepo({ '.github/workflows/bad.yml': bad });
    const root = makeRepo({ '.github/workflows/good.yml': withSteps('- run: true') });
    const saved = { ...process.env };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
    try {
      expect(scanRepo(root).workflowFiles).toEqual(['.github/workflows/good.yml']);
    } finally {
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it('throws when git cannot list the files, because a guard that read nothing must not pass', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'workflow-hygiene-nogit-'));
    scratch.push(outside);
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
    try {
      expect(() => scanRepo(outside)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });
});

describe('the command line', () => {
  const fixtureRepo = () =>
    makeRepo({
      '.github/workflows/a.yml': fixture('secrets-inherit.yml'),
      '.github/workflows/b.yml': fixture('tag-pinned.yml'),
    });

  it('exits 0 on a clean tree and prints one summary line', () => {
    const { code, out, err } = run(['--root', makeRepo({ '.github/workflows/a.yml': withSteps('- run: true') })]);
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out).toEqual(['check-workflow-hygiene: 1 workflow file(s) and 1 text file(s) read, 0 finding(s), 0 allow-listed, 0 report-only']);
  });

  it('exits 1 and prints file, line, rule and message for each finding', () => {
    const { code, err } = run(['--root', fixtureRepo()]);
    expect(code).toBe(1);
    expect(err).toEqual([
      '.github/workflows/a.yml:9: [secrets-inherit] job call hands every secret to the workflow it calls; list the secret names instead',
    ]);
  });

  it('prints a whole-file finding without a line number', () => {
    expect(formatFinding({ rule: 'allow-list', file: ALLOW_LIST_PATH, line: 0, message: 'is not valid JSON' })).toBe(
      `${ALLOW_LIST_PATH}: [allow-list] is not valid JSON`,
    );
  });

  it('does not fail on report-only findings, and lists them only with --report', () => {
    const root = makeRepo({ '.github/workflows/b.yml': fixture('tag-pinned.yml') });
    const quiet = run(['--root', root]);
    expect(quiet.code).toBe(0);
    expect(quiet.out.join('\n')).toContain('0 finding(s), 0 allow-listed, 1 report-only');
    expect(quiet.out.join('\n')).not.toContain('example-org/example-action');
    const loud = run(['--root', root, '--report']);
    expect(loud.code).toBe(0);
    expect(loud.out[0]).toBe(
      '.github/workflows/b.yml:10: [unpinned-uses] example-org/example-action@v1 can move; pin it to a full commit and name the release in a trailing comment (report only)',
    );
  });

  it('accepts the separator that a package manager forwards before the flags', () => {
    const root = makeRepo({ '.github/workflows/b.yml': fixture('tag-pinned.yml') });
    const viaPnpm = run(['--', '--report', '--root', root]);
    expect({ code: viaPnpm.code, err: viaPnpm.err }).toEqual({ code: 0, err: [] });
    expect(viaPnpm.out[0]).toContain('[unpinned-uses]');
  });

  it('exits 2 for an argument it does not know, a missing value, and a directory that is not a repository', () => {
    expect(run(['--nope']).code).toBe(2);
    expect(run(['--root']).code).toBe(2);
    const outside = mkdtempSync(path.join(tmpdir(), 'workflow-hygiene-nogit-'));
    scratch.push(outside);
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
    try {
      const result = run(['--root', outside]);
      expect(result.code).toBe(2);
      expect(result.err[0]).toContain('cannot scan');
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });

  it('prints usage for --help', () => {
    const { code, out } = run(['--help']);
    expect(code).toBe(0);
    expect(out[0]).toContain('usage:');
  });

  it('runs as a script: exit 1 with the finding on stderr for a dirty tree, exit 0 for a clean one', () => {
    const script = path.join(REPO_ROOT, 'scripts/check-workflow-hygiene.ts');
    const dirty = spawnSync(process.execPath, ['--import', 'tsx', script, '--root', fixtureRepo()], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('[secrets-inherit]');
    const clean = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, '--root', makeRepo({ '.github/workflows/a.yml': withSteps('- run: true') })],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(clean.status).toBe(0);
  });
});

describe('the real tree', () => {
  const real = scanRepo(REPO_ROOT);
  const errors = real.findings.filter((f) => !isReportOnly(f));

  it('has no dangerous trigger, no hand-over of every secret, no private key, no secret-map mismatch, no allow-list problem', () => {
    expect(errors.map(formatFinding)).toEqual([]);
  });

  it('reads every workflow and composite action in the folders, not a subset', () => {
    const listed = readdirSync(path.join(REPO_ROOT, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name));
    const actions = readdirSync(path.join(REPO_ROOT, '.github/actions')).map((name) => `.github/actions/${name}/action.yml`);
    expect(real.workflowFiles.length).toBe(listed.length + actions.length);
    expect(real.workflowFiles.length).toBeGreaterThan(0);
  });

  it('allows exactly the four release-workflow jobs that call a reusable workflow, and no other missing-permissions finding', () => {
    expect(real.allowed.map((f) => `${f.rule} ${path.basename(f.file)} ${f.job}`)).toEqual([
      'missing-permissions desktop-release.yml build-container',
      'missing-permissions desktop-release.yml upload-r2',
      'missing-permissions desktop-release.yml publish-package-managers',
      'missing-permissions nightly-release.yml e2e-tests',
    ]);
    const { list } = parseAllowList(readFileSync(path.join(REPO_ROOT, ALLOW_LIST_PATH), 'utf8'));
    expect(list.secretsInherit).toEqual([]);
    expect(list.pem).toEqual([]);
    expect(list.missingPermissions).toHaveLength(4);
  });

  it('turns red when a fifth job without permissions is added to a workflow shaped like desktop-release.yml', () => {
    const release = '.github/workflows/desktop-release.yml';
    const nightly = '.github/workflows/nightly-release.yml';
    const source = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const { list } = parseAllowList(readFileSync(path.join(REPO_ROOT, ALLOW_LIST_PATH), 'utf8'));
    const refused = (releaseText: string) => {
      const result = applyAllowList([...scanWorkflow(release, releaseText), ...scanWorkflow(nightly, source(nightly))], list);
      return { kept: result.kept.filter((f) => !isReportOnly(f)).map((f) => `${f.rule}:${f.job}`), stale: result.stale };
    };
    expect(refused(source(release))).toEqual({ kept: [], stale: [] });
    const withFifth = `${source(release).trimEnd()}\n  fifth:\n    uses: ./.github/workflows/e2e.yml\n`;
    expect(refused(withFifth)).toEqual({ kept: ['missing-permissions:fifth'], stale: [] });
  });

  it('lists a tag-referenced action as report-only while the actions are not pinned, and nothing else as report-only', () => {
    expect(new Set(real.findings.filter(isReportOnly).map((f) => f.rule))).toEqual(new Set(['unpinned-uses']));
  });

  it('would catch a hand-over of every secret added to a real workflow', () => {
    const file = '.github/workflows/nightly-release.yml';
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(scanWorkflow(file, source).filter((f) => f.rule === 'secrets-inherit')).toEqual([]);
    const planted = source.replace('    uses: "./.github/workflows/e2e.yml"\n', '    uses: "./.github/workflows/e2e.yml"\n    secrets: inherit\n');
    expect(planted).not.toBe(source);
    expect(scanWorkflow(file, planted).filter((f) => f.rule === 'secrets-inherit')).toHaveLength(1);
  });
});
