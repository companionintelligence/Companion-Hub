'use client';

import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';
import type * as React from 'react';

type RootProps = typeof SwitchPrimitives.Root;

type SwitchProps = React.ComponentPropsWithoutRef<RootProps> & {
  label?: string | React.ReactNode;
  ref?: React.Ref<React.ElementRef<RootProps>>;
};

const Switch = ({ className, label, ...props }: SwitchProps) => (
  <label htmlFor={props.name} aria-labelledby={props.name} className={cn('flex items-center gap-3', className)}>
    <SwitchPrimitives.Root
      aria-label={props.name}
      className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input"
      {...props}
    >
      <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitives.Root>
    {label && (
      <span id={props.name} className="text-sm font-medium text-foreground">
        {label}
      </span>
    )}
  </label>
);

export { Switch };
