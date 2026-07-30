'use client';

import * as SliderPrimitives from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';
import type * as React from 'react';

type RootProps = typeof SliderPrimitives.Root;

type SliderProps = React.ComponentPropsWithoutRef<RootProps> & {
  label?: string | React.ReactNode;
  /** Numeric readout shown at the top-right of the control, e.g. "1.5 cores". */
  valueLabel?: React.ReactNode;
  /** Small helper line under the track, e.g. "Default: 2.0 cores". */
  caption?: React.ReactNode;
  error?: string;
  ref?: React.Ref<React.ElementRef<RootProps>>;
};

const Slider = ({ className, label, valueLabel, caption, error, name, disabled, ...props }: SliderProps) => (
  <div className={cn('space-y-1.5', className)}>
    {(label || valueLabel !== undefined) && (
      <div className="flex items-center justify-between gap-2">
        {label && <span className={cn('text-sm font-medium text-foreground', disabled && 'opacity-50')}>{label}</span>}
        {valueLabel !== undefined && (
          <span className={cn('text-sm font-mono tabular-nums text-muted-foreground', disabled && 'opacity-50')}>{valueLabel}</span>
        )}
      </div>
    )}
    <SliderPrimitives.Root
      name={name}
      disabled={disabled}
      aria-label={label ? undefined : (name as string | undefined)}
      className="relative flex h-5 w-full touch-none select-none items-center disabled:cursor-not-allowed disabled:opacity-50"
      {...props}
    >
      <SliderPrimitives.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-input">
        <SliderPrimitives.Range className="absolute h-full bg-primary" />
      </SliderPrimitives.Track>
      <SliderPrimitives.Thumb
        aria-label={typeof name === 'string' ? name : undefined}
        className="block h-4 w-4 rounded-full border border-primary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitives.Root>
    {caption && <p className={cn('text-[0.8rem] text-muted-foreground', disabled && 'opacity-50')}>{caption}</p>}
    {error && <p className="text-[0.8rem] font-medium text-destructive">{error}</p>}
  </div>
);

export { Slider };
