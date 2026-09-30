import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import type { LemonadeStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LemonadeIcon } from './icons';

const LEMONADE_DOCS_URL = 'https://github.com/lemonade-sdk/lemonade';
const LEMONADE_DEFAULT_PORT = '13305';
/** Where marketplace apps live (`HUB_APP_POOL_CIDR`); they call Lemonade directly when pool routing is off. */
const APP_SUBNET_CIDR = '10.128.0.0/9';

/** The port the Hub probes, so every command names the right one. */
function lemonadePort(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).port || LEMONADE_DEFAULT_PORT;
  } catch {
    return LEMONADE_DEFAULT_PORT;
  }
}

/**
 * `lemonade` is an HTTP client for the running server and defaults to port 13305, so on any other
 * port it would talk to nothing unless told.
 */
function lemonadeBindCommand(port: string): string {
  const prefix = port === LEMONADE_DEFAULT_PORT ? '' : `LEMONADE_PORT=${port} `;
  return `${prefix}lemonade config set host=0.0.0.0`;
}

/**
 * Gives Lemonade an API key through a systemd drop-in and restarts it. The unit is `lemond` on
 * Lemonade 11 and later and `lemonade-server` on the 10.x packages every fleet node runs, so the
 * script asks systemd which one this host has instead of naming one that may not exist. With no key
 * in the Hub yet it makes one and prints the line for the Hub's .env; otherwise it uses the Hub's.
 */
function lemonadeApiKeyScript(apiKeyConfigured: boolean): string {
  return [
    apiKeyConfigured ? "KEY='<LEMONADE_API_KEY from the Hub .env>'" : 'KEY=$(openssl rand -hex 32)',
    'UNIT=$(systemctl cat lemond >/dev/null 2>&1 && echo lemond || echo lemonade-server)',
    'sudo mkdir -p /etc/systemd/system/$UNIT.service.d',
    `printf '[Service]\\nEnvironment=LEMONADE_API_KEY=%s\\n' "$KEY" | sudo tee /etc/systemd/system/$UNIT.service.d/api-key.conf >/dev/null`,
    'sudo systemctl daemon-reload && sudo systemctl restart $UNIT',
    ...(apiKeyConfigured ? [] : ['echo "Add to the Hub .env, then recreate the Hub: LEMONADE_API_KEY=$KEY"']),
  ].join('\n');
}

/** For a Hub too old to send its own rules: the Hub's networks and the app subnet, on ufw. */
function fallbackFirewallCommands(port: string): string[] {
  return [`sudo ufw allow from 172.16.0.0/12 to any port ${port} proto tcp`, `sudo ufw allow from ${APP_SUBNET_CIDR} to any port ${port} proto tcp`];
}

const codeClass = 'block w-full max-w-full overflow-x-auto whitespace-pre rounded bg-warning/10 px-2 py-1.5 text-xs text-warning';

/**
 * Lemonade's Linux package runs as a system service listening on localhost, and the Hub probes it
 * from inside Docker, so a running server still reads as "not detected". The status says how the
 * probe failed and what the host runs, and the steps follow from that: a refused key needs the key
 * fixed, not a wider bind; a filtered or unresolved probe gets the server's own explanation (shown
 * above this); macOS and Windows reach host services through Docker Desktop and get no Linux steps.
 * Only a refused or unclassified probe on Linux — the same whether Lemonade is stopped or listening
 * on localhost — gets the rebind, and always with an API key: binding 0.0.0.0 alone opens a server
 * with no authentication to every device that can reach the host.
 */
const LemonadeDockerAccessHint = ({ status }: { status: LemonadeStatus }) => {
  const { t } = useTranslation();
  const port = lemonadePort(status.endpointUrl);
  const mode = status.failureMode;
  const linuxHost = status.hostPlatform !== 'darwin' && status.hostPlatform !== 'win32';
  const firewallCommands = status.firewallCommands ?? fallbackFirewallCommands(port);
  const firewallStep =
    linuxHost && firewallCommands.length > 0 ? (
      <>
        <div className="text-xs text-warning">{t('ONBOARDING_LEMONADE_FIREWALL_DESC', { port, appSubnet: APP_SUBNET_CIDR })}</div>
        <code className={codeClass} data-testid="lemonade-firewall-commands">
          {firewallCommands.join('\n')}
        </code>
      </>
    ) : null;

  if (mode === 'auth' || mode === 'dns') return null;
  if (mode === 'filtered') {
    return firewallStep ? (
      <div className="mb-3 min-w-0 space-y-2" data-testid="lemonade-docker-access-hint">
        {firewallStep}
      </div>
    ) : null;
  }
  if (!linuxHost) return null;

  return (
    <div className="mb-3 min-w-0 space-y-2" data-testid="lemonade-docker-access-hint">
      <div className="text-xs font-medium text-warning">{t('ONBOARDING_LEMONADE_DOCKER_ACCESS_TITLE')}</div>
      <div className="text-xs text-warning">{t('ONBOARDING_LEMONADE_DOCKER_ACCESS_DESC')}</div>
      <code className={codeClass}>{lemonadeBindCommand(port)}</code>
      <div className="text-xs text-warning" data-testid="lemonade-api-key-guidance">
        {t(status.apiKeyConfigured ? 'ONBOARDING_LEMONADE_API_KEY_EXISTING_DESC' : 'ONBOARDING_LEMONADE_API_KEY_DESC')}
      </div>
      <code className={codeClass} data-testid="lemonade-api-key-script">
        {lemonadeApiKeyScript(Boolean(status.apiKeyConfigured))}
      </code>
      {firewallStep}
    </div>
  );
};

interface LemonadeSetupCardProps {
  status: LemonadeStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

export const LemonadeSetupCard = ({ status, checking, onRecheck }: LemonadeSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_LEMONADE_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_LEMONADE_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? `${status.endpointUrl}/v1`;
    const loadedModel = status.loadedModels?.[0];
    return (
      <Card className="border-success/30 bg-success/10">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-success">{t('ONBOARDING_LEMONADE_DETECTED')}</div>
                <div className="text-xs text-success">{endpoint}</div>
                {loadedModel && (
                  <div className="mt-0.5 truncate text-xs text-success">{t('ONBOARDING_LEMONADE_MODEL_LOADED', { model: loadedModel })}</div>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_LEMONADE_RECHECK')}
              data-testid="lemonade-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-warning/30 bg-warning/10">
      <CardContent className="min-w-0 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium text-warning">
              <LemonadeIcon className="h-4 w-4 shrink-0" />
              {t('ONBOARDING_LEMONADE_NOT_DETECTED')}
            </div>
            <div className="mb-3 text-xs text-warning">{status.hint ?? t('ONBOARDING_LEMONADE_NOT_DETECTED_DESC')}</div>
            {status.error && (
              <div
                className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
                data-testid="lemonade-probe-error"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_LEMONADE_PROBE_ERROR_TITLE')}</p>
                  <p className="mt-1 break-all font-mono text-xs text-destructive/90">{status.error}</p>
                </div>
              </div>
            )}
            <LemonadeDockerAccessHint status={status} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => openExternal(LEMONADE_DOCS_URL)}>
                {t('ONBOARDING_LEMONADE_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="lemonade-recheck-btn">
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('ONBOARDING_LEMONADE_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
