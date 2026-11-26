import { describe, expect, it } from 'vitest';
import { portExposeOpenTo } from './port-expose-open-to';

const portExpose = { kind: 'port-expose' as const };

describe('portExposeOpenTo', () => {
  it('says anyone can open an exposed port on Public web whose Hub sign-in was switched off', () => {
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'cloudflare', enableAuth: false }, portExpose)).toBe('anyone');
  });

  // Exposed ports once had no sign-in at all; they have it now unless the operator switched it off.
  it('says nothing of an exposed port on Public web behind the Hub sign-in', () => {
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'cloudflare', enableAuth: true }, portExpose)).toBeNull();
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'cloudflare' }, portExpose)).toBeNull();
  });

  // Tailscale Serve sends a tailnet request straight to the port, with nothing of the Hub's in front.
  it('says the tailnet can open an exposed port on the Private VPN', () => {
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'tailscale' }, portExpose)).toBe('tailnet');
  });

  it('says nothing about a port kept on this machine', () => {
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'local' }, portExpose)).toBeNull();
  });

  it('says nothing about a store app on Public web, whose sign-in is its own setting', () => {
    expect(portExposeOpenTo({ config: { exposureMode: 'cloudflare', enableAuth: true }, exposureMode: 'cloudflare' }, {})).toBeNull();
  });

  // A save through the generic config route drops `kind` from the stored form; the manifest keeps it.
  it('knows an exposed port by its manifest when the stored form lost its kind', () => {
    expect(portExposeOpenTo({ config: { exposureMode: 'cloudflare' }, exposureMode: 'cloudflare', enableAuth: false }, portExpose)).toBe('anyone');
  });

  it('says nothing while there is no app row', () => {
    expect(portExposeOpenTo(null, portExpose)).toBeNull();
  });
});
