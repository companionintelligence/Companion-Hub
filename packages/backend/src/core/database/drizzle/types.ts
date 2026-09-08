import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { app, appStatusEnum, appStore, federatedIdentity, hostEventLog, hostTelemetrySample, hubPoolPeer, lifecycleJob, user } from './schema';

export const APP_STATUS = appStatusEnum.enumValues;
export type AppStatus = (typeof APP_STATUS)[number];

export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;

export type App = InferSelectModel<typeof app>;
export type NewApp = InferInsertModel<typeof app>;

export type AppStore = InferSelectModel<typeof appStore>;
export type NewAppStore = InferInsertModel<typeof appStore>;

export type FederatedIdentity = InferSelectModel<typeof federatedIdentity>;
export type NewFederatedIdentity = InferInsertModel<typeof federatedIdentity>;

export type HostTelemetrySample = InferSelectModel<typeof hostTelemetrySample>;
export type NewHostTelemetrySample = InferInsertModel<typeof hostTelemetrySample>;

export type HostEventLog = InferSelectModel<typeof hostEventLog>;
export type NewHostEventLog = InferInsertModel<typeof hostEventLog>;

export type HubPoolPeer = InferSelectModel<typeof hubPoolPeer>;
export type NewHubPoolPeer = InferInsertModel<typeof hubPoolPeer>;

export type LifecycleJob = InferSelectModel<typeof lifecycleJob>;
export type NewLifecycleJob = InferInsertModel<typeof lifecycleJob>;
