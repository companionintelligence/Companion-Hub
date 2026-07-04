#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isDirectScriptRun } from './lib/is-direct-run';
import { parseEnvFile } from './env-file';

type OsFamily = 'debian' | 'rpm' | 'arch' | 'unknown';

type NvidiaProbe = {
  model: string;
  vramMb: number;
  driverVersion: string;
  source: 'host-nvidia-smi' | 'host-windows-wmi';
  updatedAt: string;
};

function runCapture(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
}

/** Which Docker backend the host CLI is talking to (Windows only). */
type WindowsDockerBackend = 'desktop' | 'wsl-engine' | 'unknown';

/**
 * Classify the Windows Docker backend, mirroring hub_manager.rs
 * `detect_windows_docker_host_style_via_daemon`: active context first
 * (daemon-independent), then the daemon's own OS/kernel self-report.
 * - Docker Desktop provides the container GPU runtime via its WSL2 integration.
 * - A native dockerd inside a WSL2 distro needs nvidia-container-toolkit just
 *   like native Linux, installed *inside* that distro.
 */
function detectWindowsDockerBackend(): WindowsDockerBackend {
  const context = runCapture('docker', ['context', 'show']);
  if (context.ok) {
    const name = context.stdout.trim();
    if (name === 'wsl-engine') return 'wsl-engine';
    if (name === 'desktop-linux' || name === 'desktop-windows') return 'desktop';
  }

  const info = runCapture('docker', ['info', '--format', '{{.OperatingSystem}}\t{{.KernelVersion}}']);
  if (info.ok) {
    const [osName = '', kernel = ''] = info.stdout.trim().split('\t');
    if (osName.includes('Docker Desktop')) return 'desktop';
    const k = kernel.toLowerCase();
    if (k.includes('microsoft') || k.includes('wsl')) return 'wsl-engine';
  }

  return 'unknown';
}

/** Name of the WSL2 distro hosting the Docker engine (the installer provisions Ubuntu). */
function findWslDistro(): string | null {
  // WSL_UTF8=1 makes wsl.exe emit UTF-8 instead of UTF-16LE (matches the engine installer).
  const res = runCapture('wsl.exe', ['-l', '-q'], { WSL_UTF8: '1' });
  if (!res.ok) return null;

  const distros = res.stdout
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return distros.find((d) => d === 'Ubuntu' || /^Ubuntu-/.test(d)) ?? distros[0] ?? null;
}

/** Run a shell script as root inside the given WSL2 distro. */
function runInWslDistro(distro: string, script: string): boolean {
  console.log(`init-gpu-runtime: > wsl -d ${distro} -u root -- sh -lc '<script>'`);
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '--', 'sh', '-lc', script], {
    stdio: 'inherit',
    encoding: 'utf-8',
    env: { ...process.env, WSL_UTF8: '1' },
  });
  return result.status === 0;
}

/**
 * Install + configure nvidia-container-toolkit inside a WSL2 distro that runs a
 * native Docker Engine. The Windows NVIDIA driver already exposes the GPU into
 * WSL2 (`/dev/dxg`, `/usr/lib/wsl/lib/libcuda.so`); this registers the `nvidia`
 * runtime with the in-distro dockerd. The installer only provisions Ubuntu, so
 * the Debian apt flow applies. Runs as root via `wsl -u root` (no sudo needed).
 */
