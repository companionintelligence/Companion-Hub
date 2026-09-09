/**
 * What a machine actually is, read from the machine itself.
 *
 * Every backend gate below depends on this, and every gate is a claim that has already been wrong on
 * this fleet in a way that cost real time:
 *
 *   · A Strix Halo box advertises ~66 GB free through ROCm and then fails to allocate 21 GB, because
 *     ROCm on gfx1151 runs `NO_VMM=1` and cannot back a large contiguous buffer with GTT. Six nodes
 *     returned HTTP 500 on every model above their 2 GB VRAM carve-out until the Vulkan backend was
 *     forced. **What the driver reports free is not a memory budget.**
 *   · One node's `nvidia-smi` failed while `lspci` showed the card present — the kernel module was
 *     built for a kernel the box had never rebooted into. It ran CPU-only for weeks while still being
 *     handed models sized for its GPU.
 *   · Five nodes report identical model inventories because they mount one NFS store. "Lists a
 *     model" is not "can serve it".
 *
 * So this file distinguishes *present* from *working* throughout, and reports the evidence rather
 * than a verdict wherever the two can disagree.
 *
 * Everything here is a read. Nothing installs, configures or restarts.
 */

import { sshCapture, type SshTarget } from './fleet-ssh.js';

export type HostOs = 'linux' | 'darwin' | 'windows' | 'unknown';
export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'none';

export interface GpuInfo {
  vendor: GpuVendor;
  /** Model string as the tool reported it. */
  name?: string;
  /** What the driver says. NOT a budget — see the file header. */
  reportedVramMib?: number;
  /** AMD APUs report the real pool here; the VRAM carve-out is a fraction of it. */
  gttMib?: number;
  /** amdgpu target, e.g. gfx1151. Decides ROCm package selection. */
  gfx?: string;
  /**
   * The card is physically present AND its driver answers. False with `name` set is the exact state
   * that ran a node CPU-only for weeks without anyone noticing.
   */
  driverWorking: boolean;
  /** Why `driverWorking` is false, in the operator's words. */
  driverNote?: string;
}

export interface HostFacts {
  os: HostOs;
  arch: string;
  /** Apple Silicon. Gates dspark and mtplx, which exist only there. */
  appleSilicon: boolean;
  totalRamMib?: number;
  /** 1-minute load average. A node under real load must not be handed maintenance. */
  load1?: number;
  cpuCount?: number;
  diskFreeMib?: number;
  docker: { present: boolean; usable: boolean; version?: string; note?: string };
  gpus: GpuInfo[];
  /** Present-and-answering engines, by port. */
  enginesListening: number[];
  /** Raw probe output, for a report that needs to show its working. */
  notes: string[];
}

/**
 * One shell script, one round trip.
 *
 * Deliberately a single command rather than a dozen: each SSH round trip to a tailnet host costs
 * real latency, and a fourteen-node sweep that made twelve calls per host would take minutes for
 * facts that take milliseconds to gather. Every probe is `|| true`-guarded so a missing tool never
 * aborts the rest — a machine with no `nvidia-smi` must still report its RAM.
 *
 * Output is `key=value` lines. Structured formats tempt a probe into needing a parser on the far
 * side; this needs nothing but `echo`.
 */
