import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { DEFAULT_TAILSCALE_SERVICES_TAG, isValidTailscaleTag, serviceLabelFor, TailscaleServicesStore } from '../tailscale-services.store';

describe('TailscaleServicesStore', () => {
  let dir: string;
  let store: TailscaleServicesStore;

  beforeEach(() => {
    dir = `/data/ts-services-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(dir, { recursive: true });
    store = new TailscaleServicesStore(path.join(dir, 'state', 'tailscale-oauth.json'), path.join(dir, 'state', 'tailscale-services.json'));
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    delete process.env.TAILSCALE_SERVICES_TAG;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the OAuth client in a file only its owner can read', async () => {
    await store.saveOAuthClient({ clientId: 'k123', clientSecret: 'tskey-client-abc', tag: 'tag:ci-hub' });

    const mode = fs.statSync(path.join(dir, 'state', 'tailscale-oauth.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.readOAuthClient()).toEqual({ clientId: 'k123', clientSecret: 'tskey-client-abc', tag: 'tag:ci-hub' });
    expect(store.hasSavedOAuthClient()).toBe(true);
  });

  it('falls back to the env pair the Hub Pool uses, with the default tag', () => {
    process.env.TAILSCALE_OAUTH_CLIENT_ID = 'env-id';
    process.env.TAILSCALE_OAUTH_CLIENT_SECRET = 'tskey-client-env';

    expect(store.readOAuthClient()).toEqual({ clientId: 'env-id', clientSecret: 'tskey-client-env', tag: DEFAULT_TAILSCALE_SERVICES_TAG });
    expect(store.hasSavedOAuthClient()).toBe(false);
  });

  it('forgets a saved client', async () => {
    await store.saveOAuthClient({ clientId: 'k123', clientSecret: 'tskey-client-abc', tag: 'tag:ci-hub' });
    await store.forgetOAuthClient();

    expect(store.readOAuthClient()).toBeNull();
  });

  it('maps a Service hostname back to its app, whatever its case', async () => {
    const services = new Map([['memory:official' as AppUrn, { name: 'svc:memory', fqdn: 'memory.tail123.ts.net' }]]);
    await store.savePublished(services, 'https://hub.tail123.ts.net');

    expect(store.appForServiceHost('MEMORY.tail123.ts.net')).toBe('memory:official');
    expect(store.appForServiceHost('other.tail123.ts.net')).toBeNull();
    expect(store.hubOrigin()).toBe('https://hub.tail123.ts.net');
  });

  it('keeps one install marker across reads', async () => {
    const first = await store.installId();
    const reread = new TailscaleServicesStore(path.join(dir, 'state', 'tailscale-oauth.json'), path.join(dir, 'state', 'tailscale-services.json'));

    expect(await reread.installId()).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores entries that do not name a Service', () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state', 'tailscale-services.json'),
      JSON.stringify({ services: { 'a:b': { name: 'memory', fqdn: 'x.ts.net' }, 'c:d': { name: 'svc:ok', fqdn: 'ok.ts.net' } } }),
    );

    expect([...store.publishedServices().keys()]).toEqual(['c:d']);
  });
});

describe('serviceLabelFor', () => {
  it('turns an app name into one DNS label', () => {
    expect(serviceLabelFor('Open WebUI')).toBe('open-webui');
    expect(serviceLabelFor('--ci_memory--')).toBe('ci-memory');
    expect(serviceLabelFor('x'.repeat(80))).toHaveLength(63);
    expect(serviceLabelFor('!!!')).toBe('');
  });
});

describe('isValidTailscaleTag', () => {
  it('accepts tag:<name> only', () => {
    expect(isValidTailscaleTag('tag:ci-hub')).toBe(true);
    expect(isValidTailscaleTag('ci-hub')).toBe(false);
    expect(isValidTailscaleTag('tag:1hub')).toBe(false);
    expect(isValidTailscaleTag('tag:ci hub')).toBe(false);
  });
});
