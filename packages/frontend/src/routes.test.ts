import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-router/dev/routes', () => {
  const entry = (path: string | undefined, file: string, children?: unknown[]) => ({ path, file, children });
  return {
    index: (file: string) => entry(undefined, file),
    route: (path: string, file: string) => entry(path, file),
    layout: (file: string, children: unknown[]) => entry(undefined, file, children),
    prefix: (path: string, children: Array<{ path?: string }>) => children.map((child) => ({ ...child, path: `${path}/${child.path ?? ''}` })),
  };
});

import routes from './routes';

type Entry = { path?: string; file: string; children?: Entry[] };

describe('routes', () => {
  // At the top level the page for an unknown address had no header or navigation.
  it('serves an unknown address inside the signed-in layout', () => {
    const entries = routes as unknown as Entry[];
    const signedIn = entries.find((entry) => entry.file === './components/routes/authenticated-route.tsx');

    expect(signedIn?.children?.some((child) => child.path === '*' && child.file === './routes/not-found.tsx')).toBe(true);
    expect(entries.some((entry) => entry.path === '*')).toBe(false);
  });
});
