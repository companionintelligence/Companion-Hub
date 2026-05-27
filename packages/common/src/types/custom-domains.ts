export interface SyncedCustomDomain {
  id: string;
  domain: string;
  appUrn?: string;
  applicationId?: string;
  deviceId?: string;
  propagationStatus?: string;
  sslStatus?: string;
  monitorStatus?: string;
  connectLink?: string;
}
