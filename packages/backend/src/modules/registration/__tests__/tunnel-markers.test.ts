import path from 'node:path';
import { vol } from 'memfs';
import { describe, expect, it } from 'vitest';
import { TUNNEL_DIR } from '@/common/constants';
import {
  hasTunnelLeftoverMarker,
  removeTunnelLeftoverMarker,
  removeTunnelRegistrationMarker,
  tunnelIdFromToken,
  writeTunnelLeftoverMarker,
  writeTunnelRegistrationMarker,
} from '../tunnel-markers';

const registrationPath = path.join(TUNNEL_DIR, 'registration.json');
const leftoverPath = path.join(TUNNEL_DIR, 'leftover.json');

function cloudflaredToken(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

describe('tunnel markers', () => {
  it('writes registration.json in the shape the desktop app and uninstallers read', async () => {
    await writeTunnelRegistrationMarker('tunnel-1', new Date('2026-09-17T10:00:00.000Z'));

    expect(JSON.parse(vol.readFileSync(registrationPath, 'utf-8') as string)).toEqual({
      tunnelId: 'tunnel-1',
      writtenAt: '2026-09-17T10:00:00.000Z',
    });
  });

  it('records a missing tunnel ID as null rather than an empty string', async () => {
    await writeTunnelRegistrationMarker(null, new Date('2026-09-17T10:00:00.000Z'));
    await writeTunnelLeftoverMarker('', new Date('2026-09-17T10:00:00.000Z'));

    expect(JSON.parse(vol.readFileSync(registrationPath, 'utf-8') as string).tunnelId).toBeNull();
    expect(JSON.parse(vol.readFileSync(leftoverPath, 'utf-8') as string)).toEqual({
      tunnelId: null,
      foundAt: '2026-09-17T10:00:00.000Z',
    });
  });

  it('removes both markers, and treats a marker that is already gone as removed', async () => {
    await writeTunnelRegistrationMarker('tunnel-1');
    await writeTunnelLeftoverMarker('tunnel-1');
    expect(hasTunnelLeftoverMarker()).toBe(true);

    await removeTunnelRegistrationMarker();
    await removeTunnelLeftoverMarker();

    expect(vol.existsSync(registrationPath)).toBe(false);
    expect(hasTunnelLeftoverMarker()).toBe(false);
    await expect(removeTunnelRegistrationMarker()).resolves.toBeUndefined();
    await expect(removeTunnelLeftoverMarker()).resolves.toBeUndefined();
  });

  describe('tunnelIdFromToken', () => {
    it('reads the tunnel ID from a cloudflared token', () => {
      const token = cloudflaredToken({ a: 'account-tag', t: '6ff42ae2-765d-4adf-8112-31c55c1551ef', s: 'secret' });

      expect(tunnelIdFromToken(`${token}\n`)).toBe('6ff42ae2-765d-4adf-8112-31c55c1551ef');
    });

    it('returns null for a token it cannot read', () => {
      expect(tunnelIdFromToken('not-a-token')).toBeNull();
      expect(tunnelIdFromToken(cloudflaredToken({ a: 'account-tag', s: 'secret' }))).toBeNull();
      expect(tunnelIdFromToken(cloudflaredToken({ t: 42 }))).toBeNull();
      expect(tunnelIdFromToken(Buffer.from('null').toString('base64'))).toBeNull();
    });
  });
});
