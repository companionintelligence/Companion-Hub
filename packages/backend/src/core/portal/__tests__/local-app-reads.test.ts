import { describe, expect, it } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { backupsReadAction, settingsReadAction } from '../local-app-reads';

describe('the verbs that reading settings and backups takes', () => {
  it('takes configure and backup on an app made on this Hub, so a member who may see it cannot read them', () => {
    expect(settingsReadAction('whoami-check:_user' as AppUrn)).toBe('configure');
    expect(backupsReadAction('whoami-check:_user' as AppUrn)).toBe('backup');
  });

  it('takes view on a catalog app, as before: the Portal grants already say who may see it', () => {
    expect(settingsReadAction('immich:ci-marketplace' as AppUrn)).toBe('view');
    expect(backupsReadAction('immich:ci-marketplace' as AppUrn)).toBe('view');
  });
});
