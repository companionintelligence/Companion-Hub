import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api-fetch';
import toast from 'react-hot-toast';
import { Download, Copy, AlertTriangle, ArrowLeft, ArrowRight, Loader2, FileCode, Upload } from 'lucide-react';

type SourcePlatform = 'umbrel' | 'casaos' | 'synology' | 'unraid' | 'docker' | 'runtipi';

interface PlatformInfo {
  id: SourcePlatform;
  label: string;
  description: string;
}

interface ImportResult {
  script: string;
  platform: SourcePlatform;
  warnings?: string[];
}

interface ExportResult {
  script: string;
  composefile: string;
  warnings?: string[];
}

const PLATFORMS: PlatformInfo[] = [
  { id: 'umbrel', label: 'Umbrel', description: '~/umbrel/app-data/' },
  { id: 'casaos', label: 'CasaOS', description: '/DATA/AppData/' },
  { id: 'synology', label: 'Synology NAS', description: '/volume1/docker/' },
  { id: 'unraid', label: 'Unraid', description: '/mnt/user/appdata/' },
  { id: 'docker', label: 'Bare Docker / Compose', description: 'Standard docker-compose.yml' },
  { id: 'runtipi', label: 'Runtipi', description: '~/runtipi/app-data/' },
];

function ScriptOutput({ title, content, filename, warnings }: { title: string; content: string; filename: string; warnings?: string[] }) {
  const handleCopy = () => {
    void navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard');
  };

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {warnings && warnings.length > 0 && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 space-y-1">
          <div className="flex items-center gap-2 text-yellow-600 font-medium text-sm">
            <AlertTriangle className="h-4 w-4" />
            Warnings
          </div>
          {warnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            <p key={i} className="text-sm text-yellow-700 dark:text-yellow-400 ml-6">
              {w}
            </p>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="h-3 w-3 mr-1" />
            Copy
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="h-3 w-3 mr-1" />
            Download
          </Button>
        </div>
      </div>
      <pre className="rounded-md bg-muted/50 border border-border p-4 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto whitespace-pre">
        {content}
      </pre>
    </div>
  );
}

export function ImportWizard() {
  const [step, setStep] = useState<'platform' | 'describe' | 'result'>('platform');
  const [platform, setPlatform] = useState<SourcePlatform | null>(null);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleGenerate = async () => {
    if (!platform || !description.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/migration/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, description }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ImportResult;
      setResult(data);
      setStep('result');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate migration script');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep('platform');
    setPlatform(null);
    setDescription('');
    setResult(null);
  };

  if (step === 'platform') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Select the platform you are migrating <span className="font-semibold">from</span>:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPlatform(p.id);
                setStep('describe');
              }}
              className="text-left rounded-lg border border-border p-4 hover:border-primary/60 hover:bg-muted/50 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <p className="font-medium">{p.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (step === 'describe') {
    const platformLabel = PLATFORMS.find((p) => p.id === platform)?.label ?? platform;
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setStep('platform')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          Back
        </button>
        <div>
          <p className="text-sm font-medium mb-1">
            Describe your <span className="text-primary">{platformLabel}</span> setup
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            Paste your <code className="bg-muted px-1 rounded">docker-compose.yml</code>, <code className="bg-muted px-1 rounded">.env</code> files,
            or describe the apps you're running (e.g. "Nextcloud, Immich, Jellyfin"). The more detail you provide, the better the migration script.
          </p>
          <textarea
            className="w-full min-h-48 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary resize-y"
            placeholder={
              '# Example: paste your docker-compose.yml here\n# or describe your setup:\n# - Running Nextcloud with PostgreSQL, data at ~/umbrel/app-data/nextcloud/\n# - Running Immich, data at ~/umbrel/app-data/immich/\n# - Port 8080 for Nextcloud, port 2283 for Immich'
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void handleGenerate()} disabled={!description.trim() || loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <ArrowRight className="h-4 w-4 mr-2" />
                Generate Migration Script
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Your migration script is ready. <span className="font-semibold">Review it carefully before running.</span>
        </p>
        <Button variant="outline" size="sm" onClick={reset}>
          Start over
        </Button>
      </div>
      {result && (
        <ScriptOutput
          title="migration-script.sh"
          content={result.script}
          filename={`migrate-from-${result.platform}.sh`}
          warnings={result.warnings}
        />
      )}
    </div>
  );
}

export function ExportWizard() {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/migration/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ExportResult;
      setResult(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate export');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setDescription('');
    setResult(null);
  };

  if (result) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Your portable export is ready. These files work independently of CI-Hub on any Docker host.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Regenerate
          </Button>
        </div>
        <ScriptOutput title="docker-compose.yml" content={result.composefile} filename="docker-compose.yml" warnings={result.warnings} />
        <ScriptOutput title="backup-restore.sh" content={result.script} filename="backup-restore.sh" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Optionally describe which apps to include, or leave blank to export everything. The AI will generate a{' '}
        <code className="bg-muted px-1 rounded">docker-compose.yml</code> and a backup script that work independently of CI-Hub.
      </p>
      <textarea
        className="w-full min-h-32 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary resize-y"
        placeholder="e.g. Export Nextcloud, Immich and Jellyfin with all their data volumes"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex justify-end">
        <Button onClick={() => void handleGenerate()} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <FileCode className="h-4 w-4 mr-2" />
              Generate Export
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export function MigrationContainer() {
  const [activeTab, setActiveTab] = useState<'import' | 'export'>('import');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Upload className="h-5 w-5" />
            AI-Powered Migration
          </CardTitle>
          <CardDescription>
            The AI generates a migration script for you to review. It does <strong>not</strong> run the migration automatically — you stay in control.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 border-b border-border mb-6">
            <button
              type="button"
              onClick={() => setActiveTab('import')}
              className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${activeTab === 'import' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              Import from another platform
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('export')}
              className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${activeTab === 'export' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              Export to standalone Docker
            </button>
          </div>
          {activeTab === 'import' ? <ImportWizard /> : <ExportWizard />}
        </CardContent>
      </Card>
    </div>
  );
}
