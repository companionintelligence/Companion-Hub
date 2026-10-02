import * as React from 'react';
import { cn } from '@/lib/utils';

interface InputGroupProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  error?: string;
  label?: string | React.ReactNode;
  helpText?: string | React.ReactNode;
  isInvalid?: boolean;
  groupPrefix?: string | React.ReactNode;
  groupSuffix?: string | React.ReactNode;
  groupClassName?: string;
  groupSuffixClassName?: string;
  /** `sm` matches Button size="sm" (h-8); default matches Button's default (h-9). */
  size?: 'sm' | 'default';
}

export const InputGroup = React.forwardRef<HTMLInputElement, InputGroupProps>(
  (
    {
      name,
      label,
      error,
      helpText,
      type = 'text',
      className,
      isInvalid,
      groupPrefix,
      groupSuffix,
      groupClassName,
      groupSuffixClassName,
      size = 'default',
      id,
      'aria-describedby': describedByProp,
      ...rest
    },
    ref,
  ) => {
    const isSm = size === 'sm';
    const errorId = React.useId();
    const helpId = React.useId();
    const inputId = id || name;
    const describedBy = [describedByProp, helpText ? helpId : undefined, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;

    const renderPrefix = () => {
      if (!groupPrefix) return null;
      if (typeof groupPrefix === 'string') {
        const prefixClassName = cn(
          'flex shrink-0 items-center whitespace-nowrap rounded-l-md border border-r-0 border-input bg-muted text-muted-foreground',
          isSm ? 'h-8 px-2 text-xs' : 'h-9 px-3 text-sm',
        );

        // With no `label` of its own, the text in front of the field is what names it: a field whose
        // only words sit in a <div> beside it is announced as "edit text, blank". When there IS a
        // label the prefix is added context ("https://"), and naming the field by both would read
        // "Subdomain https://".
        return label ? (
          <div className={prefixClassName}>{groupPrefix}</div>
        ) : (
          <label htmlFor={inputId} className={prefixClassName}>
            {groupPrefix}
          </label>
        );
      }
      return <div className="flex shrink-0 items-center whitespace-nowrap">{groupPrefix}</div>;
    };

    const renderSuffix = () => {
      if (!groupSuffix) return null;
      if (typeof groupSuffix === 'string') {
        // Single-line + truncate rather than `break-all`: a long domain suffix
        // such as `-living-room-server-acme.ci.computer` otherwise wraps
        // mid-word onto a second line and grows the row past the field height,
        // which reads as a layout bug (worst at the 375px viewport).
        return (
          <div
            title={groupSuffix}
            className={cn(
              'flex max-w-[50%] min-w-0 items-center rounded-r-md border border-l-0 border-input bg-muted leading-tight text-muted-foreground',
              isSm ? 'h-8 px-2 py-0 text-xs' : 'h-9 px-3 py-1 text-sm',
              groupSuffixClassName,
            )}
          >
            <span className="block w-full min-w-0 truncate">{groupSuffix}</span>
          </div>
        );
      }
      return <div className={cn('flex shrink-0 items-center whitespace-nowrap', groupSuffixClassName)}>{groupSuffix}</div>;
    };

    return (
      <div className={cn('space-y-2', className)}>
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            {label}
          </label>
        )}
        <div className={cn('flex min-w-0 w-full flex-nowrap shadow-sm', groupClassName)}>
          {renderPrefix()}
          <input
            ref={ref}
            type={type}
            name={name}
            id={inputId}
            aria-invalid={error || isInvalid ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              'min-w-0 flex-1 border border-input bg-transparent text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
              isSm ? 'h-8 px-2 py-0 text-xs' : 'h-9 px-3 py-1',
              groupPrefix ? 'rounded-l-none' : 'rounded-l-md',
              groupSuffix ? 'rounded-r-none' : 'rounded-r-md',
              (error || isInvalid) && 'border-destructive focus-visible:ring-destructive',
            )}
            {...rest}
          />
          {renderSuffix()}
        </div>
        {helpText && (
          <p id={helpId} className="text-[0.8rem] text-muted-foreground">
            {helpText}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-[0.8rem] font-medium text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  },
);

InputGroup.displayName = 'InputGroup';
