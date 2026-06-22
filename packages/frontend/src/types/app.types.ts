import type { GetAllAppStoresResponse, GetAppDto, LinksDto, SearchAppsDto } from '@/api-client';

export type FormField = NonNullable<GetAppDto['info']['form_fields']>[number];
export type AppInfo = GetAppDto['info'];
export type AppMetadata = GetAppDto['metadata'];
export type AppDetails = NonNullable<GetAppDto['app']>;
export type AppStatus = NonNullable<AppDetails>['status'];

export type AppInfoSimple = SearchAppsDto['data'][number];
export type AppCategory = NonNullable<AppInfoSimple['categories']>[number];

export type CustomLink = LinksDto['links'][number];

export type AppStore = GetAllAppStoresResponse['appStores'][number];
