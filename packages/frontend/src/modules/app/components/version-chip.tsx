import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type VersionChipProps = {
  children: ReactNode;
  /** The version being installed or updated to. */
  tone?: 'current' | 'next';
  className?: string;
};

/** A version label. There is no global `.badge` class, so this owns the chip styles. */
export function VersionChip({ children, tone = 'current', className }: VersionChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        tone === 'next' ? 'bg-success text-success-foreground' : 'bg-muted text-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}
