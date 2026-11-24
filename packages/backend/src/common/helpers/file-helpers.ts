import fs from 'node:fs';

export const pLimit = (concurrency: number) => {
  const queue: (() => Promise<void>)[] = [];
  let activeCount = 0;

  const next = () => {
    if (queue.length > 0 && activeCount < concurrency) {
      activeCount++;
      const fn = queue.shift();
      fn?.().finally(() => {
        activeCount--;
        next();
      });
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = () =>
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => next());

      queue.push(run);
      next();
    });
};

export const notEmpty = <TValue>(value: TValue | null | undefined): value is TValue => value !== null && value !== undefined;

/** Remove a file written by write-then-rename, with the `.tmp` copy a crash may have left beside it. */
export async function removeWithTemporary(file: string): Promise<void> {
  await Promise.all([fs.promises.rm(file, { force: true }), fs.promises.rm(`${file}.tmp`, { force: true })]);
}
