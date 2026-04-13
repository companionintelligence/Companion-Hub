import { createSignal } from 'solid-js';

const [toasts, setToasts] = createSignal<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' }>>([]);
let nextId = 0;

function addToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, message, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, 4000);
}

export const toast = {
  success: (message: string) => addToast(message, 'success'),
  error: (message: string) => addToast(message, 'error'),
  info: (message: string) => addToast(message, 'info'),
  toasts,
};
