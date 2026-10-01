'use client';

import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';
import { useId } from 'react';
import type * as React from 'react';

type RootProps = typeof SwitchPrimitives.Root;

type SwitchProps = React.ComponentPropsWithoutRef<RootProps> & {
  label?: string | React.ReactNode;
  ref?: React.Ref<React.ElementRef<RootProps>>;
};

const Switch = ({ className, label, ...props }: SwitchProps) => {
  const generatedId = useId();
  // The switch is named by its visible label, so what is read out is the translated text and not the
  // `name` attribute ("follow-logs"). An `aria-label` outranks a wrapping <label>, which is why the old
  // `aria-label={name}` hid the label from assistive technology. `name` survives as the fallback for a
  // switch with no label, and as the label's id where it was already used as one.
  const labelId = props.name ?? generatedId;

  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the Radix switch nested inside this label, which the rule cannot see through
    <label className={cn('flex items-center gap-3', className)}>
      <SwitchPrimitives.Root
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : props.name}
        className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input"
        {...props}
      >
        <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
      </SwitchPrimitives.Root>
      {label && (
        <span id={labelId} className="text-sm font-medium text-foreground">
          {label}
        </span>
      )}
    </label>
  );
};

export { Switch };
