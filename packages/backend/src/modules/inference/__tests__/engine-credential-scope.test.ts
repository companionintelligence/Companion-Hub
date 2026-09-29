import { describe, expect, it } from 'vitest';
import { appBearerFor, BACKEND_API_KEY, isSameServer, serverIdentity } from '../engine-credential-scope';

describe('serverIdentity', () => {
  it.each([
    ['http://host.docker.internal:8000', 'http://host.docker.internal:8000'],
    ['http://host.docker.internal:8000/', 'http://host.docker.internal:8000'],
    ['http://host.docker.internal:8000/v1', 'http://host.docker.internal:8000'],
    ['http://host.docker.internal:8000/v1/', 'http://host.docker.internal:8000'],
    ['  HTTP://Host.Docker.Internal:8000/v1  ', 'http://host.docker.internal:8000'],
    ['http://vllm:80/v1', 'http://vllm'],
    ['https://vllm:443', 'https://vllm'],
    ['http://vllm:8000/v1?x=1#frag', 'http://vllm:8000'],
    ['http://user:pass@vllm:8000', 'http://vllm:8000'],
    ['http://ci-hub:3000/api/inference/pool/v1', 'http://ci-hub:3000/api/inference/pool'],
  ])('reads %s as %s', (url, identity) => {
    expect(serverIdentity(url)).toBe(identity);
  });

  it.each([[''], ['   '], [null], [undefined], ['not a url'], ['ftp://vllm:8000'], ['file:///etc/passwd']])('has no identity for %s', (url) => {
    expect(serverIdentity(url)).toBeNull();
  });
});

describe('isSameServer', () => {
  it('matches two spellings of one server', () => {
    expect(isSameServer('http://vllm:8000/v1/', 'http://VLLM:8000')).toBe(true);
  });

  it.each([
    ['another host', 'http://attacker:8000'],
    ['another port', 'http://vllm:8001'],
    ['another scheme', 'https://vllm:8000'],
    ['a path on the same host', 'http://vllm:8000/proxy'],
  ])('does not match %s', (_label, url) => {
    expect(isSameServer(url, 'http://vllm:8000')).toBe(false);
  });

  it('never matches two unparseable URLs to each other', () => {
    expect(isSameServer('garbage', 'garbage')).toBe(false);
    expect(isSameServer(undefined, undefined)).toBe(false);
  });
});

describe('appBearerFor', () => {
  const engine = { backendType: 'vllm' as const, engineUrl: 'http://ci-hub-vllm:8000', engineKey: 'vllm-secret' };

  it("hands the engine's key to an app pointed at the engine", () => {
    expect(appBearerFor({ ...engine, endpointUrl: 'http://ci-hub-vllm:8000/v1' })).toBe('vllm-secret');
  });

  it('hands the placeholder to an app pointed at the pool proxy', () => {
    expect(appBearerFor({ ...engine, endpointUrl: 'http://ci-hub:3000/api/inference/pool/v1' })).toBe(BACKEND_API_KEY.vllm);
  });

  it('hands the placeholder to an app pointed at /api/inference/v1', () => {
    expect(appBearerFor({ ...engine, endpointUrl: 'http://ci-hub:3000/api/inference/v1' })).toBe(BACKEND_API_KEY.vllm);
  });

  it("hands the placeholder to an app pointed at a decode override on another server, which the engine's key does not belong to", () => {
    expect(appBearerFor({ ...engine, endpointUrl: 'http://decode-box:9000/v1' })).toBe('vllm');
  });

  it('hands the placeholder when the engine has no key', () => {
    expect(appBearerFor({ ...engine, engineKey: '  ', endpointUrl: 'http://ci-hub-vllm:8000/v1' })).toBe('vllm');
    expect(appBearerFor({ ...engine, backendType: 'ollama', engineKey: undefined, endpointUrl: 'http://ollama:11434/v1' })).toBe('ollama');
  });
});
