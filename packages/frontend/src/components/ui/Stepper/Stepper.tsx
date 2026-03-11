import clsx from 'clsx';
import { createContext, useContext } from 'react';

const StepperContext = createContext<number>(0);

interface StepperProps {
  currentStep: number;
  children: React.ReactNode;
}

export const Stepper: React.FC<StepperProps> = ({ currentStep, children }) => {
  return <StepperContext.Provider value={currentStep}>{children}</StepperContext.Provider>;
};

interface StepTriggerProps {
  step: number;
  title: string;
  disabled?: boolean;
  /** When true, step is clickable even if step > currentStep (e.g. "skip to end" shortcut) */
  alwaysClickable?: boolean;
  onStepChange: (step: number) => void;
}

export const StepTrigger: React.FC<StepTriggerProps> = ({ step, title, disabled, alwaysClickable, onStepChange }) => {
  const currentStep = useContext(StepperContext);
  const isActive = currentStep === step;
  const isCompleted = currentStep > step;
  const isClickable = !disabled && (step <= currentStep || alwaysClickable);

  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        disabled={!isClickable}
        onClick={() => isClickable && onStepChange(step)}
        className={clsx(
          'flex items-center gap-2 text-sm font-medium transition-colors',
          isActive && 'text-primary',
          isCompleted && 'text-primary/70 cursor-pointer',
          !isActive && !isCompleted && 'text-muted-foreground/50',
          isClickable && !isActive && 'hover:text-primary',
        )}
      >
        <span
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all',
            isActive && 'bg-primary text-primary-foreground ring-2 ring-primary/30',
            isCompleted && 'bg-primary/20 text-primary',
            !isActive && !isCompleted && 'bg-muted text-muted-foreground/50',
          )}
        >
          {isCompleted ? (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} role="img" aria-label="Completed">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            step + 1
          )}
        </span>
        <span className="hidden sm:inline">{title}</span>
      </button>
    </li>
  );
};

export const StepContent: React.FC<{
  step: number;
  children: React.ReactNode;
}> = ({ step, children }) => {
  const currentStep = useContext(StepperContext);
  return currentStep === step ? <div>{children}</div> : null;
};

interface StepTriggerListProps {
  children: React.ReactNode;
}

export const StepTriggerList: React.FC<StepTriggerListProps> = ({ children }) => {
  return <ol className="flex items-center justify-center gap-4 sm:gap-6">{children}</ol>;
};
