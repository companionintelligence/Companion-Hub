import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/*
 * Loading and failed states for the Resources cards. A failed request is said in words and never
 * drawn as a zero or an empty table: on a monitoring page a confident wrong number is worse than none.
 */

export interface QueryState {
  pending: boolean;
  failed: boolean;
}

export function CardLoading({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true">
      {Array.from({ length: lines }, (_, index) => 100 - index * 15).map((width) => (
        <div key={width} className="h-4 rounded-md bg-foreground/10 motion-safe:animate-pulse" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function CardFailed({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive', className)}>{children}</p>;
}

/** Children once the query has answered; a skeleton before that, and the error if it failed. */
export function CardBody({ state, error, lines, children }: { state: QueryState; error: ReactNode; lines?: number; children: ReactNode }) {
  if (state.failed) return <CardFailed>{error}</CardFailed>;
  if (state.pending) return <CardLoading lines={lines} />;
  return <>{children}</>;
}
