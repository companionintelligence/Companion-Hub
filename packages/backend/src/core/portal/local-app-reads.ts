import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';

import type { HubAction } from './hub-actions';

/*
 * Anyone signed in may see an app in the `_user` store, but its settings and its backups are an
 * organization owner's or admin's (see `MarketplaceWhoIsService.localAppGrants`). So reading them
 * takes the verb that changes them. A catalog app keeps `view` for both: the Portal's grants already
 * say who may see it, and an owner can narrow them there.
 */
function isLocalApp(appUrn: AppUrn): boolean {
  return extractAppUrn(appUrn).appStoreId === '_user';
}

/** The verb reading an app's settings takes: its compose file and its user config, where env values live. */
export function settingsReadAction(appUrn: AppUrn): HubAction {
  return isLocalApp(appUrn) ? 'configure' : 'view';
}

/** The verb listing or downloading an app's backups takes. */
export function backupsReadAction(appUrn: AppUrn): HubAction {
  return isLocalApp(appUrn) ? 'backup' : 'view';
}
