import { describe, expect, it } from 'vitest';

import {
  applyStoreBrowseParams,
  buildStoreIndexPath,
  categoryFromUrlParam,
  categoryToUrlParam,
  parseStoreBrowseParams,
  shouldLeaveFeaturedForSearch,
} from './store-browse-params';

describe('store-browse-params', () => {
  it('round-trips category slugs', () => {
    expect(categoryFromUrlParam('featured')).toBe('featured');
    expect(categoryFromUrlParam('alternatives')).toBe('__alternatives__');
    expect(categoryToUrlParam('__alternatives__')).toBe('alternatives');
    expect(categoryToUrlParam(undefined)).toBeUndefined();
  });

  it('parses q, category, and store from URLSearchParams', () => {
    const params = parseStoreBrowseParams(new URLSearchParams('q=ollama&category=ai&store=ci-marketplace'));
    expect(params).toEqual({
      q: 'ollama',
      category: 'ai',
      store: 'ci-marketplace',
    });
  });

  it('writes browse params to URLSearchParams', () => {
    const next = applyStoreBrowseParams(new URLSearchParams('store=ci-marketplace'), {
      q: 'docs',
      category: '__alternatives__',
      store: 'ci-marketplace',
    });
    expect(next.toString()).toBe('store=ci-marketplace&q=docs&category=alternatives');
  });

  it('builds store index paths', () => {
    expect(buildStoreIndexPath({ q: 'router', category: 'network' })).toBe('/store?q=router&category=network');
    expect(buildStoreIndexPath({})).toBe('/store');
  });

  it('detects featured search handoff', () => {
    expect(shouldLeaveFeaturedForSearch('featured', 'ollama')).toBe(true);
    expect(shouldLeaveFeaturedForSearch('ai', 'ollama')).toBe(false);
  });
});
