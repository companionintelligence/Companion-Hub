import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Tooltip } from 'react-tooltip';

/**
 * The "?" next to a setting. A button so keyboard users can focus the only
 * explanation. Hover still opens the same tooltip.
 */
export function SettingsHint({ className, hint }: { className: string; hint: ReactNode }) {
  const selector = className.split(/\s+/).find((token) => token.endsWith('-hint'));
  const label = typeof hint === 'string' ? hint : undefined;

  return (
    <>
      <Tooltip className="tooltip" anchorSelect={selector ? `.${selector}` : undefined}>
        {hint}
      </Tooltip>
      <button
        type="button"
        className={clsx(
          'ml-1 inline-flex size-4 cursor-help items-center justify-center rounded-full border border-muted-foreground/40 text-xs text-muted-foreground',
          className,
        )}
        aria-label={label}
        onClick={(event) => event.preventDefault()}
      >
        ?
      </button>
    </>
  );
}
