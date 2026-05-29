import { Card, CardContent } from '@/components/ui/Card';
import type { CuratedModel } from '@ci-hub/common/types';

interface AgentAppsCardProps {
  /** LLM candidates (for the selected backend) the agents can default to. */
  models: CuratedModel[];
  /** Currently selected preferred model id, if any. */
  preferredModelId: string | undefined;
  onSelectPreferred: (modelId: string) => void;
}

const AGENTS: Array<{ key: string; name: string; glyph: string; description: string }> = [
  {
    key: 'hermes',
    name: 'Hermes',
    glyph: '🪽',
    description: 'Autonomous assistant that works your tools, memory, and notifications with the model you choose.',
  },
  {
    key: 'openclaw',
    name: 'OpenClaw',
    glyph: '🦾',
    description: 'Coding and computer-use agent that runs entirely against your Hub’s local model.',
  },
];

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/**
 * Highlights the Companion agent apps (Hermes, OpenClaw) that run on the Hub's local inference and
 * lets the user pick the preferred model these agents default to. The selection is persisted as an
 * inference preference and honored by the per-app bootstrap endpoint.
 */
export const AgentAppsCard = ({ models, preferredModelId, onSelectPreferred }: AgentAppsCardProps) => {
  const hasModels = models.length > 0;

  return (
    <Card className="border-2 border-primary/40 bg-primary/5" data-testid="agent-apps-card">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold" data-testid="agent-apps-title">
              Companion AI agents
            </h3>
            <p className="text-xs text-muted-foreground">Hermes and OpenClaw run on your Hub and use the model you pick here.</p>
          </div>
          <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">Featured</span>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AGENTS.map((agent) => (
            <div
              key={agent.key}
              className="flex items-start gap-3 rounded-lg border border-primary/20 bg-background/60 p-3"
              data-testid={`agent-${agent.key}`}
            >
              <span className="text-xl leading-none" aria-hidden="true">
                {agent.glyph}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium">{agent.name}</div>
                <div className="text-xs text-muted-foreground">{agent.description}</div>
              </div>
            </div>
          ))}
        </div>

        <div>
          <label className="text-xs font-medium" htmlFor="preferred-model-select">
            Preferred model
          </label>
          {hasModels ? (
            <>
              <select
                id="preferred-model-select"
                data-testid="preferred-model-select"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={preferredModelId ?? ''}
                onChange={(e) => onSelectPreferred(e.target.value)}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {formatSize(model.runtime.memoryFootprintMb)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Your agents and the Hub default to this model. It’s installed with your other models below; you can change it later in Settings.
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="preferred-model-empty">
              Select a local language model below and your agents will use it automatically.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
