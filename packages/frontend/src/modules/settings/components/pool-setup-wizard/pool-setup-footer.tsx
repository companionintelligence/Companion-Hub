import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The action bar at the foot of a step. It sticks to the bottom of the dialog while a long list scrolls
 * under it, so the one button that moves you forward never leaves the screen. The dialog has no bottom
 * padding of its own (see the wizard), so the bar is the last thing in it and nothing can show beneath it. On a phone the primary
 * action fills the first row and the secondary ones share the row beneath it, at a comfortable 44px
 * tap height. Three stacked full-width buttons would cover a third of the screen.
 *
 * Children go in reading order with the primary action LAST; on a phone it moves to the front.
 */
export function PoolSetupFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="pool-setup-footer"
      className={cn(
        'sticky bottom-0 z-10 -mx-4 mt-auto flex flex-wrap gap-2 border-t bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]',
        'sm:-mx-6 sm:flex-nowrap sm:items-center sm:justify-end sm:px-6 sm:pb-4',
        '[&>button]:max-sm:h-11 [&>button:last-child]:max-sm:order-first [&>button:last-child]:max-sm:basis-full [&>button:not(:last-child)]:max-sm:flex-1',
        className,
      )}
    >
      {children}
    </div>
  );
}
