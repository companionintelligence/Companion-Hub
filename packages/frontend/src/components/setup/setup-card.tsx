import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

interface SetupCardProps {
  children: ReactNode;
  className?: string;
  /** Classes for the padded content box inside the card. */
  contentClassName?: string;
}

/** Bordered panel used on setup / gate screens (onboarding, HubStatus). */
export function SetupCard({ children, className, contentClassName }: SetupCardProps) {
  return (
    <Card className={cn('w-full border-border/80 shadow-md', className)}>
      <CardContent className={cn('p-6 sm:p-8', contentClassName)}>{children}</CardContent>
    </Card>
  );
}
