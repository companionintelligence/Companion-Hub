/**
 * Windows uninstall cleanup: the Docker part of `distribution/scripts/uninstall-cleanup.ps1`, the user PATH entry
 * and logon script it removes, the NSIS hook that runs it, and Scoop's inline uninstaller.
 *
 * The NSIS hook, the .msi and Chocolatey run the script with Windows PowerShell 5.1, which drops the inner double
 * quotes of an argument it passes to a program. `--format '{{.Label "com.docker.compose.project"}}'` reached docker
 * as `{{.Label com.docker.compose.project}}`, docker failed with `function "com" not defined`, and the cleanup found
 * no marketplace app to remove: app databases kept running, data and all, after an uninstall.
 *
 * The Docker code runs here under every PowerShell the machine has, against a fake `docker` that answers from a
 * fixture and records each call. `powershell.exe` (Windows only) is the one that loses the quotes. The harness
 * defines the script's functions without running its top-level code and then runs only the Docker block. PATH holds
 * the fake (plus System32 on Windows) and DOCKER_HOST points at a closed port, so the real engine is out of reach,
 * and the part of the script that deletes profile folders never runs.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
// Checkouts with core.autocrlf have CRLF files; compare text with LF line ends.
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf-8').replace(/\r\n/g, '\n');

const PS_SCRIPT = 'distribution/scripts/uninstall-cleanup.ps1';
const PS_SCRIPT_PATH = path.join(repoRoot, PS_SCRIPT);
const SCOOP_MANIFEST = 'distribution/scoop/companion-hub.json';
const SCOOP_MANIFESTS = [SCOOP_MANIFEST, 'distribution/publish/scoop-bucket/companion-hub.json'];
const MANIFEST_GENERATOR = 'distribution/scripts/update-package-manifests.sh';

function extractBlock(source: string, begin: string, end: string): string {
  const start = source.indexOf(begin);
  expect(start, `${begin} not found`).toBeGreaterThanOrEqual(0);
  const stop = source.indexOf(end, start);
  expect(stop, `${end} not found`).toBeGreaterThan(start);
  return source.slice(start, stop + end.length);
}

function findExecutable(tool: string): string | null {
  const names = process.platform === 'win32' ? [`${tool}.exe`] : [tool];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

const systemDir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const windowsPowerShell = path.join(systemDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SHELLS: [string, string][] = [];
if (process.platform === 'win32' && fs.existsSync(windowsPowerShell)) SHELLS.push(['Windows PowerShell 5.1', windowsPowerShell]);
const pwsh = findExecutable('pwsh');
if (pwsh) SHELLS.push(['PowerShell 7', pwsh]);
// Every test that starts PowerShell gets this long: a cold powershell.exe, plus one new process per docker call,
// is slow on a busy Windows machine.
const PS_TIMEOUT = 300_000;
const describeEachShell = SHELLS.length > 0 ? describe.each(SHELLS) : describe.skip.each<[string, string]>([['PowerShell (not installed)', '']]);

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  networks: string[];
}

interface FakeResource {
  name: string;
  labels: Record<string, string>;
}

const hubProject = { 'com.docker.compose.project': 'ci-hub' };
const managed = { 'ci-hub.managed': 'true', 'ci-os-hub.managed': 'true' };
const wordpressProject = { 'com.docker.compose.project': 'wordpress_ci-marketplace', ...managed };
const ANONYMOUS_VOLUME = '512303c264585eba54d38783f0eaa650700800989d35a81e13dc688666e74483';

/** A Windows Hub with WordPress installed, as the manual test left it, plus a compose project of the user's own. */
const FIXTURE: { containers: FakeContainer[]; networks: FakeResource[]; volumes: FakeResource[] } = {
  containers: [
    {
      id: 'c0ffee000001',
      name: 'ci-hub',
      image: 'sha256:hub',
      labels: { ...hubProject, ...managed },
      networks: ['ci-hub_network', 'ci-hub_internal'],
    },
    { id: 'c0ffee000002', name: 'ci-hub-db', image: 'sha256:postgres', labels: hubProject, networks: ['ci-hub_internal'] },
    { id: 'c0ffee000003', name: 'ci-hub-queue', image: 'sha256:rabbitmq', labels: hubProject, networks: ['ci-hub_internal'] },
    {
      id: 'c0ffee000004',
      name: 'traefik',
      image: 'sha256:traefik',
      labels: { ...hubProject, ...managed },
      networks: ['ci-hub_network', 'ci-hub_edge'],
    },
    { id: 'c0ffee000005', name: 'cloudflared', image: 'sha256:cloudflared', labels: hubProject, networks: ['ci-hub_edge'] },
    {
      id: 'a99000000001',
      name: 'wordpress_ci-marketplace-wordpress-1',
      image: 'sha256:wordpress',
      // A label value with commas in it, as compose writes depends_on.
      labels: { ...wordpressProject, 'com.docker.compose.depends_on': 'wordpress-db:service_started:false,mail:service_started:false' },
      networks: ['wordpress_ci-marketplace_network', 'ci-hub_network'],
    },
    // The database is on its app's network only, so only the app pass can find it.
    {
      id: 'a99000000002',
      name: 'wordpress_ci-marketplace-wordpress-db-1',
      image: 'sha256:mariadb',
      labels: wordpressProject,
      networks: ['wordpress_ci-marketplace_network'],
    },
    {
      id: 'b55000000001',
      name: 'devdb',
      image: 'sha256:devpostgres',
      labels: { 'com.docker.compose.project': 'myproject' },
      networks: ['myproject_default'],
    },
  ],
  networks: [
    { name: 'bridge', labels: {} },
    { name: 'host', labels: {} },
    { name: 'none', labels: {} },
    { name: 'ci-hub_edge', labels: hubProject },
    { name: 'ci-hub_internal', labels: hubProject },
    { name: 'ci-hub_network', labels: hubProject },
    { name: 'ci-os-hub_network', labels: hubProject },
    { name: 'wordpress_ci-marketplace_network', labels: wordpressProject },
    { name: 'myproject_default', labels: { 'com.docker.compose.project': 'myproject' } },
  ],
  volumes: [
    { name: 'ci_hub_pgdata', labels: hubProject },
    { name: 'hub_tailscale_state', labels: {} },
    { name: 'wordpress_ci-marketplace_data-mariadb', labels: { 'com.docker.compose.project': 'wordpress_ci-marketplace' } },
    { name: 'myproject_pgdata', labels: { 'com.docker.compose.project': 'myproject' } },
    { name: ANONYMOUS_VOLUME, labels: { 'com.docker.volume.anonymous': '' } },
  ],
};

