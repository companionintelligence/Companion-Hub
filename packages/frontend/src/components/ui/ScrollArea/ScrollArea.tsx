'use client';

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import clsx from 'clsx';
import type * as React from 'react';
import styles from './ScrollArea.module.css';

const ScrollBar = ({ className, orientation = 'vertical', ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    orientation={orientation}
    className={clsx(
      styles.scrollbar,
      { [styles.scrollbarVertical as string]: orientation === 'vertical', [styles.scrollbarHorizontal as string]: orientation === 'horizontal' },
      className,
    )}
    {...props}
  >
    {/* `cursor-pointer`: the thumb is draggable, and without it the pointer stays
        an arrow so the bar reads as decoration rather than something to grab. */}
    <ScrollAreaPrimitive.ScrollAreaThumb className={clsx('relative cursor-pointer rounded-full bg-muted', orientation === 'vertical' && 'grow')} />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
);

const ScrollArea = ({ className, children, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { maxheight: number }) => (
  <ScrollAreaPrimitive.Root className={clsx('relative overflow-hidden', className)} {...props}>
    <ScrollAreaPrimitive.Viewport style={{ maxHeight: props.maxheight }} className={clsx(styles.viewport, 'w-full')}>
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);

export { ScrollArea, ScrollBar };
