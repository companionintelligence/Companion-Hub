import { describe, expect, it } from 'vitest';
import {
  buildPortalDesktopExchangeUrl,
  buildPortalSsoStartUrl,
  isLocalSourceDevOrigin,
  resolvePortalSsoBaseUrl,
  shouldOpenPortalSsoInSystemBrowser,
  shouldUsePortalDesktopHandoff,
} from './portal-sso-url';

describe('isLocalSourceDevOrigin', () => {
  it('is true for the Vite UI and source API', () => {
    expect(isLocalSourceDevOrigin('http://localhost:5005')).toBe(true);
    expect(isLocalSourceDevOrigin('http://127.0.0.1:5004')).toBe(true);
  });

  it('is false for a leftover Docker Hub or a public appliance', () => {
    expect(isLocalSourceDevOrigin('http://localhost:5002')).toBe(false);
    expect(isLocalSourceDevOrigin('https://hub-nicemac-devben.companionintelligence.com')).toBe(false);
  });
});

describe('resolvePortalSsoBaseUrl', () => {
  it('uses the remote Hub on iOS/Android even when the page is local Vite', () => {
    expect(
      resolvePortalSsoBaseUrl({
        remoteHubUrl: 'https://hub-core3-bc.companionintelligence.com/',
        isTauriDesktop: false,
        configuredApiBaseUrl: 'http://localhost:5002',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('https://hub-core3-bc.companionintelligence.com');
  });

  it('does not treat the iOS dev host as a local source Hub', () => {
    expect(isLocalSourceDevOrigin('http://lvh.me:5005')).toBe(false);
    expect(
      resolvePortalSsoBaseUrl({
        remoteHubUrl: null,
        isTauriDesktop: false,
        configuredApiBaseUrl: 'http://localhost:5002',
        pageOrigin: 'http://lvh.me:5005',
      }),
    ).toBe('http://lvh.me:5005');
  });

  it('keeps local:desktop on the Vite origin even when the client still points at :5002', () => {
    expect(
      resolvePortalSsoBaseUrl({
        remoteHubUrl: null,
        isTauriDesktop: true,
        configuredApiBaseUrl: 'http://localhost:5002',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('http://localhost:5005');
  });

  it('uses the configured API for packaged desktop', () => {
    expect(
      resolvePortalSsoBaseUrl({
        remoteHubUrl: null,
        isTauriDesktop: true,
        configuredApiBaseUrl: 'http://127.0.0.1:5002',
        pageOrigin: 'https://tauri.localhost',
      }),
    ).toBe('http://127.0.0.1:5002');
  });

  it('uses the page origin in a normal browser', () => {
    expect(
      resolvePortalSsoBaseUrl({
        remoteHubUrl: null,
        isTauriDesktop: false,
        configuredApiBaseUrl: '',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('http://localhost:5005');
  });
});

describe('buildPortalSsoStartUrl — platform matrix', () => {
  it('iOS/Android Hub login: remote Hub + desktop handoff', () => {
    expect(
      buildPortalSsoStartUrl({
        remoteHubUrl: 'https://hub-core3-bc.companionintelligence.com',
        isTauriDesktop: false,
        isMobileClient: true,
        configuredApiBaseUrl: 'https://hub-core3-bc.companionintelligence.com',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('https://hub-core3-bc.companionintelligence.com/api/auth/portal/start?desktop=1');
  });

  it('macOS/Linux/Windows local:desktop: Vite origin + desktop handoff', () => {
    expect(
      buildPortalSsoStartUrl({
        remoteHubUrl: null,
        isTauriDesktop: true,
        isMobileClient: false,
        configuredApiBaseUrl: 'http://localhost:5002',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('http://localhost:5005/api/auth/portal/start?desktop=1');
  });

  it('packaged desktop: Hub API + desktop handoff', () => {
    expect(
      buildPortalSsoStartUrl({
        remoteHubUrl: null,
        isTauriDesktop: true,
        isMobileClient: false,
        configuredApiBaseUrl: 'http://127.0.0.1:5002',
        pageOrigin: 'https://tauri.localhost',
      }),
    ).toBe('http://127.0.0.1:5002/api/auth/portal/start?desktop=1');
  });

  it('browser on a Hub (including a phone browser): same origin, no deep-link handoff', () => {
    expect(
      buildPortalSsoStartUrl({
        remoteHubUrl: null,
        isTauriDesktop: false,
        isMobileClient: false,
        configuredApiBaseUrl: '',
        pageOrigin: 'https://hub-nicemac-devben.companionintelligence.com',
      }),
    ).toBe('https://hub-nicemac-devben.companionintelligence.com/api/auth/portal/start');
  });
});

describe('native vs browser SSO chrome', () => {
  it('opens the system browser only on iOS/Android, not desktop or a normal browser', () => {
    expect(shouldOpenPortalSsoInSystemBrowser(true)).toBe(true);
    expect(shouldOpenPortalSsoInSystemBrowser(false)).toBe(false);
  });

  it('uses the cihub:// handoff on iOS/Android and desktop apps, not in a browser', () => {
    expect(shouldUsePortalDesktopHandoff({ isTauriDesktop: true, isMobileClient: false })).toBe(true);
    expect(shouldUsePortalDesktopHandoff({ isTauriDesktop: false, isMobileClient: true })).toBe(true);
    expect(shouldUsePortalDesktopHandoff({ isTauriDesktop: false, isMobileClient: false })).toBe(false);
  });
});

describe('buildPortalDesktopExchangeUrl', () => {
  it('local:desktop exchanges on Vite :5005, not Docker :5002', () => {
    expect(
      buildPortalDesktopExchangeUrl({
        token: 'abc',
        remoteHubUrl: null,
        isTauriDesktop: true,
        isMobileClient: false,
        configuredApiBaseUrl: 'http://localhost:5002',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('http://localhost:5005/api/auth/portal/desktop-exchange?token=abc');
  });

  it('iOS/Android Hub login exchanges on the remote Hub', () => {
    expect(
      buildPortalDesktopExchangeUrl({
        token: 'abc',
        remoteHubUrl: 'https://hub-core3-bc.companionintelligence.com',
        isTauriDesktop: false,
        isMobileClient: true,
        configuredApiBaseUrl: 'https://hub-core3-bc.companionintelligence.com',
        pageOrigin: 'http://localhost:5005',
      }),
    ).toBe('https://hub-core3-bc.companionintelligence.com/api/auth/portal/desktop-exchange?token=abc');
  });
});
