#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

type OsFamily = 'debian' | 'rpm' | 'arch' | 'unknown';

type NvidiaProbe = {
  model: string;
  vramMb: number;
  driverVersion: string;
  source: 'host-nvidia-smi';
  updatedAt: string;
};

function runCapture(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: process.env,
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
}

function hasCommand(cmd: string): boolean {
  if (process.platform === 'win32') {
    const where = runCapture('where', [cmd]);
    if (where.ok) return true;

    const ps = runCapture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `if (Get-Command ${cmd} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
    ]);
    return ps.ok;
  }

  const res = runCapture('sh', ['-lc', `command -v ${cmd} >/dev/null 2>&1`]);
  return res.ok;
}

function runCommand(cmd: string, args: string[], useSudo = false) {
  let finalCmd = cmd;
  let finalArgs = args;

  if (useSudo) {
    if (!hasCommand('sudo')) {
      console.warn(`init-gpu-runtime: sudo is unavailable, cannot run: ${cmd} ${args.join(' ')}`);
      return false;
    }

    // Non-interactive sudo avoids hanging startup in desktop/service contexts.
    const sudoCheck = runCapture('sudo', ['-n', 'true']);
    if (!sudoCheck.ok) {
      console.warn(`init-gpu-runtime: sudo requires interactive authentication; skipping: ${cmd} ${args.join(' ')}`);
      return false;
    }

    finalCmd = 'sudo';
    finalArgs = ['-n', cmd, ...args];
  }

  const printable = `${finalCmd} ${finalArgs.join(' ')}`.trim();
  console.log(`init-gpu-runtime: > ${printable}`);

  const result = spawnSync(finalCmd, finalArgs, {
    stdio: 'inherit',
    encoding: 'utf-8',
    env: process.env,
  });

  return result.status === 0;
}

function parseOsRelease(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const content = readFileSync('/etc/os-release', 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx);
      let value = trimmed.slice(idx + 1);
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
    // ignore and fallback to unknown
  }
  return values;
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
    // ignore
  }
  return values;
}

function resolveStateDir(): string {
  const internalDir = process.env.CI_HUB_STATE_PATH || process.env.STATE_PATH;
  if (internalDir) return path.join(internalDir, 'state');

  const envFile = process.env.ENV_FILE;
  if (envFile) {
    const fromEnvFile = parseEnvFile(path.resolve(process.cwd(), envFile)).ROOT_FOLDER_HOST;
    if (fromEnvFile) {
      const rootFolder = path.isAbsolute(fromEnvFile) ? fromEnvFile : path.resolve(process.cwd(), fromEnvFile);
      return path.join(rootFolder, 'state');
    }
  }

  const rootFromEnv = process.env.ROOT_FOLDER_HOST;
  if (rootFromEnv) {
    const rootFolder = path.isAbsolute(rootFromEnv) ? rootFromEnv : path.resolve(process.cwd(), rootFromEnv);
    return path.join(rootFolder, 'state');
  }

  return path.resolve(process.cwd(), '.internal', 'state');
}

function nvidiaProbePath(): string {
  return path.join(resolveStateDir(), 'hardware', 'nvidia.json');
}

function writeNvidiaProbe(probe: NvidiaProbe): void {
  const outPath = nvidiaProbePath();
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  console.log(`init-gpu-runtime: wrote NVIDIA probe cache to ${outPath}`);
}

function clearNvidiaProbe(): void {
  const outPath = nvidiaProbePath();
  if (!existsSync(outPath)) return;
  try {
    rmSync(outPath);
    console.log(`init-gpu-runtime: removed stale NVIDIA probe cache at ${outPath}`);
  } catch {
    // best effort
  }
}

function collectHostNvidiaProbe(): NvidiaProbe | null {
  const probe = runCapture('sh', ['-lc', 'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits | head -n 1']);
  if (!probe.ok) return null;

  const line = probe.stdout
    .split('\n')
    .map((v) => v.trim())
    .find((v) => v.length > 0);
  if (!line) return null;

  const [modelRaw, memoryRaw, driverRaw] = line.split(',').map((v) => v.trim());
  const vramMb = Number.parseInt(memoryRaw || '', 10);
  if (!modelRaw) return null;

  return {
    model: modelRaw,
    vramMb: Number.isFinite(vramMb) && vramMb > 0 ? vramMb : 0,
    driverVersion: driverRaw || '',
    source: 'host-nvidia-smi',
    updatedAt: new Date().toISOString(),
  };
}

function detectOsFamily(): OsFamily {
  const info = parseOsRelease();
  const id = (info.ID || '').toLowerCase();
  const like = (info.ID_LIKE || '').toLowerCase();
  const probe = `${id} ${like}`;

  if (probe.includes('debian') || probe.includes('ubuntu')) return 'debian';
  if (probe.includes('rhel') || probe.includes('fedora') || probe.includes('centos') || probe.includes('rocky') || probe.includes('amzn')) {
    return 'rpm';
  }
  if (probe.includes('arch') || probe.includes('manjaro')) return 'arch';
  return 'unknown';
}

function dockerHasNvidiaRuntime(): boolean {
  const info = runCapture('docker', ['info', '--format', '{{json .Runtimes}}']);
  if (!info.ok) return false;
  return info.stdout.includes('"nvidia"');
}

function hasNvidiaGpuLinux(): boolean {
  if (existsSync('/proc/driver/nvidia/gpus')) return true;

  const smi = runCapture('sh', ['-lc', 'nvidia-smi -L']);
  if (smi.ok && smi.stdout.toLowerCase().includes('gpu')) return true;

  const lspci = runCapture('sh', ['-lc', "lspci 2>/dev/null | grep -i 'nvidia' || true"]);
  return lspci.stdout.trim().length > 0;
}

function hasNvidiaGpuMac(): boolean {
  const sp = runCapture('sh', ['-lc', "system_profiler SPDisplaysDataType 2>/dev/null | grep -i 'nvidia' || true"]);
  return sp.stdout.trim().length > 0;
}

function hasNvidiaGpuWindows(): boolean {
  const ps = runCapture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | Out-String)',
  ]);

  if (!ps.ok) return false;
  return ps.stdout.toLowerCase().includes('nvidia');
}

function restartDockerDaemonLinux(): boolean {
  return runCommand('systemctl', ['restart', 'docker'], true) || runCommand('service', ['docker', 'restart'], true);
}

function configureNvidiaRuntimeLinux(): { ok: boolean; restartRecommended: boolean } {
  if (!runCommand('nvidia-ctk', ['runtime', 'configure', '--runtime=docker'], true)) {
    return { ok: false, restartRecommended: false };
  }

  // Do not restart Docker automatically by default; this can disrupt unrelated workloads.
  if (dockerHasNvidiaRuntime()) {
    return { ok: true, restartRecommended: false };
  }

  if (process.env.CI_HUB_ALLOW_DOCKER_RESTART === 'true') {
    const restarted = restartDockerDaemonLinux();
    if (restarted && dockerHasNvidiaRuntime()) {
      return { ok: true, restartRecommended: false };
    }
  }

  return { ok: true, restartRecommended: true };
}

function installToolkitDebian(): boolean {
  if (!runCommand('mkdir', ['-p', '/etc/apt/keyrings'], true)) return false;

  const keyCmd =
    'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg';
  if (!runCommand('sh', ['-lc', keyCmd], true)) return false;

  const listCmd =
    "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null";
  if (!runCommand('sh', ['-lc', listCmd], true)) return false;

  if (!runCommand('apt-get', ['update'], true)) return false;
  return runCommand('apt-get', ['install', '-y', 'nvidia-container-toolkit'], true);
}

function installToolkitRpm(): boolean {
  const repoCmd =
    'curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null';
  if (!runCommand('sh', ['-lc', repoCmd], true)) return false;

  if (hasCommand('dnf')) {
    return runCommand('dnf', ['install', '-y', 'nvidia-container-toolkit'], true);
  }

  if (hasCommand('yum')) {
    return runCommand('yum', ['install', '-y', 'nvidia-container-toolkit'], true);
  }

  return false;
}

function installToolkitArch(): boolean {
  return runCommand('pacman', ['-Sy', '--noconfirm', 'nvidia-container-toolkit'], true);
}

function tryInstallLinuxToolkit(): boolean {
  const osFamily = detectOsFamily();
  if (osFamily === 'debian') return installToolkitDebian();
  if (osFamily === 'rpm') return installToolkitRpm();
  if (osFamily === 'arch') return installToolkitArch();

  console.warn('init-gpu-runtime: Unsupported Linux distribution for automatic nvidia-container-toolkit installation.');
  return false;
}

function warnCpuFallback(reason: string) {
  console.warn(`init-gpu-runtime: ${reason}`);
  console.warn('init-gpu-runtime: Continuing startup in CPU-only mode.');
}

function main() {
  if (process.env.CI_HUB_SKIP_GPU_TOOLKIT === 'true') {
    console.log('init-gpu-runtime: Skipping GPU toolkit setup (CI_HUB_SKIP_GPU_TOOLKIT=true).');
    return;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    clearNvidiaProbe();
    if (!hasNvidiaGpuWindows()) {
      console.log('init-gpu-runtime: No NVIDIA GPU detected on Windows. Skipping GPU runtime setup.');
      return;
    }

    console.log('init-gpu-runtime: NVIDIA GPU detected on Windows.');
    if (!hasCommand('docker')) {
      warnCpuFallback('Docker Desktop CLI is unavailable. Install or start Docker Desktop and retry.');
      return;
    }

    console.log('init-gpu-runtime: Docker Desktop uses WSL2 GPU support instead of nvidia-container-toolkit.');
    console.log('init-gpu-runtime: Ensure Docker Desktop + WSL2 GPU integration is enabled.');
    return;
  }

  if (platform === 'darwin') {
    clearNvidiaProbe();
    if (!hasNvidiaGpuMac()) {
      console.log('init-gpu-runtime: No NVIDIA GPU detected on macOS. Skipping GPU runtime setup.');
      return;
    }

    warnCpuFallback('NVIDIA container runtime auto-setup is not supported on macOS.');
    return;
  }

  if (platform === 'linux') {
    if (!hasCommand('docker')) {
      warnCpuFallback('Docker is not available yet, skipping GPU runtime setup.');
      return;
    }

    if (!hasNvidiaGpuLinux()) {
      clearNvidiaProbe();
      console.log('init-gpu-runtime: No NVIDIA GPU detected. Skipping nvidia-container-toolkit setup.');
      return;
    }

    const hostProbe = collectHostNvidiaProbe();
    if (hostProbe) {
      writeNvidiaProbe(hostProbe);
    } else {
      clearNvidiaProbe();
      console.warn('init-gpu-runtime: Failed to collect host NVIDIA probe; cleared stale NVIDIA probe cache.');
    }

    if (dockerHasNvidiaRuntime()) {
      console.log('init-gpu-runtime: NVIDIA runtime already configured in Docker.');
      return;
    }

    if (!hasCommand('sudo')) {
      warnCpuFallback('sudo is unavailable, cannot install nvidia-container-toolkit automatically.');
      return;
    }

    console.log('init-gpu-runtime: NVIDIA GPU detected. Installing and configuring nvidia-container-toolkit...');
    const installed = tryInstallLinuxToolkit();
    if (!installed) {
      warnCpuFallback('Failed to install nvidia-container-toolkit automatically.');
      return;
    }

    const configured = configureNvidiaRuntimeLinux();
    if (!configured.ok) {
      warnCpuFallback('Toolkit installed but failed to configure NVIDIA runtime.');
      return;
    }

    if (configured.restartRecommended) {
      warnCpuFallback(
        'Toolkit configured but Docker restart is required to activate NVIDIA runtime. Restart Docker manually, or set CI_HUB_ALLOW_DOCKER_RESTART=true to permit automatic restart.',
      );
      return;
    }

    if (dockerHasNvidiaRuntime()) {
      console.log('init-gpu-runtime: NVIDIA runtime configured successfully.');
    } else {
      warnCpuFallback('NVIDIA runtime still not visible in docker info after configuration.');
    }
    return;
  }

  console.log(`init-gpu-runtime: Platform ${platform} is not supported for automatic NVIDIA toolkit setup.`);
}

try {
  main();
} catch (error) {
  warnCpuFallback(`Unexpected GPU setup error: ${String(error)}`);
}
