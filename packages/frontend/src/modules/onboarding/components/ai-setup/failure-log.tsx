import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface FailureLogProps {
  text: string;
  className?: string;
  testId?: string;
}

/**
 * The reason a runner gave for failing. It can be the installer's whole log, so it scrolls instead
 * of pushing the step away, and it opens at the end, where the cause is.
 * `anywhere` because break-words can't shrink a flex item.
 */
export const FailureLog = ({ text, className, testId }: FailureLogProps) => {
  const log = useRef<HTMLSpanElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new text is what moves the end of the log
  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [text]);

  return (
    <span ref={log} className={cn('block max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]', className)} data-testid={testId}>
      {text}
    </span>
  );
};