/** Names and IDs of everything the cleanup must leave alone. */
const NOT_THE_HUBS = ['b55000000001', 'devdb', 'sha256:devpostgres', 'myproject_default', 'myproject_pgdata', ANONYMOUS_VOLUME];

/**
 * The fake docker. It handles the queries the cleanup scripts make, renders the Go templates they use, and fails on
 * any other template the way docker does. Every call is appended to FAKE_DOCKER_LOG as a JSON array of its arguments.
 */
const FAKE_DOCKER_JS = String.raw`'use strict';
const fs = require('node:fs');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function parse(rest) {
  const opts = { filters: [], format: null, quiet: false, targets: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--filter' || arg === '-f') opts.filters.push(rest[++i]);
    else if (arg === '--format') opts.format = rest[++i];
    else if (/^-[a-z]+$/.test(arg)) opts.quiet = opts.quiet || arg.includes('q');
    else opts.targets.push(arg);
  }
  return opts;
}

function matches(item, filter) {
  const [kind, ...valueParts] = filter.split('=');
  const value = valueParts.join('=');
  if (kind === 'label') {
    const eq = value.indexOf('=');
    if (eq < 0) return Object.prototype.hasOwnProperty.call(item.labels, value);
    return item.labels[value.slice(0, eq)] === value.slice(eq + 1);
  }
  if (kind === 'network') return (item.networks || []).includes(value);
  fail('fake docker: unsupported filter ' + filter);
}

function render(template, item) {
  const label = /^\{\{\.Label "([^"]+)"\}\}$/.exec(template);
  if (label) return item.labels[label[1]] ?? '';
  const fields = {
    ID: item.id,
    Names: item.name,
    Name: item.name,
    Image: item.image,
    Labels: Object.entries(item.labels).map(([k, v]) => k + '=' + v).join(','),
  };
  const field = /^\{\{\.(\w+)\}\}$/.exec(template);
  if (field && fields[field[1]] !== undefined) return fields[field[1]];
  const unquoted = /^\{\{\.Label\s+([A-Za-z_]\w*)/.exec(template);
  if (unquoted) fail('failed to parse template: template: :1: function "' + unquoted[1] + '" not defined');
  fail('failed to parse template: the fake does not know ' + template);
}

function list(items, opts, quietField) {
  const selected = items.filter((item) => opts.filters.every((filter) => matches(item, filter)));
  const lines = selected.map((item) => (opts.quiet ? item[quietField] : render(opts.format || '{{.Name}}', item)));
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

const [command, ...rest] = args;
const sub = rest[0];
if (command === 'ps') {
  list(state.containers, parse(rest), 'id');
} else if (command === 'inspect') {
  const opts = parse(rest);
  for (const target of opts.targets) {
    const item = state.containers.find((c) => c.id === target || c.name === target);
    if (!item) fail('Error: No such object: ' + target);
    process.stdout.write(render(opts.format, item) + '\n');
  }
} else if (command === 'images') {
  // No image carries a compose label in the fixture.
} else if ((command === 'network' || command === 'volume') && sub === 'ls') {
  list(command === 'network' ? state.networks : state.volumes, parse(rest.slice(1)), 'name');
} else if (command === 'rm' || (['network', 'volume', 'image'].includes(command) && sub === 'rm')) {
  // Removals are only recorded.
} else {
  fail('fake docker: unsupported command: ' + args.join(' '));
}
`;

interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-windows-uninstall-'));
  sandboxes.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fakeJs = path.join(root, 'fake-docker.cjs');
  fs.writeFileSync(fakeJs, FAKE_DOCKER_JS);
  let fakeDocker: string;
  if (process.platform === 'win32') {
    fakeDocker = path.join(bin, 'docker.cmd');
    fs.writeFileSync(fakeDocker, `@"${process.execPath}" "${fakeJs}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  } else {
    fakeDocker = path.join(bin, 'docker');
    fs.writeFileSync(fakeDocker, `#!${process.execPath}\nrequire(${JSON.stringify(fakeJs)});\n`, { mode: 0o755 });
  }
  const state = path.join(root, 'state.json');
  fs.writeFileSync(state, JSON.stringify(FIXTURE));
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(log, '');

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) env[key] = value;
  }
  env.PATH = (process.platform === 'win32' ? [bin, systemDir] : [bin]).join(path.delimiter);
  env.DOCKER_HOST = 'tcp://127.0.0.1:9';
  env.FAKE_DOCKER_PATH = fakeDocker;
  env.FAKE_DOCKER_STATE = state;
  env.FAKE_DOCKER_LOG = log;
  return { root, env: { ...env, ...extraEnv }, log };
}

/**
 * A PowerShell script that refuses to run unless `docker` is the fake, optionally defines the cleanup script's
 * functions (and nothing else from it), then runs `body`.
 */
function harness(body: string, { importFunctions }: { importFunctions: boolean }): string {
  return [
    'param([string]$CleanupScript, [switch]$DryRun)',
    "$ErrorActionPreference = 'Continue'",
    // pwsh 7.3+ on Windows passes arguments to a .cmd file with the old rules, even in its default mode, and to
    // docker.exe with the standard ones. The fake is a .cmd file, so ask for what the real docker gets.
    "$PSNativeCommandArgumentPassing = 'Standard'",
    "if ((Get-Command docker).Source -ne $env:FAKE_DOCKER_PATH) { throw 'docker is not the fake; refusing to run the cleanup' }",
    ...(importFunctions
      ? [
          '$ast = [System.Management.Automation.Language.Parser]::ParseFile($CleanupScript, [ref]$null, [ref]$null)',
          'foreach ($fn in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {',
          '  . ([scriptblock]::Create($fn.Extent.Text))',
          '}',
        ]
      : []),
    body,
  ].join('\n');
}

function runPowerShell(shell: string, sandbox: Sandbox, script: string, args: string[] = []) {
  const file = path.join(sandbox.root, `harness-${randomUUID()}.ps1`);
  fs.writeFileSync(file, script);
  const policy = process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : [];
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', ...policy, '-File', file, '-CleanupScript', PS_SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    env: sandbox.env,
    timeout: PS_TIMEOUT,
  });
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result;
}