const PROBE_SCRIPT = [
  'echo "os=$(uname -s 2>/dev/null || echo unknown)"',
  'echo "arch=$(uname -m 2>/dev/null || echo unknown)"',
  'echo "cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"',
  // Linux reports kB in /proc/meminfo; macOS reports bytes from sysctl. Normalise to MiB here so the
  // parser never has to know which OS it is reading.
  'echo "ram_mib=$(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || (sysctl -n hw.memsize 2>/dev/null | awk \'{printf "%d", $1/1048576}\') || echo 0)"',
  'echo "load1=$(cut -d\\  -f1 /proc/loadavg 2>/dev/null || (sysctl -n vm.loadavg 2>/dev/null | awk \'{print $2}\') || echo 0)"',
  'echo "disk_free_mib=$(df -Pm / 2>/dev/null | awk \'NR==2{print $4}\' || echo 0)"',
  'echo "docker_version=$(docker --version 2>/dev/null || echo none)"',
  // `docker info` is the real test. `docker --version` succeeds on a machine whose daemon is dead or
  // whose user is not in the docker group, and that difference decides whether an install can work.
  'echo "docker_info=$(docker info >/dev/null 2>&1 && echo ok || echo fail)"',
  'echo "nvidia_smi=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo none)"',
  // Present-but-not-working: the card is on the bus even when its driver is not answering.
  'echo "lspci_gpu=$(lspci 2>/dev/null | grep -iE \'vga|3d controller|display\' | head -1 || echo none)"',
  // Every KFD topology node carries a gfx_target_version, and node 0 is the CPU — its value is 0.
  // Reading the first node therefore reports "no GPU" on a machine with one, which is how the
  // gfx1151 warning below silently never fired. Take the first NON-ZERO value instead.
  'echo "rocm_gfx=$(grep -h gfx_target_version /sys/class/kfd/kfd/topology/nodes/*/properties 2>/dev/null | awk \'$2 > 0 {print $2; exit}\' || echo none)"',
  'for d in /sys/class/drm/card*/device; do [ -f "$d/mem_info_vram_total" ] && echo "amd_vram_mib=$(( $(cat $d/mem_info_vram_total) / 1048576 ))" && break; done',
  'for d in /sys/class/drm/card*/device; do [ -f "$d/mem_info_gtt_total" ] && echo "amd_gtt_mib=$(( $(cat $d/mem_info_gtt_total) / 1048576 ))" && break; done',
  "echo \"reboot_required=$([ -f /var/run/reboot-required ] && cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\\n' ',' || echo no)\"",
  // Which engines already answer. Adoption beats installation, so an install must know what is here.
  'for p in 11434 13305 8080 8000 8216 8020; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo "listening=$p"; done',
  // The probe's exit status is meaningless — it is a sequence of independent best-effort reads, and
  // the last one is a port test that fails whenever that port is idle. Without this the whole script
  // exits non-zero on a perfectly healthy machine and its output gets thrown away as a failure.
  'true',
].join('; ');

function kv(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  }
  return map;
}

const first = (map: Map<string, string[]>, key: string): string | undefined => map.get(key)?.[0];
const num = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * `gfx_target_version` is a packed integer — 110501 means gfx1105... except the encoding is
 * major/minor/step in pairs, so 110501 is gfx1151 written as 11,05,01 reversed in the middle.
 * Decoding it explicitly beats guessing from a card name, which varies by driver version.
 */
