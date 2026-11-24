import fs from 'node:fs';
import { vi } from 'vitest';

/** One write as `slowDisk` sees it: where, what, and how many writes came before it. */
export interface HeldWrite {
  file: string;
  data: string;
  index: number;
}

/**
 * A disk that is slow to take the bytes, on top of the suite's memfs mock.
 *
 * Node's `fs.promises.writeFile` is two steps: an open that truncates the file, then the write. Two
 * writes to one file can both truncate it before either writes, and when the shorter one lands last,
 * the end of the longer one stays behind it. memfs does both steps at once, so this splits them again
 * and holds each write in between, for as many milliseconds as `holdMs` returns for it.
 *
 * `idle()` settles once every write started here has finished, including one that nothing awaits.
 */
export function slowDisk(holdMs: (write: HeldWrite) => number): { idle: () => Promise<void> } {
  const inFlight = new Set<Promise<void>>();
  let writes = 0;

  vi.spyOn(fs.promises, 'writeFile').mockImplementation((file, data, options) => {
    const hold = holdMs({ file: String(file), data: String(data), index: writes++ });
    const mode = options && typeof options === 'object' ? options.mode : undefined;
    const write = (async () => {
      const handle = await fs.promises.open(String(file), 'w', mode);
      try {
        await new Promise((resolve) => setTimeout(resolve, hold));
        await handle.writeFile(String(data));
      } finally {
        await handle.close();
      }
    })();
    inFlight.add(write);
    const forget = () => inFlight.delete(write);
    write.then(forget, forget);
    return write;
  });

  return {
    idle: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}