const dockerCalls = (sandbox: Sandbox) =>
  fs
    .readFileSync(sandbox.log, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

const isRemoval = ([command, sub]: string[]) => command === 'rm' || (['network', 'volume', 'image'].includes(command ?? '') && sub === 'rm');
const removals = (sandbox: Sandbox) =>
  dockerCalls(sandbox)
    .filter(isRemoval)
    .map((args) => args.join(' '));

const DOCKER_BLOCK = () => extractBlock(read(PS_SCRIPT), '# BEGIN docker cleanup', '# END docker cleanup');

describeEachShell('uninstall-cleanup.ps1 Docker cleanup under %s', (_name, shell) => {
  let removed: string[];
  let dryRunRemoved: string[];
  let dryRunOutput: string;

  beforeAll(() => {
    const sandbox = makeSandbox();
    runPowerShell(shell, sandbox, harness(DOCKER_BLOCK(), { importFunctions: true }));
    removed = removals(sandbox);

    const drySandbox = makeSandbox();
    const dry = runPowerShell(shell, drySandbox, harness(DOCKER_BLOCK(), { importFunctions: true }), ['-DryRun']);
    dryRunRemoved = removals(drySandbox);
    dryRunOutput = dry.stdout;
  }, 2 * PS_TIMEOUT);

  it("finds each marketplace app's compose project and removes its database container with its anonymous volumes", () => {
    expect(removed).toContain('rm -f -v a99000000002');
  });

  it("removes each app project's network, volume and images", () => {
    expect(removed).toEqual(
      expect.arrayContaining([
        'network rm wordpress_ci-marketplace_network',
        'volume rm wordpress_ci-marketplace_data-mariadb',
        'image rm -f sha256:mariadb',
        'image rm -f sha256:wordpress',
      ]),
    );
  });

  it("removes the Hub's containers with their anonymous volumes", () => {
    for (const name of ['ci-hub', 'ci-hub-db', 'ci-hub-queue', 'traefik', 'cloudflared']) {
      expect(removed).toContain(`rm -f -v ${name}`);
    }
    expect(removed.filter((call) => call.startsWith('rm ') && !call.startsWith('rm -f -v '))).toEqual([]);
  });

  it("removes every network and volume labelled with the Hub's compose project, and the Hub volume without a label", () => {
    expect(removed).toEqual(
      expect.arrayContaining([
        'network rm ci-hub_edge',
        'network rm ci-hub_internal',
        'network rm ci-hub_network',
        'network rm ci-os-hub_network',
        'volume rm ci_hub_pgdata',
        'volume rm hub_tailscale_state',
      ]),
    );
  });

  it('leaves a compose project the Hub did not create, and unlabelled anonymous volumes, alone', () => {
    expect(removed.filter((call) => NOT_THE_HUBS.some((name) => call.includes(name)))).toEqual([]);
  });

  it('with -DryRun lists the removals and runs none of them', () => {
    expect(dryRunRemoved).toEqual([]);
    expect(dryRunOutput).toContain('[cleanup][DRYRUN] Would run: docker rm -f -v a99000000002');
    expect(dryRunOutput).toContain('[cleanup][DRYRUN] Would run: docker volume rm wordpress_ci-marketplace_data-mariadb');
    expect(dryRunOutput).toContain('[cleanup][DRYRUN] Would run: docker network rm ci-hub_edge');
  });
});

describeEachShell('uninstall-cleanup.ps1 user PATH entry under %s', (_name, shell) => {
  const HUB_BIN = 'C:\\Users\\u\\AppData\\Local\\Companion Hub\\bin';
  const UNCHANGED = '<unchanged>';

  it(
    'drops the Hub CLI folder from a PATH value and keeps every other entry as written',
    () => {
      const cases: [string, string][] = [
        [
          `${HUB_BIN};%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools`,
          '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
        ],
        ['C:\\Tools;c:\\users\\u\\appdata\\local\\companion hub\\bin\\;C:\\Other', 'C:\\Tools;C:\\Other'],
        ['%HUB_TEST_LOCALAPPDATA%\\Companion Hub\\bin;C:\\Tools', 'C:\\Tools'],
        ['C:\\Users\\u\\AppData\\Local\\Companion Hub\\binaries;C:\\Tools', UNCHANGED],
        ['C:\\Tools;C:\\Other', UNCHANGED],
      ];
      const sandbox = makeSandbox({ HUB_TEST_LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
      const casesFile = path.join(sandbox.root, 'cases.txt');
      fs.writeFileSync(casesFile, cases.map(([value]) => value).join('\n'));
      const body = [
        `foreach ($value in (Get-Content -LiteralPath '${casesFile}')) {`,
        `  $updated = Remove-PathListEntry $value '${HUB_BIN}'`,
        `  if ($null -eq $updated) { 'result=${UNCHANGED}' } else { "result=$updated" }`,
        '}',
      ].join('\n');
      const result = runPowerShell(shell, sandbox, harness(body, { importFunctions: true }));
      const results = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('result='))
        .map((line) => line.slice('result='.length));
      expect(results).toEqual(cases.map(([, expected]) => expected));
    },
    PS_TIMEOUT,
  );

  describe.skipIf(process.platform !== 'win32')('in the registry', () => {
    function runAgainstTempKey(args: string[]) {
      const keyName = `Software\\CompanionHubUninstallTest-${randomUUID()}`;
      const body = [
        `$name = '${keyName}'`,
        '$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($name)',
        'try {',
        `  $key.SetValue('Path', '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;${HUB_BIN};C:\\Tools', [Microsoft.Win32.RegistryValueKind]::ExpandString)`,
        '  $key.Close()',
        `  $changed = Remove-UserPathEntry '${HUB_BIN}' $name`,
        '  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name)',
        '  "changed=$changed"',
        `  "kind=$($key.GetValueKind('Path'))"`,
        `  "value=$($key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))"`,
        '} finally {',
        '  $key.Close()',
        '  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($name, $false)',
        '}',
      ].join('\n');
      const result = runPowerShell(shell, makeSandbox(), harness(body, { importFunctions: true }), args);
      const field = (name: string) =>
        result.stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith(`${name}=`))
          ?.slice(name.length + 1);
      return { changed: field('changed'), kind: field('kind'), value: field('value') };
    }

    it(
      'removes the entry and keeps the value expandable, with %USERPROFILE% entries unexpanded',
      () => {
        expect(runAgainstTempKey([])).toEqual({
          changed: 'True',
          kind: 'ExpandString',
          value: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
        });
      },
      PS_TIMEOUT,
    );

    it(
      'with -DryRun leaves the value as it was',
      () => {
        expect(runAgainstTempKey(['-DryRun'])).toEqual({
          changed: 'False',
          kind: 'ExpandString',
          value: `%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;${HUB_BIN};C:\\Tools`,
        });
      },
      PS_TIMEOUT,
    );
  });
});

describeEachShell('uninstall-cleanup.ps1 -DryRun on files under %s', (_name, shell) => {
  it(
    'lists the data folder and tunnel files it would remove and deletes none of them',
    () => {
      const sandbox = makeSandbox();
      const appData = path.join(sandbox.root, 'appdata');
      const hubData = path.join(appData, 'companion-hub');
      const tunnel = path.join(appData, 'tunnel');
      fs.mkdirSync(path.join(hubData, 'state'), { recursive: true });
      fs.writeFileSync(path.join(hubData, 'state', 'settings.json'), '{}');
      fs.mkdirSync(path.join(tunnel, 'certs'), { recursive: true });
      fs.writeFileSync(path.join(tunnel, 'token'), Buffer.from(JSON.stringify({ a: 'account', t: 'tunnel', s: 'secret' })).toString('base64'));
      fs.writeFileSync(path.join(tunnel, 'registration.json'), JSON.stringify({ tunnelId: 'tunnel' }));

      const body = [`Remove-IfExists '${hubData}'`, `Remove-HubTunnelFiles '${tunnel}'`].join('\n');
      const result = runPowerShell(shell, sandbox, harness(body, { importFunctions: true }), ['-DryRun']);

      expect(fs.readdirSync(path.join(hubData, 'state'))).toEqual(['settings.json']);
      expect(fs.readdirSync(tunnel).sort()).toEqual(['certs', 'registration.json', 'token']);
      expect(result.stdout).toContain(`[cleanup][DRYRUN] Would remove ${hubData}`);
      expect(result.stdout).toContain(`[cleanup][DRYRUN] Would remove ${path.join(tunnel, 'token')}`);
      expect(result.stdout).toContain(`[cleanup][DRYRUN] Would remove ${path.join(tunnel, 'registration.json')}`);
    },
    PS_TIMEOUT,
  );
});

describeEachShell('Scoop uninstaller under %s', (_name, shell) => {
  // The publish copy carries the same script; the generator test below checks that.
  it(
    "removes every marketplace app's containers and keeps all volumes and images",
    () => {
      const script = (JSON.parse(read(SCOOP_MANIFEST)) as { uninstaller: { script: string[] } }).uninstaller.script.join('\n');
      const sandbox = makeSandbox();
      runPowerShell(shell, sandbox, harness(script, { importFunctions: false }));
      const removed = removals(sandbox);
      expect(removed).toEqual(expect.arrayContaining(['rm -f a99000000002', 'network rm wordpress_ci-marketplace_network']));
      // `scoop update` runs this uninstaller too, so it must never touch data or images.
      expect(removed.filter((call) => call.startsWith('volume rm') || call.startsWith('image rm'))).toEqual([]);
      expect(removed.filter((call) => NOT_THE_HUBS.some((name) => call.includes(name)))).toEqual([]);
    },
    PS_TIMEOUT,
  );
});

describe('Windows uninstall scripts', () => {
  const ps = read(PS_SCRIPT);

  it('pass docker no Go template with a double quote in it, which Windows PowerShell 5.1 would strip', () => {
    const generator = read(MANIFEST_GENERATOR);
    const sources: [string, string][] = [
      [PS_SCRIPT, ps],
      ...SCOOP_MANIFESTS.map((file): [string, string] => [file, read(file)]),
      [`${MANIFEST_GENERATOR} (Scoop template)`, generator.slice(generator.indexOf('cat >"$SCOOP" <<JSON'), generator.indexOf('\nJSON\n'))],
    ];
    for (const [file, content] of sources) {
      const templates = [...content.matchAll(/--format\s+'([^']*)'/g)].map((match) => match[1] ?? '');
      expect(templates.length, `no --format templates found in ${file}`).toBeGreaterThan(0);
      expect(
        templates.filter((template) => template.includes('"')),
        file,
      ).toEqual([]);
    }
  });

  it('Scoop manifests carry the uninstaller the release generator writes', () => {
    const generator = read(MANIFEST_GENERATOR);
    const template = generator.slice(generator.indexOf('cat >"$SCOOP" <<JSON'), generator.indexOf('\nJSON\n'));
    const scriptLines = template.slice(template.indexOf('"script": [', template.indexOf('"uninstaller"')) + '"script": '.length);
    // The heredoc is unquoted, so bash removes the backslash before $, ` and \ when it writes the manifest.
    const unescaped = scriptLines.slice(0, scriptLines.indexOf('\n    ]') + '\n    ]'.length).replace(/\\([$`\\])/g, '$1');
    const generated = JSON.parse(unescaped) as string[];
    for (const manifest of SCOOP_MANIFESTS) {
      expect((JSON.parse(read(manifest)) as { uninstaller: { script: string[] } }).uninstaller.script, manifest).toEqual(generated);
    }
  });

  it('removes the logon script the WSL engine install writes, for the current user and every profile', () => {
    const engine = read('packages/desktop/src-tauri/src/hub_manager/installers/engine_alt.rs');
    const vbs = /Join-Path \$startup '([^']+\.vbs)'/.exec(engine)?.[1];
    expect(vbs).toBe('CompanionHub-WSL-Docker.vbs');
    expect(ps).toContain(`Remove-IfExists (Join-Path ([Environment]::GetFolderPath('Startup')) '${vbs}')`);
    expect(ps).toContain(`Remove-IfExists (Join-Path $profilePath 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${vbs}')`);
  });

  it('removes the folder the desktop app adds to the user PATH', () => {
    const cliInstall = read('packages/desktop/src-tauri/src/hub_manager/cli_install.rs');
    expect(cliInstall).toContain('dirs::data_local_dir().map(|dir| dir.join("Companion Hub").join("bin"))');
    expect(ps).toContain("Remove-UserPathEntry (Join-Path $localAppData 'Companion Hub\\bin')");
  });

  it('NSIS hook closes the running app before it runs the cleanup, and not in update mode', () => {
    const hooks = read('packages/desktop/src-tauri/windows/installer-hooks.nsh');
    const macro = extractBlock(hooks, '!macro NSIS_HOOK_PREUNINSTALL', '!macroend');
    const updateGuard = macro.indexOf('StrCmp $UpdateMode "1" ci_hub_skip_cleanup');
    const closeApp = macro.indexOf('!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"');
    const cleanup = macro.indexOf('nsExec::ExecToLog');
    expect(updateGuard, 'update-mode guard missing').toBeGreaterThanOrEqual(0);
    expect(closeApp, 'running-app check missing or before the update-mode guard').toBeGreaterThan(updateGuard);
    expect(cleanup, 'cleanup runs before the running-app check').toBeGreaterThan(closeApp);
  });
});
