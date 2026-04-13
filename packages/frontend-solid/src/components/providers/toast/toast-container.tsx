import { For } from 'solid-js';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';

export function ToastContainer() {
  return (
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <For each={toast.toasts()}>
        {(t) => (
          <div
            class={cn(
              'rounded-lg px-4 py-3 text-sm shadow-lg border animate-in slide-in-from-right',
              t.type === 'success' && 'bg-green-500/90 text-white border-green-600',
              t.type === 'error' && 'bg-red-500/90 text-white border-red-600',
              t.type === 'info' && 'bg-background text-foreground border-border',
            )}
          >
            {t.message}
          </div>
        )}
      </For>
    </div>
  );
}
