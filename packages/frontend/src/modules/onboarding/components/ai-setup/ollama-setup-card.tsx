import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com';

interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  reachableVia?: 'direct' | 'host-network';
  displayEndpoint?: string;
  hint?: string;
  error?: string;
}

interface OllamaSetupCardProps {
  status: OllamaStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

function isBridgeRefused(error?: string): boolean {
  if (!error) return false;
  return error.includes('ECONNREFUSED') && (error.includes('172.17.') || error.includes('172.18.') || error.includes('host.docker.internal'));
}

export const OllamaSetupCard = ({ status, checking, onRecheck }: OllamaSetupCardProps) => {
  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Checking for Ollama…</div>
              <div className="text-xs text-muted-foreground">Looking for Ollama on this machine</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? status.endpointUrl;
    const bridgeNote =
      status.reachableVia === 'host-network'
        ? 'Reachable on the host via the Hub bridge. App containers may need OLLAMA_HOST=0.0.0.0 on the host Ollama service.'
        : undefined;

    return (
      <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
        <CardContent className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium text-green-900 dark:text-green-100">Ollama detected</div>
                <div className="text-xs text-green-700 dark:text-green-300">{endpoint}</div>
                {(bridgeNote || status.hint) && (
                  <div className="mt-1 text-xs text-green-700/90 dark:text-green-300/90">{bridgeNote ?? status.hint}</div>
                )}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} aria-label="Re-check Ollama" className="shrink-0">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const bridgeUnreachable = isBridgeRefused(status.error);
  const title = bridgeUnreachable ? 'Ollama not reachable from Hub' : 'Ollama not detected';
  const description = bridgeUnreachable ? (
    <>
      Ollama may already be installed on this machine, but the Hub could not connect to it yet. Ensure the Ollama service is running on the host, then
      re-check. If the Hub runs in Docker on Linux, Ollama often needs{' '}
      <code className="rounded bg-yellow-100 px-1 py-0.5 text-[11px] dark:bg-yellow-900">OLLAMA_HOST=0.0.0.0:11434</code> so containers can reach it.
    </>
  ) : (
    <>
      Ollama isn't installed or running on this machine. Install it from{' '}
      <a
        href={OLLAMA_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2 hover:text-yellow-900 dark:hover:text-yellow-100"
      >
        ollama.com
      </a>
      , start it, then re-check.
    </>
  );

  return (
    <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-yellow-900 dark:text-yellow-100 mb-1">{title}</div>
            <div className="text-xs text-yellow-700 dark:text-yellow-300 mb-3">{description}</div>
            {status.error && <div className="mb-3 text-xs text-yellow-800 dark:text-yellow-200 font-mono">{status.error}</div>}
            {status.hint && !bridgeUnreachable && <div className="mb-3 text-xs text-yellow-800 dark:text-yellow-200">{status.hint}</div>}
            <div className="flex gap-2">
              {!bridgeUnreachable && (
                <Button size="sm" onClick={() => openExternal(OLLAMA_DOWNLOAD_URL)} className="bg-yellow-600 hover:bg-yellow-700 text-white">
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Get Ollama
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Re-check
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
