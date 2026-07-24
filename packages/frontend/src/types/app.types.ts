import type { GetAllAppStoresResponse, GetAppDto, LinksDto, SearchAppsDto } from '@/api-client';
import type { FormField as CommonFormField, HubIntegration } from '@ci-hub/common/schemas';

/** Use the marketplace schema as source of truth (includes app_base_url and other field types). */
export type FormField = CommonFormField;
/** The generated client types lag the schema (no hub_integration); layer the schema's own type
 *  on top so components can read manifest opt-ins (edge_auth, memory, ...) without casts. */
export type AppInfo = GetAppDto['info'] & { hub_integration?: HubIntegration };
export type AppMetadata = GetAppDto['metadata'];
export type AppDetails = NonNullable<GetAppDto['app']>;
export type AppStatus = NonNullable<AppDetails>['status'];

export type AppInfoSimple = SearchAppsDto['data'][number];
export type AppCategory = NonNullable<AppInfoSimple['categories']>[number];

export type CustomLink = LinksDto['links'][number];

export type AppStore = GetAllAppStoresResponse['appStores'][number];
