import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { copyOrSelect } from '@/lib/copy-to-clipboard';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { omlxAdminKeyIsSet, setUpOmlxAdminKey } from '@/lib/inference/auto-inference-runners';
import { describePullStartError } from '@/lib/inference/tracked-models';
import { FailureLog } from './failure-log';

/** oMLX's own page, as a browser on the Mac opens it. */
export const OMLX_ADMIN_PAGE_URL = 'http://localhost:8000/admin';

/** Whether `url` names the oMLX on this Mac, the only one the desktop app can give a key. Blank is the default, which is. */
export function isLocalOmlxUrl(url: string | undefined): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname) && parsed.port === '8000';
  } catch {
    return false;
  }
}

interface OmlxAdminKeyPromptProps {
  /** The oMLX the Hub uses answers, and it is the one on this Mac. */
  localOmlxReady: boolean;
  /** The Hub holds a key for oMLX, or one is typed in the card. */
  hubHasKey: boolean;
  /** Store the new key in the Hub. */
  onKeySet: (apiKey: string) => Promise<void>;
}

type Outcome = { kind: 'working' } | { kind: 'failed'; error: string } | { kind: 'done'; apiKey: string; warning?: string; saveError?: string };

/**
 * The desktop app's offer to give a keyless oMLX its first main key, which the Hub needs to download
 * models through oMLX's admin API. Shown once, in the desktop app only, while the oMLX on this Mac
 * answers and neither the Hub nor oMLX's own settings hold a key. The new key is shown once.
 */
export const OmlxAdminKeyPrompt = ({ localOmlxReady, hubHasKey, onKeySet }: OmlxAdminKeyPromptProps) => {
  const { t } = useTranslation();
  const eligible = localOmlxReady && !hubHasKey && isTauriDesktopApp();
  // `null` until the desktop app answers. It hides the offer, as does an app too old to say.
  const [omlxHasKey, setOmlxHasKey] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copyHint, setCopyHint] = useState(false);
  const keyRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    void omlxAdminKeyIsSet().then((keySet) => {
      if (!cancelled) setOmlxHasKey(keySet ?? true);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  const handleSetKey = async () => {
    setOutcome({ kind: 'working' });
    let apiKey: string;
    let warning: string | undefined;
    try {
      ({ apiKey, warning } = await setUpOmlxAdminKey());
    } catch (error) {
      setOutcome({ kind: 'failed', error: describePullStartError(error) });
      return;
    }
    try {
      await onKeySet(apiKey);
      setOutcome({ kind: 'done', apiKey, warning });
    } catch (error) {
      // oMLX has the key now and will not hand it out again, so it is shown either way.
      setOutcome({ kind: 'done', apiKey, warning, saveError: describePullStartError(error) });
    }
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyOrSelect(apiKey, keyRef.current);
    setCopyHint(copied === 'selected');
  };

  if (outcome?.kind === 'done') {
    return (
      <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="omlx-admin-key-done">
        <p className="text-xs font-medium text-primary">
          {outcome.saveError ? t('OMLX_ADMIN_KEY_SAVE_FAILED', { error: outcome.saveError }) : t('OMLX_ADMIN_KEY_SAVED')}
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <code ref={keyRef} className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs" data-testid="omlx-admin-key-value">
            {outcome.apiKey}
          </code>
          <Button variant="ghost" size="sm" onClick={() => void handleCopy(outcome.apiKey)} data-testid="omlx-admin-key-copy">
            {t('API_KEYS_COPY')}
          </Button>
        </div>
        {copyHint && <p className="text-xs text-muted-foreground">{t('OMLX_ADMIN_KEY_COPY_BY_HAND')}</p>}
        <p className="text-xs text-muted-foreground">{t('OMLX_ADMIN_KEY_SIGN_IN', { url: OMLX_ADMIN_PAGE_URL })}</p>
        {outcome.warning && (
          <p className="text-xs text-warning" data-testid="omlx-admin-key-warning">
            {outcome.warning}
          </p>
        )}
      </div>
    );
  }

  if (!eligible || omlxHasKey !== false) return null;

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3" data-testid="omlx-admin-key-prompt">
      <p className="flex items-start gap-2 text-xs">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{t('OMLX_ADMIN_KEY_PROMPT')}</span>
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleSetKey()}
        loading={outcome?.kind === 'working'}
        data-testid="omlx-admin-key-set-btn"
      >
        {t('OMLX_ADMIN_KEY_SET')}
      </Button>
      {outcome?.kind === 'failed' && (
        <div className="text-xs text-destructive" role="alert" data-testid="omlx-admin-key-error">
          <FailureLog text={t('OMLX_ADMIN_KEY_FAILED', { error: outcome.error })} />
        </div>
      )}
    </div>
  );
};
