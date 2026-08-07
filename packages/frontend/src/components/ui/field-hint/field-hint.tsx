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

/**
 * The canonical help-marker treatment: a small circled "?" in muted text.
 * Kept in one place so every marker in the app stays identical.
 */
const HINT_MARKER_CLASS =
  'ms-1 inline-flex items-center justify-center size-4 text-xs rounded-full border border-muted-foreground/40 text-muted-foreground cursor-help';

type HintMarkerProps = {
  /**
   * The react-tooltip `anchorSelect` class for this marker. Must be unique on the
   * page and stable across renders — it is both the anchor and a plain CSS class.
   */
  anchorClass: string;
  hint: ReactNode;
  className?: string;
  place?: 'top' | 'bottom' | 'left' | 'right';
};

/**
 * A circled "?" that sits beside a label and reveals its hint on hover.
 *
 * Use this when the label itself should not be the anchor — a long label, or one
 * that already wraps an input. When the label can be the anchor, prefer HintText,
 * which needs no extra glyph.
 */
export function HintMarker({ anchorClass, hint, className, place = 'top' }: HintMarkerProps) {
  const hintString = typeof hint === 'string' ? hint : undefined;

  return (
    <>
      <Tooltip className="tooltip" anchorSelect={`.${anchorClass}`} place={place} content={hintString}>
        {hintString ? undefined : hint}
      </Tooltip>
      {/*
        Hover-only, like the markers this replaces. The glyph carries no meaning on its
        own, so it is labelled with the hint text rather than announced as "question mark".
      */}
      <span className={cn(HINT_MARKER_CLASS, anchorClass, className)} role="img" aria-label={hintString}>
        ?
      </span>
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
