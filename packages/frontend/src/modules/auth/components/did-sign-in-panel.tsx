import { didChallenge, didVerify } from '@/api-client';
import type { DidChallengeDto, LoginDto } from '@/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { type BrowserDidKeyPair, createSiopProofToken } from '@/lib/did-key-siop';
import { unwrapSdk } from '@/lib/sdk-unwrap';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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

interface DidSignInPanelProps {
  onSuccess: (data: LoginDto) => void;
}

export const DidSignInPanel = ({ onSuccess }: DidSignInPanelProps) => {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [browserKeyPair, setBrowserKeyPair] = useState<BrowserDidKeyPair | null>(() => readStoredBrowserKeyPair());
  const [jwkBackupInput, setJwkBackupInput] = useState('');
  const [challenge, setChallenge] = useState<DidChallengeDto | null>(null);
  const [manualIdToken, setManualIdToken] = useState('');

  const handleSignInWithKeyPair = async (pair: BrowserDidKeyPair) => {
    setBusy(true);
    try {
      const issued = await unwrapSdk(didChallenge({ body: { purpose: 'sign-in' } }));
      const idToken = await createSiopProofToken(pair, issued);
      const loginData = await unwrapSdk(didVerify({ body: { challengeId: issued.challengeId, idToken } }));
      onSuccess(loginData);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'did:key sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const handleLoadJwkBackup = () => {
    try {
      const parsed = JSON.parse(jwkBackupInput.trim()) as Partial<BrowserDidKeyPair>;
      if (typeof parsed.did !== 'string' || !parsed.publicKeyJwk || !parsed.privateKeyJwk) {
        throw new Error('Backup JSON must contain did, publicKeyJwk, and privateKeyJwk');
      }
      const normalized = parsed as BrowserDidKeyPair;
      setBrowserKeyPair(normalized);
      setJwkBackupInput('');
      toast.success(`Loaded ${normalized.did} in this browser session`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invalid JWK backup JSON');
    }
  };

  const handleRequestSignInChallenge = async () => {
    setBusy(true);
    try {
      const issued = await unwrapSdk(didChallenge({ body: { purpose: 'sign-in' } }));
      setChallenge(issued);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to request DID sign-in challenge');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitManualSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge || !manualIdToken.trim()) return;
    setBusy(true);
    try {
      const loginData = await unwrapSdk(
        didVerify({
          body: { challengeId: challenge.challengeId, idToken: manualIdToken.trim() },
        }),
      );
      onSuccess(loginData);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'DID SIOPv2 proof rejected');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-border bg-card/60 p-3 text-left" data-testid="did-sign-in-panel">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between text-xs font-medium text-foreground"
        data-testid="did-sign-in-toggle"
      >
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          Sign in with linked did:key (SIOPv2)
        </span>
        <span className="text-muted-foreground">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3 text-xs">
          {browserKeyPair ? (
            <div className="space-y-2">
              <div className="font-mono text-[11px] break-all text-muted-foreground">{browserKeyPair.did}</div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void handleSignInWithKeyPair(browserKeyPair)}
                data-testid="did-sign-in-browser-key-btn"
              >
                Sign Challenge & Continue
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-muted-foreground">Paste an exported browser JWK backup or sign an external SIOPv2 challenge:</div>
              <div className="flex gap-2">
                <Input
                  value={jwkBackupInput}
                  onChange={(e) => setJwkBackupInput(e.target.value)}
                  placeholder='{"did":"did:key:z6Mk...","privateKeyJwk":...}'
                  aria-label="Browser DID JWK Backup"
                  data-testid="did-jwk-backup-input"
                />
                <Button type="button" variant="outline" size="sm" disabled={!jwkBackupInput.trim()} onClick={handleLoadJwkBackup}>
                  Load JWK
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void handleRequestSignInChallenge()}
              data-testid="did-sign-in-challenge-btn"
            >
              Get External Sign-In Challenge
            </Button>

            {challenge && (
              <form onSubmit={(e) => void handleSubmitManualSignIn(e)} className="space-y-2" data-testid="did-sign-in-manual-form">
                <div className="font-mono text-[11px] break-all text-muted-foreground">
                  aud: {challenge.audience} | nonce: {challenge.nonce}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copyToClipboard(
                      JSON.stringify({
                        challengeId: challenge.challengeId,
                        aud: challenge.audience,
                        nonce: challenge.nonce,
                        purpose: challenge.purpose,
                      }),
                      'Copied sign-in challenge',
                    )
                  }
                >
                  Copy Challenge JSON
                </Button>
                <Input
                  value={manualIdToken}
                  onChange={(e) => setManualIdToken(e.target.value)}
                  placeholder="Paste signed SIOPv2 idToken"
                  aria-label="Signed SIOPv2 idToken"
                  data-testid="did-sign-in-idtoken-input"
                />
                <Button type="submit" size="sm" disabled={busy || !manualIdToken.trim()} data-testid="did-sign-in-submit-btn">
                  Verify & Sign In
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
