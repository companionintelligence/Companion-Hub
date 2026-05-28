import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  error?: string;
}

interface OllamaSetupCardProps {
  status: OllamaStatus | null;
  installing: boolean;
  checking: boolean;
  onInstall: () => Promise<void>;
  onRecheck: () => Promise<void>;
  errorMessage?: string | null;
}

export const OllamaSetupCard = ({ status, installing, checking, onInstall, onRecheck, errorMessage }: OllamaSetupCardProps) => {
  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Checking Ollama Installation...</div>
              <div className="text-xs text-muted-foreground">Please wait</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    return (
      <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
        <CardContent className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium text-green-900 dark:text-green-100">Ollama Ready</div>
                <div className="text-xs text-green-700 dark:text-green-300">{status.endpointUrl}</div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRecheck}
              loading={checking}
              aria-label="Re-check Ollama installation"
              className="flex-shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-yellow-900 dark:text-yellow-100 mb-1">Ollama Container Not Running</div>
            <div className="text-xs text-yellow-700 dark:text-yellow-300 mb-3">
              Ollama runs inside the Hub container stack. Start or restart the Ollama container, then re-check the connection.
            </div>
            {status.error && <div className="mb-3 text-xs text-yellow-800 dark:text-yellow-200">{status.error}</div>}
            {errorMessage && <div className="mb-3 text-xs text-red-700 dark:text-red-300">{errorMessage}</div>}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={onInstall}
                loading={installing}
                disabled={installing}
                className="bg-yellow-600 hover:bg-yellow-700 text-white"
              >
                {installing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Checking Ollama...
                  </>
                ) : (
                  'Start Ollama Container'
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} disabled={installing}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Re-check
              </Button>
            </div>
            {installing && (
              <div className="mt-3 text-xs text-yellow-600 dark:text-yellow-400">This may take a few minutes. Please do not close this window.</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
