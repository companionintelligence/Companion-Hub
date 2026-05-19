import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { Shield, Loader2, Check, ExternalLink } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import toast from 'react-hot-toast';

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
  const queryClient = useQueryClient();
  const [hasAttemptedConnection, setHasAttemptedConnection] = useState(false);

  const { data: status, isLoading } = useQuery<TailscaleApiStatus>({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/tailscale/status', { credentials: 'include' });
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
        toast.error(payload.error ?? 'Tailscale is not available');
        return;
      }
      if (payload.alreadyAuthenticated) {
        toast.success('Already connected to Tailscale!');
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
        return;
      }
      if (payload.authUrl) {
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        toast.success('Opening Tailscale login in new window...');
        setHasAttemptedConnection(true);
        void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
      }
    },
    onError: () => toast.error('Failed to start Tailscale authentication'),
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
        <h2 className="text-xl font-semibold">Set Up Private VPN</h2>
        <p className="text-sm text-muted-foreground max-w-xl mx-auto">
          Connect your Hub to Tailscale to securely access it from anywhere in the world. Link up all your devices and turn them into your own
          personal AWS.
        </p>
      </div>

      {/* Status Card */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Checking Tailscale status...</span>
          </div>
        ) : cliAvailable ? (
          isConnected ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                <Check className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1 flex-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-200">Connected to Tailscale</p>
                  <p className="text-xs text-green-800 dark:text-green-300">
                    Your Hub is now accessible from anywhere via your private Tailscale network.
                  </p>
                </div>
              </div>

              {status?.ip && (
                <div className="grid grid-cols-2 gap-2 text-sm p-4 rounded-lg bg-muted/50">
                  <div className="text-muted-foreground font-medium">Tailscale IP</div>
                  <div className="font-mono text-sm">{status.ip}</div>
                  {status.hostname && (
                    <>
                      <div className="text-muted-foreground font-medium">Hostname</div>
                      <div className="font-mono text-sm">{status.hostname}</div>
                    </>
                  )}
                </div>
              )}

              <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <div className="text-xs text-blue-800 dark:text-blue-300">
                  💡 <strong>Tip:</strong> You can now access your Hub from any device on your Tailscale network using the IP address shown above, or
                  from anywhere in the world by installing Tailscale on those devices too.
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-2 flex-1">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-200">Ready to Connect</p>
                  <p className="text-xs text-blue-800 dark:text-blue-300">
                    Click the button below to log in with your Tailscale account. If you don't have one yet, you can create a free account during the
                    login process.
                  </p>
                </div>
              </div>

              {hasAttemptedConnection && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
                  <div className="text-xs text-yellow-800 dark:text-yellow-300">
                    ⏳ Complete the authentication in the popup window. This page will automatically update when connected.
                  </div>
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
                    Connecting...
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4 mr-2" />
                    Log In with Tailscale
                  </>
                )}
              </Button>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ExternalLink className="h-3 w-3" />
                <a href="https://tailscale.com" target="_blank" rel="noopener noreferrer" className="hover:underline">
                  Learn more about Tailscale
                </a>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
              <Shield className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200">Tailscale Not Available</p>
                <p className="text-xs text-yellow-800 dark:text-yellow-300">
                  The Tailscale sidecar container is not running. This usually means the private-vpn Docker Compose profile is not enabled.
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              If you're running the Hub with <code className="px-1 py-0.5 rounded bg-muted">pnpm start:dev:detached</code>, the private-vpn profile
              may not be enabled by default. You can skip this step and set up Tailscale later in Settings.
            </p>
          </div>
        )}
      </div>

      {/* Benefits */}
      <div className="grid gap-3 p-4 rounded-lg bg-muted/30">
        <p className="text-sm font-medium">Why use Tailscale?</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>Access your Hub securely from anywhere</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>Connect all your devices (Windows, Mac, Linux, mobile)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>Zero-config networking with automatic NAT traversal</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">✓</span>
            <span>Enterprise-grade encryption for all traffic</span>
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4 border-t">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onSkip}>
            Skip for Now
          </Button>
          <Button type="button" onClick={onComplete} disabled={!isConnected && cliAvailable !== false}>
            {isConnected ? 'Continue' : 'Continue Without VPN'}
          </Button>
        </div>
      </div>
    </div>
  );
};
