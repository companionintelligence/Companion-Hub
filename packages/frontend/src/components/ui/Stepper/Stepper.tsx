import { SetupStepIndicator, type SetupStepIndicatorState } from '@/components/setup/setup-step-indicator';
import { createContext, useContext, type ReactNode } from 'react';
import i18next from 'i18next';

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
  /** Optional icon above the label; defaults to step number or checkmark when completed */
  icon?: ReactNode;
}

export const StepTrigger: React.FC<StepTriggerProps> = ({ step, title, disabled, alwaysClickable, onStepChange, icon }) => {
  const currentStep = useContext(StepperContext);
  const isActive = currentStep === step;
  const isCompleted = currentStep > step;
  const isClickable = !disabled && (step <= currentStep || alwaysClickable);

  let state: SetupStepIndicatorState = 'upcoming';
  if (disabled) state = 'disabled';
  else if (isActive) state = 'active';
  else if (isCompleted) state = 'completed';

  const defaultIcon = isCompleted ? (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={3}
      role="img"
      aria-label={i18next.t('COMMON_COMPLETED', { defaultValue: 'Completed' })}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ) : (
    step + 1
  );

  return (
    <SetupStepIndicator
      label={title}
      state={state}
      icon={icon ?? defaultIcon}
      disabled={!isClickable}
      onClick={isClickable ? () => onStepChange(step) : undefined}
    />
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
  return <ol className="flex flex-wrap items-start justify-center gap-3 sm:gap-5">{children}</ol>;
};