function setupNvidiaToolkitInWslDistro(distro: string): boolean {
  const script = [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'install -d -m 0755 /etc/apt/keyrings',
    'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg',
    "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null",
    'apt-get update',
    'apt-get install -y nvidia-container-toolkit',
    'nvidia-ctk runtime configure --runtime=docker',
    // Restart the in-distro daemon so the nvidia runtime registers.
    'systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true',
  ].join('\n');
  return runInWslDistro(distro, script);
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

type RocmProbe = {
  available: boolean;
  source: 'host-rocm-smi' | 'host-dev-kfd';
  updatedAt: string;
};

function rocmProbePath(): string {
  return path.join(resolveStateDir(), 'hardware', 'rocm.json');
}

function writeRocmProbe(probe: RocmProbe): void {
  const outPath = rocmProbePath();
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  console.log(`init-gpu-runtime: wrote ROCm probe cache to ${outPath} (available=${probe.available})`);
}

function collectHostRocmProbeLinux(): RocmProbe {
  const hasKfd = existsSync('/dev/kfd') && existsSync('/dev/dri');
  if (hasKfd) {
    return { available: true, source: 'host-dev-kfd', updatedAt: new Date().toISOString() };
  }

  const smi = runCapture('sh', ['-lc', 'rocm-smi --version']);
  if (smi.ok && smi.stdout.trim().length > 0) {
    return { available: false, source: 'host-rocm-smi', updatedAt: new Date().toISOString() };
  }

  return { available: false, source: 'host-dev-kfd', updatedAt: new Date().toISOString() };
}

function probeHostRocmLinux(): void {
  writeRocmProbe(collectHostRocmProbeLinux());
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

function collectHostNvidiaProbeWindows(): NvidiaProbe | null {
  const probe = runCapture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 Name,AdapterRAM,DriverVersion; if ($null -eq $gpu) { exit 3 }; $gpu | ConvertTo-Json -Compress",
  ]);
  if (!probe.ok) return null;

  try {
    const parsed = JSON.parse(probe.stdout) as {
      Name?: string;
      AdapterRAM?: number;
      DriverVersion?: string;
    };
    const model = parsed.Name?.trim() || '';
    if (!model) return null;

    const vramMb =
      typeof parsed.AdapterRAM === 'number' && Number.isFinite(parsed.AdapterRAM) ? Math.max(0, Math.floor(parsed.AdapterRAM / (1024 * 1024))) : 0;

    return {
      model,
      vramMb,
      driverVersion: parsed.DriverVersion?.trim() || '',
      source: 'host-windows-wmi',
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
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

export function initGpuRuntime() {
  if (process.env.CI_HUB_SKIP_GPU_TOOLKIT === 'true') {
    console.log('init-gpu-runtime: Skipping GPU toolkit setup (CI_HUB_SKIP_GPU_TOOLKIT=true).');
    return;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    if (!hasNvidiaGpuWindows()) {
      clearNvidiaProbe();
      console.log('init-gpu-runtime: No NVIDIA GPU detected on Windows. Skipping GPU runtime setup.');
      return;
    }

    console.log('init-gpu-runtime: NVIDIA GPU detected on Windows.');
    const hostProbe = collectHostNvidiaProbeWindows();
    if (hostProbe) {
      writeNvidiaProbe(hostProbe);
    } else {
      console.warn('init-gpu-runtime: Failed to collect Windows NVIDIA probe; leaving existing probe cache unchanged.');
    }

    if (!hasCommand('docker')) {
      warnCpuFallback('Docker CLI is unavailable. Install or start Docker (Docker Desktop or the WSL2 engine) and retry.');
      return;
    }

    const backend = detectWindowsDockerBackend();

    if (backend === 'desktop') {
      console.log(
        'init-gpu-runtime: Docker Desktop provides the container GPU runtime via its WSL2 integration; nvidia-container-toolkit is not needed.',
      );
      console.log('init-gpu-runtime: Ensure Docker Desktop + WSL2 GPU integration is enabled.');
      return;
    }

    if (backend === 'wsl-engine') {
      // Native dockerd inside a WSL2 distro — same requirement as native Linux,
      // but the toolkit must be installed inside the distro, not on Windows.
      if (dockerHasNvidiaRuntime()) {
        console.log('init-gpu-runtime: NVIDIA runtime already configured in the WSL2 Docker engine.');
        return;
      }

      const distro = findWslDistro();
      if (!distro) {
        warnCpuFallback('Could not find the WSL2 distro hosting the Docker engine; skipping GPU runtime setup.');
        return;
      }

      console.log(`init-gpu-runtime: NVIDIA GPU detected with the WSL2 Docker engine. Installing nvidia-container-toolkit inside "${distro}"...`);
      if (!setupNvidiaToolkitInWslDistro(distro)) {
        warnCpuFallback('Automatic nvidia-container-toolkit setup inside the WSL2 distro failed.');
        return;
      }

      if (dockerHasNvidiaRuntime()) {
        console.log('init-gpu-runtime: NVIDIA runtime configured for the WSL2 Docker engine.');
      } else {
        warnCpuFallback(
          'Toolkit installed inside WSL2 but the nvidia runtime is not visible yet; a Docker restart inside the distro may be required.',
        );
      }
      return;
    }

    warnCpuFallback('Could not determine the Docker backend (Docker Desktop vs WSL2 engine); skipping automatic GPU runtime setup.');
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
    probeHostRocmLinux();

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

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  try {
    initGpuRuntime();
  } catch (error) {
    warnCpuFallback(`Unexpected GPU setup error: ${String(error)}`);
  }
}
