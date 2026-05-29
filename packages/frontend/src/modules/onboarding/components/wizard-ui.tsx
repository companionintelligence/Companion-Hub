import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/* Shared wizard primitives so every onboarding step uses the same teal/cyan panel language. */

/** Rounded gradient panel that frames a wizard step's content. */
export function WizardCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-6 shadow-sm sm:p-8', className)}>
      {children}
    </section>
  );
}

/** Glowing rounded icon badge used by the hero (Welcome / Done) steps. */
export function IconBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/40 bg-primary/10 text-primary shadow-lg shadow-primary/15 [&_svg]:h-8 [&_svg]:w-8',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Left-aligned step header: optional icon + title + description, with an optional right action. */
export function WizardHeader({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon && <span className="mt-0.5 text-primary [&_svg]:h-6 [&_svg]:w-6">{icon}</span>}
        <div>
          <h2 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

/** Footer navigation row shared by steps (Back on the left, primary actions on the right). */
export function WizardNav({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex items-center justify-between gap-2 border-t border-border pt-5', className)}>{children}</div>;
}
