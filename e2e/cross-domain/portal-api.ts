/**
 * Portal API client for cross-domain E2E tests.
 *
 * Interacts with a real CI-Portal instance (running via miniflare/wrangler dev)
 * to seed users, organizations, and devices for Hub registration tests.
 */

interface SignUpResponse {
  user?: { id: string; email: string };
  token?: string;
}

interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
}

interface DeviceResponse {
  deviceId: string;
  pairingCode: string;
  status: string;
  name: string;
  slug: string;
}

export class PortalApiClient {
  private baseUrl: string;
  private cookies: string[] = [];

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Register a new user in Portal via better-auth email sign-up. */
  async signUp(email: string, password: string, name = 'E2E Test User'): Promise<SignUpResponse> {
    const res = await fetch(`${this.baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      redirect: 'manual',
    });

    if (!res.ok && res.status !== 302) {
      const body = await res.text().catch(() => '');
      throw new Error(`Portal sign-up failed (${res.status}): ${body}`);
    }

    this.extractCookies(res);

    // better-auth returns { user, token, session } — unwrap if needed
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return (raw.user ? raw : { user: raw }) as unknown as SignUpResponse;
  }

  /** Sign in to Portal via better-auth email sign-in. */
  async signIn(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    });

    if (!res.ok && res.status !== 302) {
      const body = await res.text().catch(() => '');
      throw new Error(`Portal sign-in failed (${res.status}): ${body}`);
    }

    this.extractCookies(res);
  }

  /** Create an organization in Portal. Requires authenticated session. */
  async createOrganization(name: string): Promise<OrganizationResponse> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await fetch(`${this.baseUrl}/api/auth/organization/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookieHeader(),
      },
      body: JSON.stringify({ name, slug }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create organization failed (${res.status}): ${body}`);
    }

    this.extractCookies(res);

    // better-auth may return the org directly or nested in a wrapper object
    const raw = (await res.json()) as Record<string, unknown>;
    const org = raw.id ? raw : (raw.data as Record<string, unknown>) || (raw.organization as Record<string, unknown>) || raw;
    return org as unknown as OrganizationResponse;
  }

  /** Set the active organization for the session. */
  async setActiveOrganization(organizationId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/organization/set-active`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookieHeader(),
      },
      body: JSON.stringify({ organizationId }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Set active org failed (${res.status}): ${body}`);
    }

    this.extractCookies(res);
  }

  /** Create a device within an organization. Returns the pairing code. */
  async createDevice(organizationId: string, name: string): Promise<DeviceResponse> {
    const res = await fetch(`${this.baseUrl}/api/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookieHeader(),
      },
      body: JSON.stringify({ name, organization_id: organizationId }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create device failed (${res.status}): ${body}`);
    }

    return (await res.json()) as DeviceResponse;
  }

  /** Verify a pairing code exists and return device info (public, no auth). */
  async verifyPairingCode(pairingCode: string): Promise<{ deviceId: string; status: string }> {
    const res = await fetch(`${this.baseUrl}/api/devices/pair?pairing_code=${encodeURIComponent(pairingCode)}`);

    if (!res.ok) {
      throw new Error(`Pairing code verification failed (${res.status})`);
    }

    return (await res.json()) as { deviceId: string; status: string };
  }

  /** Check Portal health endpoint. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Cookie management ─────────────────────────────────────────────────────

  private extractCookies(res: Response) {
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    for (const header of setCookieHeaders) {
      const nameValue = header.split(';')[0];
      if (!nameValue) continue;
      const name = nameValue.split('=')[0];
      // Replace existing cookie with same name
      this.cookies = this.cookies.filter((c) => !c.startsWith(`${name}=`));
      this.cookies.push(nameValue);
    }
  }

  private cookieHeader(): string {
    return this.cookies.join('; ');
  }
}
