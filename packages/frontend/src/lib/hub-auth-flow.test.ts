import { describe, expect, it } from 'vitest';
import { hubAuthFlowPolicy, resolveHubAuthFlow, type HubAuthFlow } from './hub-auth-flow';

describe('resolveHubAuthFlow', () => {
  it('iOS/Android with no Hub: cloud-connect PKCE, not Hub SSO', () => {
    expect(
      resolveHubAuthFlow({
        usesCloudConnect: true,
        remoteHubUrl: null,
        isTauriDesktop: false,
      }),
    ).toBe('mobile-cloud-connect');
  });

  it('iOS/Android after a Hub is chosen: remote Hub OIDC, not cloud-connect PKCE', () => {
    expect(
      resolveHubAuthFlow({
        usesCloudConnect: true,
        remoteHubUrl: 'https://hub-core3-bc.companionintelligence.com',
        isTauriDesktop: false,
      }),
    ).toBe('mobile-hub-sso');
  });

  it('Mac / Linux / Windows Tauri: local Hub OIDC even if a leftover remote URL exists', () => {
    expect(
      resolveHubAuthFlow({
        usesCloudConnect: false,
        remoteHubUrl: 'https://hub-core3-bc.companionintelligence.com',
        isTauriDesktop: true,
      }),
    ).toBe('desktop-hub-sso');
  });

  it('browser on a running Hub: cookie SSO, no deep link', () => {
    expect(
      resolveHubAuthFlow({
        usesCloudConnect: false,
        remoteHubUrl: null,
        isTauriDesktop: false,
      }),
    ).toBe('browser-hub-sso');
  });
});

describe('hubAuthFlowPolicy — the four flows stay distinct', () => {
  const cases: Array<{
    flow: HubAuthFlow;
    pkce: boolean;
    hubSso: boolean;
    deepLink: boolean;
    systemBrowser: boolean;
    switchHub: boolean;
    listenAuth: boolean;
    desktopPresence: boolean;
  }> = [
    {
      flow: 'mobile-cloud-connect',
      pkce: true,
      hubSso: false,
      deepLink: false,
      systemBrowser: false,
      switchHub: false,
      listenAuth: false,
      desktopPresence: false,
    },
    {
      flow: 'mobile-hub-sso',
      pkce: false,
      hubSso: true,
      deepLink: true,
      systemBrowser: true,
      switchHub: true,
      listenAuth: true,
      desktopPresence: false,
    },
    {
      flow: 'desktop-hub-sso',
      pkce: false,
      hubSso: true,
      deepLink: true,
      systemBrowser: false,
      switchHub: false,
      listenAuth: true,
      desktopPresence: true,
    },
    {
      flow: 'browser-hub-sso',
      pkce: false,
      hubSso: true,
      deepLink: false,
      systemBrowser: false,
      switchHub: false,
      listenAuth: false,
      desktopPresence: false,
    },
  ];

  it.each(cases)('$flow', (expected) => {
    const policy = hubAuthFlowPolicy(expected.flow);
    expect(policy.usesPortalPkce).toBe(expected.pkce);
    expect(policy.usesHubPortalSso).toBe(expected.hubSso);
    expect(policy.usesDeepLinkHandoff).toBe(expected.deepLink);
    expect(policy.openHubSsoInSystemBrowser).toBe(expected.systemBrowser);
    expect(policy.showSwitchHub).toBe(expected.switchHub);
    expect(policy.listenDeepLinkAuth).toBe(expected.listenAuth);
    expect(policy.announceDesktopPresence).toBe(expected.desktopPresence);
  });
});
