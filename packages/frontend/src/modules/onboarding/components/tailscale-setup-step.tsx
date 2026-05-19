import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { Shield, Loader2, Check, ExternalLink, AlertCircle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface TailscaleSetupStepProps {
  onComplete: () => void;
  onSkip: () => void;
  onBack: () => void;
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

export const TailscaleSetupStep = ({ onComplete, onSkip, onBack }: TailscaleSetupStepProps) => {
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
      const res = await apiFetch('/api/tailscale/status', { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res.json();
    },
    refetchInterval: 5_000, // Poll every 5s during onboarding for real-time updates
  });

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/auth/start', { method: 'POST', credentials: 'include' });
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
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        toast.success(t('ONBOARDING_TAILSCALE_AUTH_OPENING'));
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
      }
    },
    onError: () => toast.error(t('ONBOARDING_TAILSCALE_AUTH_FAILED')),
  });

  const isConnected = status?.installed && status?.connected;
  const cliAvailable = status?.installed;

  return (
    <div className="space-y-6 max-h-[62vh] overflow-y-auto pr-2">
      {/* Hero Section */}
      <div className="text-center space-y-2">
        <div className="flex justify-center">
          <div className={`rounded-full p-3 ${isConnected ? 'bg-green-100 dark:bg-green-900' : 'bg-blue-100 dark:bg-blue-900'}`}>
            {isConnected ? (
              <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
            ) : (
              <Shield className="h-8 w-8 text-blue-600 dark:text-blue-400" />
            )}
          </div>
        </div>
        <h2 className="text-xl font-semibold">{t('ONBOARDING_TAILSCALE_TITLE')}</h2>
        <p className="text-sm text-muted-foreground max-w-xl mx-auto">{t('ONBOARDING_TAILSCALE_DESCRIPTION')}</p>
      </div>

      {/* Status Card */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{t('ONBOARDING_TAILSCALE_CHECKING_STATUS')}</span>
          </div>
        ) : isError ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-red-900 dark:text-red-200">{t('ONBOARDING_TAILSCALE_STATUS_ERROR')}</p>
                <p className="text-xs text-red-800 dark:text-red-300">{t('ONBOARDING_TAILSCALE_STATUS_ERROR_DESC')}</p>
              </div>
            </div>
          </div>
        ) : cliAvailable ? (
          isConnected ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                <Check className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1 flex-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-200">{t('ONBOARDING_TAILSCALE_CONNECTED')}</p>
                  <p className="text-xs text-green-800 dark:text-green-300">{t('ONBOARDING_TAILSCALE_CONNECTED_DESC')}</p>
                </div>
              </div>

              {status?.ip && (
                <div className="grid grid-cols-2 gap-2 text-sm p-4 rounded-lg bg-muted/50">
                  <div className="text-muted-foreground font-medium">{t('ONBOARDING_TAILSCALE_IP_LABEL')}</div>
                  <div className="font-mono text-sm">{status.ip}</div>
                  {status.hostname && (
                    <>
                      <div className="text-muted-foreground font-medium">{t('ONBOARDING_TAILSCALE_HOSTNAME_LABEL')}</div>
                      <div className="font-mono text-sm">{status.hostname}</div>
                    </>
                  )}
                </div>
              )}

              <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <div className="text-xs text-blue-800 dark:text-blue-300">{t('ONBOARDING_TAILSCALE_TIP')}</div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-2 flex-1">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-200">{t('ONBOARDING_TAILSCALE_READY')}</p>
                  <p className="text-xs text-blue-800 dark:text-blue-300">{t('ONBOARDING_TAILSCALE_READY_DESC')}</p>
                </div>
              </div>

              {hasAttemptedConnection && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
                  <div className="text-xs text-yellow-800 dark:text-yellow-300">{t('ONBOARDING_TAILSCALE_AUTH_WAITING')}</div>
                </div>
              )}

              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={browserAuthMutation.isPending}
                onClick={() => browserAuthMutation.mutate()}
              >
                {browserAuthMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('ONBOARDING_TAILSCALE_CONNECTING')}
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4 mr-2" />
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
            <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
              <Shield className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE')}</p>
                <p className="text-xs text-yellow-800 dark:text-yellow-300">{t('ONBOARDING_TAILSCALE_NOT_AVAILABLE_DESC')}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Benefits */}
      <div className="grid gap-3 p-4 rounded-lg bg-muted/30">
        <p className="text-sm font-medium">{t('ONBOARDING_TAILSCALE_BENEFITS_TITLE')}</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_ACCESS')}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_DEVICES')}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_NAT')}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>{t('ONBOARDING_TAILSCALE_BENEFIT_ENCRYPTION')}</span>
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4 border-t">
        <Button type="button" variant="outline" onClick={onBack}>
          {t('COMMON_BACK')}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onSkip}>
            {t('ONBOARDING_TAILSCALE_SKIP')}
          </Button>
          <Button type="button" onClick={onComplete} disabled={isLoading}>
            {isConnected ? t('COMMON_CONTINUE') : t('ONBOARDING_TAILSCALE_SKIP')}
          </Button>
        </div>
      </div>
    </div>
  );
};
