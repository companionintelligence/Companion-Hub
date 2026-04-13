import type { JSX } from 'solid-js';
import { splitProps, Show, For } from 'solid-js';
import { cn } from '@/lib/utils';

// --- Input ---
interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ['label', 'error', 'class']);
  return (
    <div>
      <Show when={local.label}>
        <label class="text-sm font-medium leading-none block mb-1.5">{local.label}</label>
      </Show>
      <input
        class={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          local.error && 'border-destructive focus-visible:ring-destructive',
          local.class,
        )}
        {...rest}
      />
      <Show when={local.error}>
        <p class="text-[0.8rem] font-medium text-destructive mt-1">{local.error}</p>
      </Show>
    </div>
  );
}

// --- Card ---
interface CardProps extends JSX.HTMLAttributes<HTMLDivElement> {}
export function Card(props: CardProps) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('rounded-xl border bg-card text-card-foreground shadow', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function CardHeader(props: CardProps) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex flex-col space-y-1.5 p-6', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function CardTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <h3 class={cn('font-semibold leading-none tracking-tight', local.class)} {...rest}>
      {local.children}
    </h3>
  );
}

export function CardContent(props: CardProps) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('p-6 pt-0', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

// --- GlassContainer ---
interface GlassContainerProps extends JSX.HTMLAttributes<HTMLDivElement> {
  intensity?: 'low' | 'medium' | 'high';
  border?: boolean;
}

const intensityClasses = {
  low: 'bg-white/5 dark:bg-black/5 backdrop-blur-sm',
  medium: 'bg-white/10 dark:bg-black/10 backdrop-blur-md',
  high: 'bg-white/20 dark:bg-black/20 backdrop-blur-lg',
};

export function GlassContainer(props: GlassContainerProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'intensity', 'border']);
  const intensity = local.intensity ?? 'medium';
  const border = local.border ?? true;
  return (
    <div
      class={cn(
        'rounded-xl transition-colors duration-200',
        intensityClasses[intensity],
        border && 'border border-white/20 dark:border-white/10',
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

// --- Skeleton ---
export function Skeleton(props: { class?: string }) {
  return <div class={cn('animate-pulse rounded-md bg-muted', props.class)} />;
}

// --- LoadingSpinner ---
export function LoadingSpinner() {
  return (
    <div class="flex justify-center items-center p-5">
      <div class="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

// --- Tabs ---
interface TabsProps {
  value: string;
  onValueChange: (v: string) => void;
  class?: string;
  children: JSX.Element;
}

export function Tabs(props: TabsProps) {
  return <div class={cn('', props.class)} data-value={props.value}>{props.children}</div>;
}

export function TabsList(props: { class?: string; children: JSX.Element }) {
  return (
    <div class={cn('inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground', props.class)}>
      {props.children}
    </div>
  );
}

interface TabsTriggerProps {
  value: string;
  active?: boolean;
  onClick?: () => void;
  class?: string;
  children: JSX.Element;
}

export function TabsTrigger(props: TabsTriggerProps) {
  return (
    <button
      type="button"
      class={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
        props.active && 'bg-background text-foreground shadow-sm',
        props.class,
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function TabsContent(props: { value: string; active?: boolean; class?: string; children: JSX.Element }) {
  return (
    <Show when={props.active}>
      <div class={cn('mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', props.class)}>
        {props.children}
      </div>
    </Show>
  );
}

// --- Alert ---
interface AlertProps extends JSX.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'danger';
}

export function Alert(props: AlertProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'variant']);
  return (
    <div
      class={cn(
        'relative w-full rounded-lg border p-4',
        local.variant === 'danger' ? 'border-destructive/50 text-destructive bg-destructive/10' : 'bg-background text-foreground',
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

// --- Dialog ---
interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: JSX.Element;
}

export function Dialog(props: DialogProps) {
  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center">
        <div class="fixed inset-0 bg-black/80" onClick={props.onClose} onKeyDown={(e) => e.key === 'Escape' && props.onClose()} role="button" tabIndex={-1} aria-label="Close dialog" />
        <div class="relative z-50 w-full max-w-lg mx-4 rounded-lg border bg-background p-6 shadow-lg">
          <Show when={props.title}>
            <h2 class="text-lg font-semibold mb-4">{props.title}</h2>
          </Show>
          {props.children}
          <button
            type="button"
            class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 cursor-pointer"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
      </div>
    </Show>
  );
}

// --- Select ---
interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Array<{ label: string; value: string }>;
}

export function Select(props: SelectProps) {
  const [local, rest] = splitProps(props, ['label', 'options', 'class']);
  return (
    <div>
      <Show when={local.label}>
        <label class="text-sm font-medium leading-none block mb-1.5">{local.label}</label>
      </Show>
      <select
        class={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          local.class,
        )}
        {...rest}
      >
        <For each={local.options}>
          {(opt) => <option value={opt.value}>{opt.label}</option>}
        </For>
      </select>
    </div>
  );
}

// --- Switch ---
interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Switch(props: SwitchProps) {
  return (
    <label class="flex items-center gap-2 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        class={cn(
          'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          props.checked ? 'bg-primary' : 'bg-input',
        )}
        onClick={() => props.onChange(!props.checked)}
      >
        <span
          class={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            props.checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
      <Show when={props.label}>
        <span class="text-sm">{props.label}</span>
      </Show>
    </label>
  );
}

// --- Table ---
interface TableProps extends JSX.HTMLAttributes<HTMLTableElement> {}
export function Table(props: TableProps) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class="relative w-full overflow-auto">
      <table class={cn('w-full caption-bottom text-sm', local.class)} {...rest}>{local.children}</table>
    </div>
  );
}
export function TableHeader(props: { children: JSX.Element }) { return <thead>{props.children}</thead>; }
export function TableBody(props: { children: JSX.Element }) { return <tbody>{props.children}</tbody>; }
export function TableRow(props: JSX.HTMLAttributes<HTMLTableRowElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return <tr class={cn('border-b transition-colors hover:bg-muted/50', local.class)} {...rest}>{local.children}</tr>;
}
export function TableHead(props: JSX.HTMLAttributes<HTMLTableCellElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return <th class={cn('h-10 px-2 text-left align-middle font-medium text-muted-foreground', local.class)} {...rest}>{local.children}</th>;
}
export function TableCell(props: JSX.HTMLAttributes<HTMLTableCellElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return <td class={cn('p-2 align-middle', local.class)} {...rest}>{local.children}</td>;
}

// --- OtpInput ---
interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  valueLength?: number;
}

export function OtpInput(props: OtpInputProps) {
  const len = props.valueLength ?? 6;
  const handleInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    const val = e.currentTarget.value.replace(/[^0-9]/g, '').slice(0, len);
    props.onChange(val);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={len}
      value={props.value}
      onInput={handleInput}
      class="flex h-12 w-full rounded-md border border-input bg-transparent px-3 py-1 text-center text-2xl tracking-[0.5em] font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      placeholder="······"
      autocomplete="one-time-code"
    />
  );
}

// --- Stepper ---
interface StepperProps {
  currentStep: number;
  children: JSX.Element;
}

export function Stepper(props: StepperProps) {
  return <div data-step={props.currentStep}>{props.children}</div>;
}

interface StepTriggerProps {
  step: number;
  title: string;
  active?: boolean;
  completed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function StepTrigger(props: StepTriggerProps) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      class={cn(
        'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer',
        props.active ? 'bg-primary text-primary-foreground' : props.completed ? 'text-primary' : 'text-muted-foreground',
        props.disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span class={cn(
        'flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold',
        props.active ? 'bg-primary-foreground text-primary' : props.completed ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
      )}>
        {props.completed ? '✓' : props.step + 1}
      </span>
      <span class="hidden sm:inline">{props.title}</span>
    </button>
  );
}

export function StepTriggerList(props: { children: JSX.Element }) {
  return <div class="flex items-center justify-center gap-1 flex-wrap">{props.children}</div>;
}

export function StepContent(props: { step: number; active?: boolean; children: JSX.Element }) {
  return <Show when={props.active}>{props.children}</Show>;
}
