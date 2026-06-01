import { cn } from '@/lib/utils';
import type { ElementType, ReactNode } from 'react';
import { Tooltip } from 'react-tooltip';

/** Turn a logical hint id into one CSS class token for react-tooltip's anchorSelect. */
function toFieldHintAnchorClass(id: string): string {
  const safe = id
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `field-hint-${safe || 'default'}`;
}

type HintTextProps = {
  /** Unique id — sanitized into a single anchor class (must be stable across renders). */
  id: string;
  hint: ReactNode;
  children: ReactNode;
  className?: string;
  place?: 'top' | 'bottom' | 'left' | 'right';
  as?: ElementType;
};

/**
 * Hover the visible text to see a tooltip — no extra icon. The anchor is the label itself.
 */
export function HintText({ id, hint, children, className, place = 'top', as: Tag = 'span' }: HintTextProps) {
  const anchorClass = toFieldHintAnchorClass(id);
  const hintString = typeof hint === 'string' ? hint : undefined;

  return (
    <>
      <Tooltip className="tooltip" anchorSelect={`.${anchorClass}`} place={place} content={hintString}>
        {hintString ? undefined : hint}
      </Tooltip>
      <Tag className={cn('cursor-help', anchorClass, className)} tabIndex={0}>
        {children}
      </Tag>
    </>
  );
}

type LabelWithHintProps = {
  label: ReactNode;
  hint: ReactNode;
  hintId: string;
  className?: string;
  as?: ElementType;
};

/** Label text that shows a tooltip on hover. */
export function LabelWithHint({ label, hint, hintId, className, as }: LabelWithHintProps) {
  return (
    <HintText id={hintId} hint={hint} className={className} as={as}>
      {label}
    </HintText>
  );
}
