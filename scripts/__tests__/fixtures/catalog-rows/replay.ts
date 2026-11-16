/**
 * Test support for the catalog row checker: recorded registry answers (this folder) and a `fetch` that replays them.
 *
 * `replay` answers only the URLs it is given. Any other request is recorded in `calls` and fails like a network error, so it
 * never reaches a network, and a test that lists `calls` sees a check that starts asking for something it should not (a second
 * blob, a weights file).
 */
import { readFileSync } from 'node:fs';
import type { Fetcher } from '../../../catalog/row-reads';

const ROOT = new URL('./', import.meta.url);

/** A recorded answer, as the file holds it. */
export const fixture = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

export const fixtureJson = <T>(path: string): T => JSON.parse(fixture(path)) as T;

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type Answer = Response | ((call: Call) => Response | Promise<Response>);

export const answer = (status: number, body: string, headers: Record<string, string> = {}): Response => new Response(body, { status, headers });

/** A `fetch` that replays `routes` (full URL to answer) and records every request it gets. */
export function replay(routes: Record<string, Answer>): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> | undefined) } };
    calls.push(call);
    const route = routes[url];
    if (route === undefined) throw new Error(`no recorded answer for ${url}`);
    if (typeof route === 'function') return route(call);
    // A Response body can be read once, and a retry reads the same route again.
    return route.clone();
  };
  return { fetch: fetcher, calls };
}

/** The URLs `readOllamaRegistry` asks for a model, so a test can route them without spelling the registry's paths out. */
export const ollama = {
  manifest: (name: string, tag: string) => `https://registry.ollama.ai/v2/${name}/manifests/${tag}`,
  blob: (name: string, digest: string) => `https://registry.ollama.ai/v2/${name}/blobs/${digest}`,
};
