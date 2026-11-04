import { useEffect, useState } from 'react';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

export interface LiveSessionState {
  live: boolean;
  ollamaBlocked: boolean;
  tailscaleBlocked: boolean;
}

/**
 * What the desktop app sees of a Companion OS live session. Null in a browser, while it's being
 * read, and on a desktop app too old to answer, so every caller keeps its normal behaviour then.
 */
export function useLiveSession(): LiveSessionState | null {
  const [state, setState] = useState<LiveSessionState | null>(null);

  useEffect(() => {
    let current = true;
    const invoke = getTauriInvoke();
    if (!invoke) return;
    Promise.resolve()
      .then(() => invoke('live_session_state_command'))
      .then((result) => {
        if (current && result) setState(result as LiveSessionState);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  return state;
}
