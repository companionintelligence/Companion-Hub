import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { Shield, Loader2, Check, ExternalLink, AlertCircle, Smartphone } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { openExternal } from '@/lib/helpers/open-external';
import { BrandLogo } from './ai-setup/icons';
import { StepSection } from './ai-setup/primitives';

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
}

interface TailscaleApiStatus {
  installed: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
  backendState: string | null;
}

interface AuthStartResponse {
  success: boolean;
  authUrl?: string;
  alreadyAuthenticated?: boolean;
  error?: string;
}

export const TailscaleSetupStep = ({ onComplete, onSkip, onBack, embedded = false }: TailscaleSetupStepProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [hasAttemptedConnection, setHasAttemptedConnection] = useState(false);

  const {
    data: status,
    isLoading,
    isError,
  } = useQuery<TailscaleApiStatus>({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/tailscale/status');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res.json();
    },
    refetchInterval: 5_000, // Poll every 5s during onboarding for real-time updates
    // Re-check the moment the user returns to the Hub after authenticating in the
    // external browser, so the section flips to "connected" without waiting for the poll.
    refetchOnWindowFocus: true,
  });

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/auth/start', { method: 'POST' });
      return res.json() as Promise<AuthStartResponse>;
    },
    onSuccess: (payload) => {
      if (!payload.success) {
        toast.error(payload.error ?? t('ONBOARDING_TAILSCALE_AUTH_ERROR'));
        return;
      }
      if (payload.alreadyAuthenticated) {
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_ALREADY_CONNECTED'));
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
        return;
      }
      if (payload.authUrl) {
        openExternal(payload.authUrl);
        toast.success(t('ONBOARDING_TAILSCALE_AUTH_OPENING'));
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
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

  return (
    <StepSection number={3} title={t('ONBOARDING_TAILSCALE_TITLE')} className="space-y-4">
      {/* Status (borderless — sits directly within the step panel) */}
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
              <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{t('ONBOARDING_TAILSCALE_CONNECTED')}</p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-200/80">{t('ONBOARDING_TAILSCALE_CONNECTED_DESC')}</p>
                </div>
              </div>

              {status?.ip && (
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

              <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3">
                <div className="text-xs text-foreground/80">{t('ONBOARDING_TAILSCALE_TIP')}</div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4">
                <Shield className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
                <div className="flex-1 space-y-2">
                  <p className="text-sm font-medium">{t('ONBOARDING_TAILSCALE_READY')}</p>
                  <p className="text-xs text-muted-foreground">{t('ONBOARDING_TAILSCALE_READY_DESC')}</p>
                </div>
              </div>

              {hasAttemptedConnection && (
                <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
                  <div className="text-xs text-yellow-800 dark:text-yellow-200">{t('ONBOARDING_TAILSCALE_AUTH_WAITING')}</div>
                </div>
              )}

              <Button
                type="button"
                intent="primary"
                size="lg"
                className="w-full"
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

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ExternalLink className="h-3 w-3" />
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
            <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
              <Shield className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-400" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE')}</p>
                <p className="text-xs text-yellow-800/80 dark:text-yellow-200/80">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE_DESC')}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Benefits */}
      <div className="grid gap-3 rounded-2xl border border-border bg-foreground/[0.02] p-4">
        <p className="text-sm font-medium">{t('ONBOARDING_TAILSCALE_BENEFITS_TITLE')}</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_ACCESS')}</span>
          </li>
        </ul>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('ONBOARDING_TAILSCALE_INSTALL_APP_DEVICES')}</p>
          <div className="flex flex-wrap gap-2">
            {TAILSCALE_DOWNLOADS.map((p) => (
              <a
                key={p.label}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`tailscale-download-${p.label.toLowerCase()}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary/50 hover:bg-muted/50"
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
        </div>
      </div>

      {/* Navigation */}
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
    </StepSection>
  );
};
