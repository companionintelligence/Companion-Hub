const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function normalizePathEntry(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function splitPathEntries(value) {
  return (value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pathContains(dir, value) {
  const target = normalizePathEntry(path.resolve(dir));
  return splitPathEntries(value).some((entry) => normalizePathEntry(path.resolve(entry)) === target);
}

function preferredUnixProfile() {
  const shell = path.basename(process.env.SHELL || '');
  const home = os.homedir();
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'bash') return path.join(home, '.bashrc');
  return path.join(home, '.profile');
}

function appendUnixProfile(dir) {
  const profile = preferredUnixProfile();
  const line = `export PATH="${dir}:$PATH"`;
  const marker = '# Companion Hub CLI';
  const current = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
  if (!current.includes(line)) {
    mkdirSync(path.dirname(profile), { recursive: true });
    const prefix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
    appendFileSync(profile, `${prefix}${marker}\n${line}\n`, 'utf8');
  }
  return profile;
}

function setWindowsUserPath(dir) {
  const script = [
    `$target = '${dir.replace(/'/g, "''")}'`,
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    '$entries = @()',
    "if ($current) { $entries = $current -split ';' | Where-Object { $_ -and $_.Trim() -ne '' } }",
    'if ($entries -contains $target) { exit 0 }',
    '$entries += $target',
    "[Environment]::SetEnvironmentVariable('Path', (($entries | Select-Object -Unique) -join ';'), 'User')",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return (result.status ?? 1) === 0;
}

function ensureRepoCliOnPath(repoRoot) {
  const cliDir = path.join(repoRoot, 'bin');
  const cliCommand = 'cihub';
  const cliEntrypoint = path.join(cliDir, 'cihub.cjs');

  if (!existsSync(cliEntrypoint)) {
    return {
      status: 'missing-entrypoint',
      cliDir,
      cliEntrypoint,
      cliCommand,
      messageLines: [`Companion Hub CLI entrypoint not found at ${cliEntrypoint}.`],
    };
  }

  if (pathContains(cliDir, process.env.PATH || '')) {
    return {
      status: 'already-available',
      cliDir,
      cliEntrypoint,
      cliCommand,
      messageLines: [`Companion Hub CLI should already be available on PATH from ${cliDir}.`, `Try: ${cliCommand} --help`],
    };
  }

  if (process.platform === 'win32') {
    const updated = setWindowsUserPath(cliDir);
    return {
      status: updated ? 'configured-user-path' : 'manual-path-needed',
      cliDir,
      cliEntrypoint,
      cliCommand,
      messageLines: updated
        ? [
            `Companion Hub CLI path was added to your Windows user PATH: ${cliDir}`,
            'Open a new PowerShell or Command Prompt, then try:',
            `  ${cliCommand} --help`,
            'If the current shell still cannot find it, run:',
            `  $env:Path = "${cliDir};" + $env:Path`,
          ]
        : [
            `Companion Hub CLI should be available from: ${cliDir}`,
            'Add it to your user PATH, then try:',
            `  ${cliCommand} --help`,
            'Example for PowerShell:',
            `  $env:Path = "${cliDir};" + $env:Path`,
          ],
    };
  }

  try {
    const profile = appendUnixProfile(cliDir);
    return {
      status: 'configured-shell-profile',
      cliDir,
      cliEntrypoint,
      cliCommand,
      profile,
      messageLines: [
        `Companion Hub CLI path was checked and ensured in ${profile}.`,
        `Companion Hub CLI should be available from: ${cliDir}`,
        'Open a new shell, or run this in your current shell, then try:',
        `  export PATH="${cliDir}:$PATH"`,
        `  ${cliCommand} --help`,
      ],
    };
  } catch {
    return {
      status: 'manual-path-needed',
      cliDir,
      cliEntrypoint,
      cliCommand,
      messageLines: [
        `Companion Hub CLI should be available from: ${cliDir}`,
        'Add it to your shell PATH, then try:',
        `  export PATH="${cliDir}:$PATH"`,
        `  ${cliCommand} --help`,
      ],
    };
  }
}

module.exports = {
  ensureRepoCliOnPath,
};
