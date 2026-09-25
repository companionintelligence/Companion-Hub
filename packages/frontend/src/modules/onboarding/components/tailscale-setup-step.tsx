import { tailscaleStatusOptions, tailscaleStatusQueryKey } from '@/lib/api-routes/named-status-routes';
import { startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { Shield, Loader2, Check, ExternalLink, AlertCircle, Smartphone } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { openExternal } from '@/lib/helpers/open-external';
import { BrandLogo } from './ai-setup/icons';
import { StepSection } from './ai-setup/primitives';
import { useTailscaleReadinessSync } from '@/lib/hooks/use-tailscale-readiness-sync';

/** Per-platform Tailscale download links (the client app to install on each device). */
const TAILSCALE_DOWNLOADS: { label: string; href: string; brand?: string }[] = [
  { label: 'Windows', href: 'https://tailscale.com/download/windows', brand: 'microsoft' },
  { label: 'macOS', href: 'https://tailscale.com/download/mac', brand: 'apple' },
  { label: 'Linux', href: 'https://tailscale.com/download/linux', brand: 'linux' },
  { label: 'Mobile', href: 'https://tailscale.com/download' },
];

interface TailscaleSetupStepProps {
  onComplete?: () => void;
  onSkip?: () => void;
  onBack?: () => void;
  /** Section mode for the single-page form: hides the step navigation. */
  embedded?: boolean;
  /** Inline sub-panel under Access Methods — no numbered StepSection wrapper. */
  inline?: boolean;
}

interface TailscaleApiStatus {
  installed: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
  backendState: string | null;
  httpsAvailable?: boolean;
}

interface AuthStartResponse {
  success: boolean;
  authUrl?: string;
  alreadyAuthenticated?: boolean;
  error?: string;
}

export const TailscaleSetupStep = ({ onComplete, onSkip, onBack, embedded = false, inline = false }: TailscaleSetupStepProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [hasAttemptedConnection, setHasAttemptedConnection] = useState(false);

  const {
    data: status,
    isLoading,
    isError,
  } = useQuery({
    ...tailscaleStatusOptions(),
    select: (payload) => payload as unknown as TailscaleApiStatus,
    refetchInterval: 5_000,
    // Re-check the moment the user returns to the Hub after authenticating in the
    // external browser, so the section flips to "connected" without waiting for the poll.
    refetchOnWindowFocus: true,
  });

  useTailscaleReadinessSync(status);

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const result = await startAuth();
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      return result.data as unknown as AuthStartResponse;
    },
    onSuccess: async (payload) => {
      if (!payload.success) {
        toast.error(payload.error ?? t('ONBOARDING_TAILSCALE_AUTH_ERROR'));
        return;
      }
      if (payload.alreadyAuthenticated) {
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_ALREADY_CONNECTED'));
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: tailscaleStatusQueryKey() });
        return;
      }
      if (payload.authUrl) {
        const opened = await openExternal(payload.authUrl);
        // openExternal never throws (it logs and returns false instead), so this
        // is the only signal that the system opener actually did anything -- skip
        // it and the button looks like it worked while nothing opened.
        toast[opened ? 'success' : 'error'](t(opened ? 'ONBOARDING_TAILSCALE_AUTH_OPENING' : 'ONBOARDING_TAILSCALE_AUTH_FAILED'));
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: tailscaleStatusQueryKey() });
      }
    },
    onError: () => toast.error(t('ONBOARDING_TAILSCALE_AUTH_FAILED')),
  });

  const isConnected = Boolean(status?.installed && status?.connected);
  const cliAvailable = status?.installed;

  // Detect the disconnected → connected transition (at any point during onboarding)
  // and give the user explicit confirmation that Tailscale connected successfully.
  // Seeded with `null` so an already-connected state on first load doesn't toast.
  const wasConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (isLoading) return;
    if (wasConnectedRef.current === false && isConnected) {
      toast.success(t('ONBOARDING_TAILSCALE_CONNECTED'));
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, isLoading, t]);

  const statusContent = (
    <div className="space-y-4">
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{t('ONBOARDING_TAILSCALE_CHECKING_STATUS')}</span>
        </div>
      ) : isError ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">{t('ONBOARDING_TAILSCALE_STATUS_ERROR')}</p>
              <p className="text-xs text-destructive/80">{t('ONBOARDING_TAILSCALE_STATUS_ERROR_DESC')}</p>
            </div>
          </div>
        </div>
      ) : cliAvailable ? (
        isConnected ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
              <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-medium text-success">{t('ONBOARDING_TAILSCALE_CONNECTED')}</p>
                <p className="text-xs text-success">{t('ONBOARDING_TAILSCALE_CONNECTED_DESC')}</p>
              </div>
            </div>

            {!inline && status?.ip && (
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-4 text-sm">
                <div className="font-medium text-muted-foreground">{t('COMMON_TAILSCALE_IP')}</div>
                <div className="font-mono text-sm">{status.ip}</div>
                {status.hostname && (
                  <>
                    <div className="font-medium text-muted-foreground">{t('COMMON_HOSTNAME')}</div>
                    <div className="font-mono text-sm">{status.hostname}</div>
                  </>
                )}
              </div>
            )}

            {!inline && (
              <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3">
                <div className="text-xs text-foreground/80">{t('ONBOARDING_TAILSCALE_TIP')}</div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4">
              <Shield className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <div className="flex-1 space-y-2">
                <p className="text-sm font-medium">{t('ONBOARDING_TAILSCALE_READY')}</p>
                <p className="text-sm text-muted-foreground">{t('ONBOARDING_TAILSCALE_READY_DESC')}</p>
              </div>
            </div>

            {hasAttemptedConnection && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3">
                <div className="text-sm text-warning">{t('ONBOARDING_TAILSCALE_AUTH_WAITING')}</div>
              </div>
            )}

            <Button
              type="button"
              intent="primary"
              size="lg"
              className="w-full"
              data-testid="tailscale-connect-btn"
              disabled={browserAuthMutation.isPending}
              onClick={() => browserAuthMutation.mutate()}
            >
              {browserAuthMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('ONBOARDING_TAILSCALE_CONNECTING')}
                </>
              ) : (
                <>
                  <Shield className="mr-2 h-4 w-4" />
                  {t('ONBOARDING_TAILSCALE_LOGIN_BUTTON')}
                </>
              )}
            </Button>

            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ExternalLink className="h-3.5 w-3.5" />
              <a href="https://tailscale.com" target="_blank" rel="noopener noreferrer" className="hover:underline">
                {t('ONBOARDING_TAILSCALE_LEARN_MORE')}
              </a>
              <span>•</span>
              <span>{t('ONBOARDING_TAILSCALE_NO_ACCOUNT')}</span>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
            <Shield className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-warning">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE')}</p>
              <p className="text-sm text-warning">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE_DESC')}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{t('ONBOARDING_TAILSCALE_INSTALL_THEN_CONNECT')}</p>
        </div>
      )}
    </div>
  );

  const downloadLinks = (
    <div className="flex flex-wrap gap-2">
      {TAILSCALE_DOWNLOADS.map((p) => (
        <a
          key={p.label}
          href={p.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`tailscale-download-${p.label.toLowerCase()}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-muted/50"
        >
          {p.brand ? (
            <BrandLogo name={p.brand} className="h-3.5 w-3.5 text-foreground/80" />
          ) : (
            <Smartphone className="h-3.5 w-3.5 text-foreground/80" />
          )}
          <span>{p.label}</span>
        </a>
      ))}
    </div>
  );

  const benefitsBlock =
    !inline || !isConnected ? (
      <div className="grid gap-3 rounded-md border border-border bg-foreground/[0.02] p-4">
        <p className="text-sm font-medium">{t('ONBOARDING_TAILSCALE_BENEFITS_TITLE')}</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_ACCESS')}</span>
          </li>
        </ul>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('ONBOARDING_TAILSCALE_INSTALL_APP_DEVICES')}</p>
          {downloadLinks}
        </div>
      </div>
    ) : null;

  const body = (
    <>
      {statusContent}
      {benefitsBlock}
      {!embedded && (
        <div className="flex items-center justify-between border-t border-border pt-5">
          <Button type="button" variant="outline" onClick={onBack}>
            {t('COMMON_BACK')}
          </Button>
          <div className="flex gap-2">
            {isConnected ? (
              <Button type="button" intent="primary" onClick={onComplete} disabled={isLoading}>
                {t('ONBOARDING_TAILSCALE_CONTINUE_TO_DISCOVER')}
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={onSkip}>
                {t('ONBOARDING_TAILSCALE_SKIP_TO_DISCOVER')}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="mt-3 rounded-md border border-border bg-foreground/[0.02] p-4" data-testid="tailscale-setup-inline">
        <p className="mb-3 text-sm font-semibold">{t('ONBOARDING_TAILSCALE_TITLE')}</p>
        {body}
      </div>
    );
  }

  return (
    <StepSection number={3} title={t('ONBOARDING_TAILSCALE_TITLE')} className="space-y-4">
      {body}
    </StepSection>
  );
};
