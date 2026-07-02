import { portalSessionHint } from '@/api-client/sdk.gen';
import { unwrapSdkOrNull } from '@/lib/sdk-unwrap';

const PORTAL_ACCOUNT_EMAIL_KEY = 'ci-hub.portalAccountEmail';

export type PortalSessionHintSource = 'hub_operator' | 'portal_session' | 'remembered' | null;

export interface PortalSessionHint {
  email: string | null;
  portalBaseUrl: string | null;
  source: PortalSessionHintSource;
}

export function rememberPortalAccountEmail(email: string) {
  const normalized = email.trim();
  if (!normalized) {
    return;
  }

  try {
    localStorage.setItem(PORTAL_ACCOUNT_EMAIL_KEY, normalized);
  } catch {
    // Storage may be unavailable in some embedded contexts.
  }
}

export function readRememberedPortalAccountEmail(): string | null {
  try {
    const email = localStorage.getItem(PORTAL_ACCOUNT_EMAIL_KEY)?.trim();
    return email || null;
  } catch {
    return null;
  }
}

async function fetchPortalSessionHintFromHub(): Promise<PortalSessionHint> {
  try {
    const data = (await unwrapSdkOrNull(portalSessionHint())) as {
      email?: string | null;
      portalBaseUrl?: string | null;
      source?: 'hub_operator' | 'portal_session' | null;
    } | null;
    if (!data) {
      return { email: null, portalBaseUrl: null, source: null };
    }

    const email = data.email?.trim() || null;
    const portalBaseUrl = data.portalBaseUrl?.trim().replace(/\/$/, '') || null;

    return {
      email,
      portalBaseUrl,
      source: email ? (data.source ?? null) : null,
    };
  } catch {
    return { email: null, portalBaseUrl: null, source: null };
  }
}

export async function fetchPortalSessionEmailDirect(portalBaseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${portalBaseUrl.replace(/\/$/, '')}/api/auth/get-session`, {
      credentials: 'include',
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { user?: { email?: string } };
    const email = data.user?.email?.trim();
    return email || null;
  } catch {
    return null;
  }
}

export async function resolvePortalSessionHint(): Promise<PortalSessionHint> {
  const hubHint = await fetchPortalSessionHintFromHub();
  if (hubHint.email) {
    rememberPortalAccountEmail(hubHint.email);
    return hubHint;
  }

  if (hubHint.portalBaseUrl) {
    const directEmail = await fetchPortalSessionEmailDirect(hubHint.portalBaseUrl);
    if (directEmail) {
      rememberPortalAccountEmail(directEmail);
      return {
        email: directEmail,
        portalBaseUrl: hubHint.portalBaseUrl,
        source: 'portal_session',
      };
    }
  }

  const remembered = readRememberedPortalAccountEmail();
  if (remembered) {
    return {
      email: remembered,
      portalBaseUrl: hubHint.portalBaseUrl,
      source: 'remembered',
    };
  }

  return {
    email: null,
    portalBaseUrl: hubHint.portalBaseUrl,
    source: null,
  };
}
