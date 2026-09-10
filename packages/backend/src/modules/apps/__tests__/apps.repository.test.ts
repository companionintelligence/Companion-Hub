import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppsRepository } from '../apps.repository';

/**
 * R2-HUBDOMAINS-2 — the subdomain conflict check, on the value that becomes a
 * hostname.
 *
 * ⚠ THE FAKE RETURNS EVERY LOCALLY-EXPOSED ROW ON PURPOSE. That is the shape of
 * the defect: the question "is another app already served on this hostname?" was
 * delegated to a case-sensitive `varchar` equality in SQL, which answers a
 * different question than the one the Traefik router asks. The method now has to
 * decide it itself, so the test hands it candidates and asserts on which ones it
 * calls a collision.
 */
describe('AppsRepository.getAppsByLocalSubdomain', () => {
  const rows = [
    { id: 1, appName: 'comfyui', localSubdomain: 'my-app', exposedLocal: true },
    { id: 2, appName: 'dozzle', localSubdomain: 'My-App', exposedLocal: true },
    { id: 3, appName: 'grafana', localSubdomain: 'my--app', exposedLocal: true },
    { id: 4, appName: 'filebrowser', localSubdomain: 'other-app', exposedLocal: true },
    { id: 5, appName: 'immich', localSubdomain: null, exposedLocal: true },
  ];

  let findMany: ReturnType<typeof vi.fn>;
  let repository: AppsRepository;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue(rows);
    repository = new AppsRepository({ query: { app: { findMany } } } as never);
  });

  it('refuses My-App and my--app as duplicates of my-app', async () => {
    /*
     * All three sanitize to `my-app` and therefore emit one byte-identical
     * Traefik `Host()` rule. Left as three rows the conflict check waves through,
     * the delivery reconcile writes a customer's bound `custom_domain` onto
     * whichever of them it reaches — and the takeover confirmation is skipped
     * outright, because `customDomainServesAnotherApp` sanitizes both sides and
     * concludes the two apps are the same one.
     */
    const conflicts = await repository.getAppsByLocalSubdomain('my-app');

    expect(conflicts.map((row) => row.appName)).toEqual(['comfyui', 'dozzle', 'grafana']);
  });

  it('reads the same in the other direction — the raw spelling is never the answer', async () => {
    const conflicts = await repository.getAppsByLocalSubdomain('MY--App');

    expect(conflicts.map((row) => row.appName)).toEqual(['comfyui', 'dozzle', 'grafana']);
  });

  it('leaves apps on their own hostname alone', async () => {
    expect(await repository.getAppsByLocalSubdomain('other-app')).toHaveLength(1);
    expect(await repository.getAppsByLocalSubdomain('nothing-like-it')).toEqual([]);
  });

  it('never queries at all for punctuation that names no hostname', async () => {
    // `---` sanitizes to nothing, so the row falls back to `<appName>-<appStoreSlug>`
    // and can collide with nobody on this value.
    expect(await repository.getAppsByLocalSubdomain('---')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
