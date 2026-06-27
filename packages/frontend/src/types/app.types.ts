import type { GetAllAppStoresResponse, GetAppDto, LinksDto, SearchAppsDto } from '@/api-client';
import type { FormField as CommonFormField } from '@ci-hub/common/schemas';

/** Use the marketplace schema as source of truth (includes app_base_url and other field types). */
export type FormField = CommonFormField;
export type AppInfo = GetAppDto['info'];
export type AppMetadata = GetAppDto['metadata'];
export type AppDetails = NonNullable<GetAppDto['app']>;
export type AppStatus = NonNullable<AppDetails>['status'];

export type AppInfoSimple = SearchAppsDto['data'][number];
export type AppCategory = NonNullable<AppInfoSimple['categories']>[number];

export type CustomLink = LinksDto['links'][number];

export type AppStore = GetAllAppStoresResponse['appStores'][number];
