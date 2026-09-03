import { describe, expect, it } from 'vitest';
import { appInfoSchema, appPrivacySchema, appPrivacyState } from '../app-info.js';

/**
 * The App Privacy card used to render "the developer has provided details…" and
 * "No data collected" for every app in the catalog, from hardcoded strings — a
 * disclosure with nothing behind it. These tests pin the distinction the fix
 * turns on: an ABSENT privacy block is `undeclared` (unknown), and only an
 * explicit empty `collects: []` is the affirmative "collects nothing" claim.
 */
describe('app privacy declaration', () => {
  const baseInfo = {
    id: 'n8n',
    urn: 'n8n:ci-marketplace',
    available: true,
    name: 'n8n',
    short_desc: 'Workflow automation',
    author: 'n8n',
    source: 'https://github.com/n8n-io/n8n',
    categories: ['automation'],
  };

  it('treats a manifest with no privacy block as undeclared, not as "no data collected"', () => {
    const parsed = appInfoSchema.parse(baseInfo);

    expect(parsed.privacy).toBeUndefined();
    expect(appPrivacyState(parsed.privacy)).toBe('undeclared');
  });

  it('treats an explicit empty collects list as an affirmative no-collection declaration', () => {
    const parsed = appInfoSchema.parse({
      ...baseInfo,
      privacy: { declared_by: 'Companion Intelligence', declared_at: '2026-08-07', collects: [] },
    });

    expect(appPrivacyState(parsed.privacy)).toBe('no_collection');
  });

  it('parses a declaration that collects data, defaulting the two boolean flags to false', () => {
    const parsed = appInfoSchema.parse({
      ...baseInfo,
      privacy: {
        declared_by: 'Companion Intelligence',
        declared_at: '2026-08-07',
        policy_url: 'https://companionintelligence.com/privacy',
        collects: [
          { category: 'diagnostics', purposes: ['app_functionality'] },
          { category: 'usage_data', purposes: ['analytics', 'product_personalization'], linked_to_identity: true },
        ],
      },
    });

    expect(appPrivacyState(parsed.privacy)).toBe('collects');
    expect(parsed.privacy?.collects[0]).toMatchObject({
      category: 'diagnostics',
      linked_to_identity: false,
      used_for_tracking: false,
    });
    expect(parsed.privacy?.collects[1]?.linked_to_identity).toBe(true);
    expect(parsed.privacy?.policy_url).toBe('https://companionintelligence.com/privacy');
  });

  it('rejects a declaration nobody signed, so a label always has an author', () => {
    expect(appPrivacySchema.safeParse({ declared_at: '2026-08-07', collects: [] }).success).toBe(false);
    expect(appPrivacySchema.safeParse({ declared_by: '', declared_at: '2026-08-07', collects: [] }).success).toBe(false);
  });

  it('rejects a declaration with no collects list — silence is not a claim', () => {
    expect(appPrivacySchema.safeParse({ declared_by: 'someone', declared_at: '2026-08-07' }).success).toBe(false);
  });

  it('rejects a non-ISO declared_at, an unknown category, and an empty purpose list', () => {
    const base = { declared_by: 'someone', declared_at: '2026-08-07', collects: [] };

    expect(appPrivacySchema.safeParse({ ...base, declared_at: 'August 2026' }).success).toBe(false);
    expect(appPrivacySchema.safeParse({ ...base, collects: [{ category: 'telepathy', purposes: ['analytics'] }] }).success).toBe(false);
    expect(appPrivacySchema.safeParse({ ...base, collects: [{ category: 'usage_data', purposes: [] }] }).success).toBe(false);
  });

  it('rejects a policy_url that is not a URL', () => {
    const base = { declared_by: 'someone', declared_at: '2026-08-07', collects: [] };

    expect(appPrivacySchema.safeParse({ ...base, policy_url: 'not-a-url' }).success).toBe(false);
  });
});
