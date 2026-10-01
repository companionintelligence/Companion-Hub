import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Groups and modes are the whole point here, and the suite's memfs mock has neither, so these run
// against a real temp directory.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, default: actual };
});

import { CLOUDFLARED_GID, TUNNEL_TOKEN_MODE, shareTunnelTokenWithCloudflared } from '../tunnel-token-file';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tokenFile(mode: number): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hub-tunnel-token-'));
  dirs.push(dir);
  const tokenPath = join(dir, 'token');
  fs.writeFileSync(tokenPath, 'tunnel-token');
  // chmod, not writeFile's mode: that one is masked by the umask.
  fs.chmodSync(tokenPath, mode);
  return tokenPath;
}

const modeOf = (filePath: string) => fs.statSync(filePath).mode & 0o777;

// Windows has no POSIX groups or modes, and the Hub only ever runs this in its Linux container.
describe.skipIf(process.platform === 'win32')('shareTunnelTokenWithCloudflared', () => {
  // Stands in for cloudflared's group, which docker-entrypoint.sh puts the Hub in: one this process
  // is in, so it may give a file to it without privilege. A supplementary one where there is one, so
  // the group really changes.
  const ownGid = (process.getgid as () => number)();
  const memberGid = (process.getgroups as () => number[])().find((gid) => gid !== ownGid) ?? ownGid;

  it("is cloudflared's group: nonroot, the user cloudflare/cloudflared runs as", () => {
    expect(CLOUDFLARED_GID).toBe(65532);
    expect(TUNNEL_TOKEN_MODE).toBe(0o640);
  });

  it('gives a world-readable token to the group and takes it from everyone else', async () => {
    const tokenPath = tokenFile(0o644);

    await expect(shareTunnelTokenWithCloudflared(tokenPath, memberGid)).resolves.toBe(true);

    expect(fs.statSync(tokenPath).gid).toBe(memberGid);
    expect(modeOf(tokenPath)).toBe(0o640);
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe('tunnel-token');
  });

  it('leaves the token readable by everyone when this process is not in the group, so cloudflared can still read it', async () => {
    // What writeHealableTextFile creates, in the Hub's own group.
    const tokenPath = tokenFile(0o640);
    vi.spyOn(fs.promises, 'chown').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    await expect(shareTunnelTokenWithCloudflared(tokenPath)).resolves.toBe(false);

    expect(modeOf(tokenPath)).toBe(0o644);
  });

  // A Windows folder through Docker Desktop: chgrp succeeds and changes nothing. A token made 0640
  // there would be one cloudflared, in a group the file is not in, cannot read.
  it('never takes the token from everyone while the group has not taken', async () => {
    const tokenPath = tokenFile(0o644);
    vi.spyOn(fs.promises, 'chown').mockResolvedValue(undefined);
    const chmod = vi.spyOn(fs.promises, 'chmod');

    await expect(shareTunnelTokenWithCloudflared(tokenPath)).resolves.toBe(false);

    expect(chmod).not.toHaveBeenCalledWith(tokenPath, 0o640);
    expect(modeOf(tokenPath)).toBe(0o644);
  });

  it('reports a mount that keeps no modes rather than claiming the token is private', async () => {
    const tokenPath = tokenFile(0o644);
    vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);

    await expect(shareTunnelTokenWithCloudflared(tokenPath, memberGid)).resolves.toBe(false);

    expect(modeOf(tokenPath)).toBe(0o644);
  });
});
