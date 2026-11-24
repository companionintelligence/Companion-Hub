import { didChallenge, didLink, didLinks, didUnlink } from '@/api-client';
import type { DidChallengeDto, DidLinksDto } from '@/api-client';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useOptionalUserContext } from '@/context/user-context';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { type BrowserDidKeyPair, createSiopProofToken, generateBrowserDidKeyPair, isWebCryptoEd25519Supported } from '@/lib/did-key-siop';
import { unwrapSdk } from '@/lib/sdk-unwrap';
import { Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type DidLinkRow = DidLinksDto['links'][number];

const SESSION_KEYPAIR_STORAGE_KEY = 'ci_hub_did_keypair_v1';

function readStoredBrowserKeyPair(): BrowserDidKeyPair | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEYPAIR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrowserDidKeyPair>;
    if (typeof parsed.did === 'string' && parsed.publicKeyJwk && parsed.privateKeyJwk) {
      return parsed as BrowserDidKeyPair;
    }
  } catch {
    // Ignore malformed session data.
  }
  return null;
}

function saveStoredBrowserKeyPair(pair: BrowserDidKeyPair): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_KEYPAIR_STORAGE_KEY, JSON.stringify(pair));
  } catch {
    // Best-effort cache for this tab so reload preserves sign-in test convenience.
  }
}

export const DidLinksCard = () => {
  const userContext = useOptionalUserContext();
  const enabled = userContext?.didAuthEnabled === true;

  const [links, setLinks] = useState<DidLinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [webCryptoSupported, setWebCryptoSupported] = useState<boolean | null>(null);
  const [browserKeyPair, setBrowserKeyPair] = useState<BrowserDidKeyPair | null>(() => readStoredBrowserKeyPair());
  const [pendingChallenge, setPendingChallenge] = useState<DidChallengeDto | null>(null);
  const [manualIdToken, setManualIdToken] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await unwrapSdk(didLinks());
      setLinks(data?.links ?? []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load linked DIDs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void loadLinks();
    void isWebCryptoEd25519Supported().then(setWebCryptoSupported);
  }, [enabled, loadLinks]);

  if (!enabled) {
    return null;
  }

  const handleLinkBrowserKey = async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const pair = browserKeyPair ?? (await generateBrowserDidKeyPair());
      if (!browserKeyPair) {
        saveStoredBrowserKeyPair(pair);
        setBrowserKeyPair(pair);
      }

      const challenge = await unwrapSdk(didChallenge({ body: { purpose: 'link' } }));
      const idToken = await createSiopProofToken(pair, challenge);
      const res = await unwrapSdk(didLink({ body: { challengeId: challenge.challengeId, idToken } }));
      toast.success(`Linked ${res.did}`);
      await loadLinks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to link browser did:key';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateFreshKey = async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const pair = await generateBrowserDidKeyPair();
      saveStoredBrowserKeyPair(pair);
      setBrowserKeyPair(pair);
      toast.success('Generated new browser Ed25519 did:key pair (held only in this session tab)');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unable to generate WebCrypto Ed25519 key';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleRequestLinkChallenge = async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const challenge = await unwrapSdk(didChallenge({ body: { purpose: 'link' } }));
      setPendingChallenge(challenge);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to request link challenge';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitManualProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingChallenge || !manualIdToken.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await unwrapSdk(
        didLink({
          body: {
            challengeId: pendingChallenge.challengeId,
            idToken: manualIdToken.trim(),
          },
        }),
      );
      toast.success(`Linked ${res.did}`);
      setPendingChallenge(null);
      setManualIdToken('');
      await loadLinks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Rejected SIOPv2 proof';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (did: string) => {
    setBusy(true);
    setErrorMessage(null);
    try {
      await unwrapSdk(didUnlink({ body: { did } }));
      toast.success('Unlinked did:key');
      await loadLinks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to unlink did:key';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="did-links-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">Linked Ed25519 did:key Identities</CardTitle>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
            <ShieldCheck className="h-3.5 w-3.5" />
            SIOPv2 Active (CI_HUB_DID_AUTH=true)
          </span>
        </div>
        <CardDescription>
          Bind an Ed25519 <code className="font-mono text-xs">did:key:z6Mk…</code> keypair to sign in without rotating external logs. Keys generated
          here stay in this browser session only and are never sent to the Hub.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {errorMessage && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {errorMessage}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">Bound DIDs</div>
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading linked DIDs…</p>
          ) : links.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="did-links-empty">
              No did:key identities linked yet.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="did-links-list">
              {links.map((item) => (
                <li
                  key={item.did}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs break-all">{item.did}</div>
                    <div className="text-[11px] text-muted-foreground">Linked {new Date(item.linkedAt).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyToClipboard(item.did, 'Copied DID')}
                      aria-label={`Copy ${item.did}`}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleUnlink(item.did)}
                      data-testid={`unlink-did-${item.did}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Unlink
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {webCryptoSupported !== false && (
            <>
              <Button type="button" onClick={() => void handleLinkBrowserKey()} disabled={busy} data-testid="link-browser-did-btn">
                <Plus className="h-4 w-4 mr-1.5" />
                {browserKeyPair ? 'Sign Challenge & Link Browser DID' : 'Generate & Link Browser did:key'}
              </Button>
              {browserKeyPair && (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleGenerateFreshKey()} disabled={busy}>
                    Rotate Browser Key
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyToClipboard(JSON.stringify(browserKeyPair), 'Copied browser JWK backup to clipboard')}
                    data-testid="copy-browser-did-jwk-btn"
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copy JWK Backup
                  </Button>
                </>
              )}
            </>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleRequestLinkChallenge()}
            disabled={busy}
            data-testid="request-manual-did-challenge-btn"
          >
            Link via External SIOPv2 Token
          </Button>
        </div>

        {pendingChallenge && (
          <form
            onSubmit={(e) => void handleSubmitManualProof(e)}
            className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
            data-testid="manual-did-link-form"
          >
            <div className="text-xs space-y-1">
              <div className="font-medium">Single-use Link Challenge (expires {new Date(pendingChallenge.expiresAt).toLocaleTimeString()})</div>
              <div className="font-mono text-[11px] break-all">
                aud: {pendingChallenge.audience} | nonce: {pendingChallenge.nonce}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void copyToClipboard(
                    JSON.stringify({
                      challengeId: pendingChallenge.challengeId,
                      aud: pendingChallenge.audience,
                      nonce: pendingChallenge.nonce,
                      purpose: pendingChallenge.purpose,
                    }),
                    'Copied challenge parameters',
                  )
                }
              >
                Copy Challenge JSON
              </Button>
            </div>
            <Input
              value={manualIdToken}
              onChange={(e) => setManualIdToken(e.target.value)}
              placeholder="Paste EdDSA SIOPv2 idToken (eyJ...)"
              aria-label="SIOPv2 idToken"
              data-testid="manual-did-idtoken-input"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={busy || !manualIdToken.trim()} data-testid="submit-manual-did-link-btn">
                Verify & Link DID
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPendingChallenge(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
};
