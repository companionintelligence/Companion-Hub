import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/*
 * The one place the page says something is wrong: a sentence per problem and a button that goes to
 * it, in the amber card Home uses for "1 Hub wants to join your pool". It replaces the old rail's
 * fault chips.
 *
 * Dismissing it hides the notice until what it says changes. The signature is the problems and
 * their counts, so "2 Hubs can't be reached" dismissed today comes back as "3 Hubs can't be
 * reached", or when an app stops responding, but not on every visit while nothing has changed.
 */

export interface Notice {
  id: string;
  text: string;
  tone: 'warn' | 'bad';
  action?: { label: string; onClick?: () => void; to?: string };
}

const STORAGE_KEY = 'hub.resources.dismissedNotice';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(signature: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, signature);
  } catch {
    // Private mode or blocked storage: the dismissal lasts until the page reloads.
  }
}

export function noticeSignature(notices: Notice[]): string {
  return notices.map((notice) => `${notice.id}:${notice.text}`).join('|');
}

export function AttentionNotice({ notices }: { notices: Notice[] }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const signature = noticeSignature(notices);

  if (notices.length === 0 || dismissed === signature) return null;

  const bad = notices.some((notice) => notice.tone === 'bad');
  const dismiss = () => {
    writeDismissed(signature);
    setDismissed(signature);
  };

  return (
    <section
      aria-label={t('RESOURCES_NOTICE_LABEL')}
      data-testid="resources-notice"
      className={cn(
        'relative rounded-lg border p-4 pr-12 shadow-sm',
        bad ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning/10',
      )}
    >
      <ul className="space-y-2">
        {notices.map((notice) => (
          <li key={notice.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-3 text-sm font-medium">
              <AlertTriangle
                className={cn('mt-0.5 size-4 shrink-0', notice.tone === 'bad' ? 'text-destructive' : 'text-warning')}
                aria-hidden="true"
              />
              {notice.text}
            </span>
            {notice.action ? (
              notice.action.to ? (
                <Button asChild size="sm" variant="outline" className="shrink-0 self-start sm:self-auto">
                  <Link to={notice.action.to}>{notice.action.label}</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0 self-start sm:self-auto" onClick={notice.action.onClick}>
                  {notice.action.label}
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('RESOURCES_NOTICE_DISMISS')}
        className="absolute top-3 right-3 cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </section>
  );
}