function decodeGfx(raw: string | undefined): string | undefined {
  if (!raw || raw === 'none') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const major = Math.floor(n / 10000);
  const minor = Math.floor((n % 10000) / 100);
  const step = n % 100;
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`;
}

export function parseHostFacts(raw: string): HostFacts {
  const map = kv(raw);
  const osRaw = (first(map, 'os') ?? '').toLowerCase();
  const os: HostOs = osRaw.includes('linux')
    ? 'linux'
    : osRaw.includes('darwin')
      ? 'darwin'
      : osRaw.includes('mingw') || osRaw.includes('msys')
        ? 'windows'
        : 'unknown';
  const arch = first(map, 'arch') ?? 'unknown';
  const notes: string[] = [];

  const dockerVersion = first(map, 'docker_version');
  const dockerPresent = Boolean(dockerVersion && dockerVersion !== 'none');
  const dockerUsable = first(map, 'docker_info') === 'ok';
  if (dockerPresent && !dockerUsable) {
    notes.push('docker is installed but `docker info` failed — the daemon is down, or this account is not permitted to use it');
  }

  const gpus: GpuInfo[] = [];
  const nvidia = first(map, 'nvidia_smi');
  const lspci = first(map, 'lspci_gpu');
  if (nvidia && nvidia !== 'none') {
    const [name, mib] = nvidia.split(',').map((s) => s.trim());
    gpus.push({ vendor: 'nvidia', name, reportedVramMib: num(mib), driverWorking: true });
  } else if (lspci && lspci !== 'none' && /nvidia/i.test(lspci)) {
    // The exact state that ran a node CPU-only for weeks: card on the bus, driver not answering.
    gpus.push({
      vendor: 'nvidia',
      name: lspci,
      driverWorking: false,
      driverNote:
        'the card is on the PCI bus but nvidia-smi did not answer — usually a kernel module built for a kernel this machine has not booted into',
    });
  }

  const amdVram = num(first(map, 'amd_vram_mib'));
  const amdGtt = num(first(map, 'amd_gtt_mib'));
  const gfx = decodeGfx(first(map, 'rocm_gfx'));
  if (amdVram || amdGtt || gfx) {
    gpus.push({
      vendor: 'amd',
      name: lspci && lspci !== 'none' && /amd|radeon/i.test(lspci) ? lspci : undefined,
      reportedVramMib: amdVram,
      gttMib: amdGtt,
      gfx,
      driverWorking: Boolean(gfx || amdVram),
    });
    // The finding that cost six nodes their GPUs. Recorded on every gfx1151 host rather than left for
    // whoever next reads an OOM in journalctl.
    if (gfx === 'gfx1151' && amdGtt && amdVram && amdGtt > amdVram * 4) {
      notes.push(
        `gfx1151 with a ${amdVram} MiB VRAM carve-out and ${amdGtt} MiB GTT: ROCm here runs NO_VMM and cannot allocate a large buffer out of GTT, so models above the carve-out fail to load with an allocation error while the driver reports the full pool free. Forcing OLLAMA_LLM_LIBRARY=vulkan uses the unified pool correctly.`,
      );
    }
  }

  if (os === 'darwin' && /arm64/.test(arch)) {
    gpus.push({ vendor: 'apple', name: 'Apple Silicon (unified memory)', driverWorking: true });
  }

  const reboot = first(map, 'reboot_required');
  if (reboot && reboot !== 'no') notes.push(`a reboot is pending for: ${reboot.replace(/,$/, '')}`);

  return {
    os,
    arch,
    appleSilicon: os === 'darwin' && /arm64/.test(arch),
    totalRamMib: num(first(map, 'ram_mib')),
    load1: Number(first(map, 'load1') ?? '') || 0,
    cpuCount: num(first(map, 'cpus')),
    diskFreeMib: num(first(map, 'disk_free_mib')),
    docker: { present: dockerPresent, usable: dockerUsable, version: dockerPresent ? dockerVersion : undefined },
    gpus,
    enginesListening: (map.get('listening') ?? []).map(Number).filter((n) => Number.isFinite(n)),
    notes,
  };
}

/** Read one node's hardware facts over SSH. */
export async function readHostFacts(target: SshTarget, timeoutMs = 25_000): Promise<{ facts: HostFacts | null; error?: string }> {
  const result = await sshCapture(target, PROBE_SCRIPT, timeoutMs);
  // Trust OUTPUT over exit status. The probe is a best-effort sequence whose status reflects only its
  // last command, and a machine that answered with facts has told us what we asked regardless of what
  // it exited with. Only a genuinely empty reply is a failure.
  if (result.out.includes('os=')) return { facts: parseHostFacts(result.out) };
  return { facts: null, error: result.err || `ssh exited ${result.code} with no readable output` };
}

/**
 * Is this machine too busy to be given maintenance right now?
 *
 * Not a nicety. A fleet-wide upgrade pass on this fleet caught one node mid-inference at load
 * 108–116 on 32 cores; its `apt` transaction stalled rebuilding an initramfs it could never get CPU
 * for, and the machine ended up needing physical recovery. Nothing in that pass checked load first.
 *
 * The threshold is per-core because a load of 8 means opposite things on a 4-core and a 64-core box.
 */
export function isTooBusyForMaintenance(facts: HostFacts, ratio = 1.5): { busy: boolean; why?: string } {
  const cpus = facts.cpuCount ?? 1;
  const load = facts.load1 ?? 0;
  if (load > cpus * ratio) {
    return {
      busy: true,
      why: `load ${load.toFixed(1)} on ${cpus} core(s) — above ${ratio}× cores. A node serving live traffic can stall a package transaction badly enough to need hands-on recovery.`,
    };
  }
  return { busy: false };
}
