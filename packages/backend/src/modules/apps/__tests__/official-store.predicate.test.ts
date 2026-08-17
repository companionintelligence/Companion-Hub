import { describe, expect, it } from 'vitest';
import { isOfficialStoreApp } from '../official-store.predicate';
import { isMemoryProviderApp } from '@/modules/memory-connect/memory-provider.predicate';

/**
 * Provenance gate for Hub-provisioned trust material: only the install URN's store
 * segment counts — never manifest fields, which any third-party app can forge.
 */
describe('isOfficialStoreApp', () => {
  it('accepts an app installed from the official ci-marketplace store', () => {
    expect(isOfficialStoreApp({ urn: 'ci-planning:ci-marketplace' })).toBe(true);
  });

  it('rejects any other store slug, even for an identically-named app', () => {
    expect(isOfficialStoreApp({ urn: 'ci-planning:sketchy-store' })).toBe(false);
    expect(isOfficialStoreApp({ urn: 'ci-memory:local' })).toBe(false);
  });

  it('rejects malformed or missing URNs instead of throwing', () => {
    expect(isOfficialStoreApp({ urn: 'no-store-segment' as never })).toBe(false);
    expect(isOfficialStoreApp({ urn: '' as never })).toBe(false);
    expect(isOfficialStoreApp({ urn: undefined as never })).toBe(false);
  });
});

describe('isMemoryProviderApp (rebased on the shared official-store gate)', () => {
  it('requires BOTH the ci-memory app directory AND official-store provenance', () => {
    expect(isMemoryProviderApp({ urn: 'ci-memory:ci-marketplace' })).toBe(true);
    expect(isMemoryProviderApp({ urn: 'ci-memory:third-party' })).toBe(false); // squatter store
    expect(isMemoryProviderApp({ urn: 'other-app:ci-marketplace' })).toBe(false); // official but not the provider
  });
});
