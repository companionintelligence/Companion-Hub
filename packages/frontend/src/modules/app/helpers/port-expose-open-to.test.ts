import { describe, expect, it } from 'vitest';
import { portExposeOpenTo } from './port-expose-open-to';

const portExpose = { kind: 'port-expose' as const };

describe('portExposeOpenTo', () => {
  it('says anyone can open an exposed port on Public web', () => {
    expect(portExposeOpenTo({ config: portExpose, exposureMode: 'cloudflare' }, portExpose)).toBe('anyone');
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
    expect(portExposeOpenTo({ config: { exposureMode: 'cloudflare' }, exposureMode: 'cloudflare' }, portExpose)).toBe('anyone');
  });

  it('says nothing while there is no app row', () => {
    expect(portExposeOpenTo(null, portExpose)).toBeNull();
  });
});
