import { useEffect, useState } from 'react';
import { getTauriInvoke, type TauriInvoke } from '@/lib/helpers/tauri-invoke';

interface LiveSessionState {
  live: boolean;
  ollamaBlocked: boolean;
  tailscaleBlocked: boolean;
}

interface LiveSessionRead {
  state: LiveSessionState | null;
  done: Promise<void>;
}

// The answer can't change while the app runs, so a page's cards share one read, and a card that
// remounts knows at once instead of offering its install again until the answer comes back.
const reads = new WeakMap<TauriInvoke, LiveSessionRead>();

function readLiveSession(invoke: TauriInvoke): LiveSessionRead {
  const known = reads.get(invoke);
  if (known) return known;
  const read: LiveSessionRead = { state: null, done: Promise.resolve() };
  read.done = Promise.resolve()
    .then(() => invoke('live_session_state_command'))
    .then((result) => {
      if (result) read.state = result as LiveSessionState;
    })
    .catch(() => undefined);
  reads.set(invoke, read);
  return read;
}

/**
 * What the desktop app sees of a Companion OS live session. Null in a browser, while it's being
 * read, and on a desktop app too old to answer, so every caller keeps its normal behaviour then.
 */
export function useLiveSession(): LiveSessionState | null {
  const [state, setState] = useState<LiveSessionState | null>(() => {
    const invoke = getTauriInvoke();
    return invoke ? (reads.get(invoke)?.state ?? null) : null;
  });

  useEffect(() => {
    let current = true;
    const invoke = getTauriInvoke();
    if (!invoke) return;
    const read = readLiveSession(invoke);
    void read.done.then(() => {
      if (current) setState(read.state);
    });
    return () => {
      current = false;
    };
  }, []);

  return state;
}
