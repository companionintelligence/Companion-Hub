import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
const readFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: (...args: unknown[]) => readFileSync(...args),
}));

vi.mock('systeminformation', () => ({ default: { mem: vi.fn(), cpu: vi.fn(), fsSize: vi.fn() } }));

vi.mock('../env-file', () => ({ parseEnvFile: () => ({}) }));

const { probeHostFirewall } = await import('../init-host-probe');

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Route the unprivileged probes: `command -v <name>` for binary presence and
 * `systemctl is-active <unit>` for unit state.
 */
function mockHost(options: { binaries?: string[]; activeUnits?: string[]; ufwConf?: string }) {
  spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command === 'sh') {
      const name = String(args[1]).replace('command -v ', '');
      return { status: options.binaries?.includes(name) ? 0 : 1, stdout: '' };
    }
    if (command === 'systemctl') {
      const unit = String(args[1]);
      return { status: 0, stdout: options.activeUnits?.includes(unit) ? 'active' : 'inactive' };
    }
    return { status: 1, stdout: '' };
  });

  readFileSync.mockImplementation((filePath: string) => {
    if (filePath === '/etc/ufw/ufw.conf' && options.ufwConf !== undefined) return options.ufwConf;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

describe('probeHostFirewall', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    readFileSync.mockReset();
    setPlatform('linux');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  // Docker Desktop routes through a VM, so the host's own packet filter is not
  // what blocks the bridge — and neither macOS nor Windows has ufw/nft.
  it.each(['darwin', 'win32'] as const)('reports no packet filter on %s', (platform) => {
    setPlatform(platform);
    expect(probeHostFirewall()).toEqual({ kind: 'none', active: false });
  });

  it('detects an enforcing ufw from its world-readable config', () => {
    mockHost({ binaries: ['ufw'], ufwConf: 'ENABLED=yes\nLOGLEVEL=low\n' });
    expect(probeHostFirewall()).toEqual({ kind: 'ufw', active: true });
  });

  // Regression for the trap the implementation comment calls out: ufw.service is
  // a oneshot with RemainAfterExit=yes, so `systemctl is-active ufw` still says
  // "active" long after `ufw disable`. Only ufw.conf tracks enforcement, and
  // trusting the unit here would blame a firewall that is switched off.
  it('does not treat a disabled ufw as active even when its unit still reports active', () => {
    mockHost({ binaries: ['ufw'], activeUnits: ['ufw'], ufwConf: 'ENABLED=no\n' });
    expect(probeHostFirewall()).toEqual({ kind: 'none', active: false });
  });

  it('falls back to none when ufw.conf is unreadable', () => {
    mockHost({ binaries: ['ufw'] });
    expect(probeHostFirewall()).toEqual({ kind: 'none', active: false });
  });

  it('detects firewalld', () => {
    mockHost({ binaries: ['nft'], activeUnits: ['firewalld'] });
    expect(probeHostFirewall()).toEqual({ kind: 'firewalld', active: true });
  });

  it('detects nftables', () => {
    mockHost({ binaries: ['nft'], activeUnits: ['nftables'] });
    expect(probeHostFirewall()).toEqual({ kind: 'nftables', active: true });
  });

  // ufw is a frontend over nftables, so on a ufw host the nftables unit may also
  // be active. ufw syntax is what the operator should be handed.
  it('prefers ufw over a co-active nftables unit', () => {
    mockHost({ binaries: ['ufw', 'nft'], activeUnits: ['nftables'], ufwConf: 'ENABLED=yes\n' });
    expect(probeHostFirewall()).toEqual({ kind: 'ufw', active: true });
  });

  // `unknown` and `none` are not interchangeable: `none` suppresses the firewall
  // command entirely, so it must only be reported when tooling was actually found.
  it('reports unknown when no firewall tooling is present at all', () => {
    mockHost({});
    expect(probeHostFirewall()).toEqual({ kind: 'unknown', active: false });
  });
});
