const { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } = require('node:fs');
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

/**
 * Tries to symlink the cihub entrypoint into a well-known generic bin
 * directory that is already on PATH (e.g. ~/.local/bin, ~/bin),
 * making it immediately usable in the current shell without requiring a new
 * terminal or a manual `export PATH=...`.
 * Returns the symlink path on success, null on failure.
 */
function trySymlinkToCurrentPath(cliEntrypoint, cliCommand) {
  const home = os.homedir();
  const currentPath = process.env.PATH || '';
  const onPath = new Set(splitPathEntries(currentPath).map((d) => path.resolve(d)));

  // Ordered list of well-known, generic user bin directories (not tool-specific
  // dirs like ~/.cargo/bin or ~/.nvm/...).  We try each in order and pick the
  // first one that is already on PATH (or create it if it's the standard
  // ~/.local/bin which distros/macOS tooling puts on PATH automatically).
  const candidates = [
    path.join(home, '.local', 'bin'), // Linux standard; also works on macOS
    path.join(home, 'bin'), // common on macOS / older Linux setups
    '/usr/local/bin', // macOS default (writable without sudo on most setups)
  ];

  for (const dir of candidates) {
    const isOnPath = onPath.has(path.resolve(dir));
    // Only attempt dirs that are already on PATH (don't silently add unknown dirs)
    if (!isOnPath) continue;
    const linkPath = path.join(dir, cliCommand);
    try {
      mkdirSync(dir, { recursive: true });
      // Remove existing file/symlink (including broken symlinks) so we can re-create it
      try {
        unlinkSync(linkPath);
      } catch {
        /* doesn't exist — fine */
      }
      symlinkSync(cliEntrypoint, linkPath);
      return linkPath;
    } catch {
      // Try next candidate
    }
  }
  return null;
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
  const cliEntrypoint = process.platform === 'win32' ? path.join(cliDir, 'cihub.cjs') : path.join(cliDir, 'cihub');

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

  // First, try to symlink into a directory already on PATH so cihub is
  // immediately usable in the current shell without reopening a terminal.
  const symlinkPath = trySymlinkToCurrentPath(cliEntrypoint, cliCommand);
  if (symlinkPath) {
    appendUnixProfile(cliDir);
    return {
      status: 'symlinked-to-path',
      cliDir,
      cliEntrypoint,
      cliCommand,
      symlinkPath,
      messageLines: [`Companion Hub CLI is now available: ${cliCommand} → ${symlinkPath}`, `Try it now: ${cliCommand} --help`],
    };
  }

  // Fallback: append to shell profile (takes effect in new shells)
  try {
    const profile = appendUnixProfile(cliDir);
    return {
      status: 'configured-shell-profile',
      cliDir,
      cliEntrypoint,
      cliCommand,
      profile,
      messageLines: [
        `Companion Hub CLI path was added to ${profile}.`,
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
