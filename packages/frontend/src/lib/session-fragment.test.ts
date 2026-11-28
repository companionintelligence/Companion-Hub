import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptSessionTokenFromFragment } from './session-fragment';

const setTauriSessionId = vi.fn();
const markHubSessionIssuedAt = vi.fn();
vi.mock('@/lib/api-fetch', () => ({
  setTauriSessionId: (token: string) => setTauriSessionId(token),
  markHubSessionIssuedAt: () => markHubSessionIssuedAt(),
}));

// jsdom serves http://localhost, so the hand-off cookie here is the plain http one.
const COOKIE = 'ci-hub-handoff';

function land(hash: string, cookie?: string) {
  window.history.replaceState(null, '', `/home?tab=a${hash}`);
  // biome-ignore lint/suspicious/noDocumentCookie: sets the cookie the way the page reads it
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/`;
  // biome-ignore lint/suspicious/noDocumentCookie: sets the cookie the way the page reads it
  if (cookie !== undefined) document.cookie = `${COOKIE}=${cookie}; Path=/`;
}

describe('adoptSessionTokenFromFragment', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("keeps the token the Hub's redirect handed this browser, and cleans up after it", () => {
    land('#ci_hub_session=sid.sig&ci_hub_nonce=n123&keep=1', 'n123');

    expect(adoptSessionTokenFromFragment()).toBe(true);
    expect(setTauriSessionId).toHaveBeenCalledWith('sid.sig');
    expect(markHubSessionIssuedAt).toHaveBeenCalledOnce();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/home?tab=a#keep=1');
    expect(document.cookie).not.toContain(COOKIE);
  });

  // The attack: a link to a Hub page that carries someone else's token. It never went through this
  // browser's redirect, so no cookie of this browser's matches it.
  it.each([
    ['no hand-off value at all (a link from before, or made by hand)', '#ci_hub_session=theirs.sig', 'n123'],
    ['a value but no cookie', '#ci_hub_session=theirs.sig&ci_hub_nonce=n999', undefined],
    ["a value that is not this browser's", '#ci_hub_session=theirs.sig&ci_hub_nonce=n999', 'n123'],
  ])('refuses a token with %s, and still strips it from the address bar', (_label, hash, cookie) => {
    land(hash, cookie);

    expect(adoptSessionTokenFromFragment()).toBe(false);
    expect(setTauriSessionId).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    expect(document.cookie).not.toContain(COOKIE);
  });

  it('uses the hand-off cookie once: the same link a second time is refused', () => {
    land('#ci_hub_session=sid.sig&ci_hub_nonce=n123', 'n123');
    expect(adoptSessionTokenFromFragment()).toBe(true);

    window.history.replaceState(null, '', '/home#ci_hub_session=sid.sig&ci_hub_nonce=n123');
    expect(adoptSessionTokenFromFragment()).toBe(false);
    expect(setTauriSessionId).toHaveBeenCalledOnce();
  });

  it('leaves a page with no token in its fragment alone', () => {
    land('#section-2', 'n123');

    expect(adoptSessionTokenFromFragment()).toBe(false);
    expect(window.location.hash).toBe('#section-2');
    expect(document.cookie).toContain(`${COOKIE}=n123`);
  });
});
