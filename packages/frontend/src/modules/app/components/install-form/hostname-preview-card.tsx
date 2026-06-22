import { Button } from '@/components/ui/Button';
import { Copy } from 'lucide-react';

interface HostnamePreviewCardProps {
  title: string;
  hostname: string;
  onCopy: (text: string) => Promise<void>;
}

export function HostnamePreviewCard({ title, hostname, onCopy }: HostnamePreviewCardProps) {
  return (
    <div className="mb-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">{title}</div>
      {hostname && (
        <div className="flex items-center gap-2 rounded-md bg-background/70 px-2 py-2">
          <div className="min-w-0 flex-1">
            <div title={hostname} className="truncate text-sm text-foreground">
              {hostname}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => void onCopy(hostname)}
            aria-label={`Copy ${title}`}
            title={`Copy ${title}`}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
