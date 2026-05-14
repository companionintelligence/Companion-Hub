export interface AvailableDomain {
  id: string;
  domain: string;
  isDefault: boolean;
  scope?: string;
}

export interface AvailableDomainsResponse {
  domains: AvailableDomain[];
}
